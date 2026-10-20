// Everything that happens to a request: HTTPS upgrades, tracking-parameter removal,
// ad and tracker blocking, Global Privacy Control, third-party cookie blocking and
// $csp filters. Electron allows one listener per webRequest event, so this is the
// single pipeline for each session.
import { httpsUpgrade, siteOf, stripTrackingParams } from "./privacy.js";

/**
 * What the pipeline needs from the browser.
 * @typedef {{
 *   settings: () => typeof import("./config.js").DEFAULT_SETTINGS,
 *   shieldsOn: (site: string) => boolean,
 *   scriptsBlocked: (site: string) => boolean,
 *   httpExceptions: Set<string>,
 *   blocker: import("./blocker.js").Blocker,
 *   onBlocked: (webContentsId: number | undefined, url: string, type: string) => void,
 *   onUpgraded: (webContentsId: number | undefined, from: string, to: string, mainFrame: boolean) => void,
 *   isUpgradeLoop: (webContentsId: number | undefined, httpUrl: string) => boolean,
 *   onStripped: (webContentsId: number | undefined) => void,
 *   onDocumentBlocked: (webContentsId: number | undefined, url: string, filter: string) => void,
 *   allowedDocuments: Set<string>,
 * }} PipelineHost
 */

/** Find the URL of the top-level page a request belongs to. */
export function topUrlOf(details) {
  if (details.resourceType === "mainFrame") return details.url;
  try {
    const top = details.frame?.top?.url;
    if (top) return top;
  } catch { /* frame already gone */ }
  try {
    const wc = details.webContents;
    if (wc && !wc.isDestroyed()) return wc.getURL();
  } catch { /* ignore */ }
  return details.referrer || "";
}

/** The URL of the frame that made the request (the "source" for filter matching). */
function frameUrlOf(details, topUrl) {
  if (details.resourceType === "mainFrame") return "";
  if (details.resourceType === "subFrame") {
    try { return details.frame?.parent?.url || topUrl; } catch { return topUrl; }
  }
  try { return details.frame?.url || topUrl; } catch { return topUrl; }
}

/** Delete a header whatever its capitalisation. @param {Record<string, any>} headers @param {string} name */
function deleteHeader(headers, name) {
  let found = false;
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === name) { delete headers[k]; found = true; }
  }
  return found;
}

/**
 * Pure decision for onBeforeRequest, testable without Electron.
 * @param {{ url: string, method?: string, resourceType: string, webContentsId?: number }} d
 * @param {string} topUrl
 * @param {string} sourceUrl
 * @param {PipelineHost} host
 * @returns {{ cancel?: boolean, redirectURL?: string }}
 */
export function decideRequest(d, topUrl, sourceUrl, host) {
  const url = d.url;
  if (/^veil(-res)?:/i.test(url)) {
    // Veil's own pages and files: only Veil's pages may load them. Web pages can't embed
    // or fetch them (that would also tell every site it's being viewed in Veil).
    // Top-level navigations are checked separately (guardNavigation).
    if (d.resourceType === "mainFrame") return {};
    if (/^veil-res:/i.test(url)) {
      // Redirect targets carry a random per-run token; anything else gets no answer at all.
      let token = "";
      try { token = new URL(url).hostname; } catch { /* invalid */ }
      return token && token === host.blocker.token ? {} : { cancel: true };
    }
    return /^veil:/i.test(sourceUrl || "") ? {} : { cancel: true };
  }
  if (!/^(https?|wss?):/.test(url)) return {};
  const s = host.settings();
  const navigation = d.resourceType === "mainFrame" || d.resourceType === "subFrame";
  const site = siteOf(topUrl);

  if (navigation) {
    // Shields are judged by the site being opened for a top-level navigation.
    const navSite = d.resourceType === "mainFrame" ? siteOf(url) : site;
    if (!host.shieldsOn(navSite)) return {};
    if (s.httpsOnly) {
      const up = httpsUpgrade(url, host.httpExceptions);
      if (up) {
        // A site that redirects https back to http would loop forever; stop and explain instead.
        if (host.isUpgradeLoop(d.webContentsId, url)) {
          return d.resourceType === "mainFrame" ? { cancel: true } : {};
        }
        host.onUpgraded(d.webContentsId, url, up, d.resourceType === "mainFrame");
        return { redirectURL: up };
      }
    }
    if (s.stripTrackingParams && (d.method || "GET") === "GET") {
      const clean = stripTrackingParams(url);
      if (clean) {
        host.onStripped(d.webContentsId);
        return { redirectURL: clean };
      }
    }
    if (d.resourceType === "mainFrame") {
      // Known scam and malware pages ($document rules from the badware list).
      if (s.blockAds && !host.allowedDocuments.has(url)) {
        const r = host.blocker.matchDocument(url);
        if (r.block) {
          host.onDocumentBlocked(d.webContentsId, url, r.filter || "");
          return { cancel: true };
        }
      }
      return {};
    }
  }

  if (!host.shieldsOn(site)) return {};
  if (d.resourceType === "script" && host.scriptsBlocked(site)) {
    host.onBlocked(d.webContentsId, url, d.resourceType);
    return { cancel: true };
  }
  if (!s.blockAds) return {};
  const r = host.blocker.match({ url, type: d.resourceType, sourceUrl: sourceUrl || topUrl });
  if (!r.block) return {};
  host.onBlocked(d.webContentsId, url, d.resourceType);
  return r.redirect ? { redirectURL: r.redirect } : { cancel: true };
}

/**
 * Should Veil strip cookies from this request / response? Cross-site cookies are already
 * blocked inside Chromium (see main.js), which also lets the Storage Access API work; this
 * handles "Block all cookies".
 * @param {string} _url @param {string} topUrl @param {PipelineHost} host
 */
export function blockCookiesFor(_url, topUrl, host) {
  if (host.settings().cookies !== "all") return false;
  const site = siteOf(topUrl);
  return !site || host.shieldsOn(site);
}

/**
 * Install the pipeline on a session.
 * @param {Electron.Session} ses
 * @param {PipelineHost} host
 */
export function installPipeline(ses, host) {
  const filter = { urls: ["<all_urls>"] };

  ses.webRequest.onBeforeRequest(filter, (details, callback) => {
    try {
      const topUrl = topUrlOf(details);
      callback(decideRequest(details, topUrl, frameUrlOf(details, topUrl), host));
    } catch (e) {
      console.error("veil: request pipeline error", e);
      callback({});
    }
  });

  ses.webRequest.onBeforeSendHeaders(filter, (details, callback) => {
    try {
      const headers = details.requestHeaders;
      if (!/^(https?|wss?):/.test(details.url)) return callback({});
      const s = host.settings();
      if (s.gpc) headers["Sec-GPC"] = "1";
      const topUrl = topUrlOf(details);
      if (blockCookiesFor(details.url, topUrl, host)) deleteHeader(headers, "cookie");
      callback({ requestHeaders: headers });
    } catch (e) {
      console.error("veil: header pipeline error", e);
      callback({});
    }
  });

  ses.webRequest.onHeadersReceived(filter, (details, callback) => {
    try {
      if (!/^(https?|wss?):/.test(details.url)) return callback({});
      const headers = details.responseHeaders || {};
      let changed = false;
      const topUrl = topUrlOf(details);
      const isDoc = details.resourceType === "mainFrame" || details.resourceType === "subFrame";
      if (blockCookiesFor(details.url, topUrl, host)) changed = deleteHeader(headers, "set-cookie") || changed;
      if (isDoc) {
        const site = siteOf(details.resourceType === "mainFrame" ? details.url : topUrl);
        const policies = [];
        if (host.shieldsOn(site) && host.settings().blockAds) {
          const csp = host.blocker.csp({ url: details.url, type: details.resourceType, sourceUrl: details.resourceType === "mainFrame" ? "" : topUrl });
          if (csp) policies.push(csp);
        }
        if (host.shieldsOn(site) && host.scriptsBlocked(site)) policies.push("script-src 'none'");
        if (policies.length) {
          // A separate header: browsers enforce every CSP header, so this only ever tightens the page's own policy.
          const existing = Object.keys(headers).find((k) => k.toLowerCase() === "content-security-policy");
          const list = existing ? [].concat(headers[existing]) : [];
          if (existing) delete headers[existing];
          headers["Content-Security-Policy"] = [...list, ...policies];
          changed = true;
        }
      }
      callback(changed ? { responseHeaders: headers } : {});
    } catch (e) {
      console.error("veil: response pipeline error", e);
      callback({});
    }
  });
}
