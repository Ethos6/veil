// Pure privacy helpers: URL clean-up, HTTPS upgrades, first/third-party checks, per-site seeds.
import { createHmac } from "node:crypto";
import { parse, getDomain } from "tldts";

/** Query parameters that only exist to track you across sites. */
export const TRACKING_PARAMS = new Set([
  "fbclid", "gclid", "gclsrc", "dclid", "gbraid", "wbraid", "msclkid", "yclid", "twclid", "ttclid",
  "li_fat_id", "igshid", "mc_cid", "mc_eid", "_hsenc", "_hsmi", "__hssc", "__hstc", "__hsfp", "hsctatracking",
  "mkt_tok", "oly_anon_id", "oly_enc_id", "vero_id", "vero_conv", "_openstat", "rb_clickid", "s_cid",
  "wickedid", "ml_subscriber", "ml_subscriber_hash", "epik", "ndclid", "_gl", "__s", "oft_c", "oft_ck",
  "oft_d", "oft_id", "oft_ids", "oft_k", "oft_lk", "oft_sk", "ss_email_id", "bsft_uid", "bsft_clkid",
]);

/** Parameters stripped by prefix (campaign tags such as utm_source, utm_medium…). */
const TRACKING_PREFIXES = ["utm_", "pk_", "mtm_", "hsa_"];

/** Sites where a parameter above has a real, non-tracking meaning. */
const PARAM_EXCEPTIONS = [
  // Matomo and Piwik dashboards use pk_/mtm_ for their own navigation.
  { site: /(^|\.)matomo\.(org|cloud)$/, params: /^(pk_|mtm_)/ },
];

/**
 * Remove tracking parameters from a link.
 * @param {string} url
 * @returns {string | null} the cleaned URL, or null when nothing was removed
 */
export function stripTrackingParams(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (!u.search) return null;
  const exceptions = PARAM_EXCEPTIONS.filter((e) => e.site.test(u.hostname));
  const keep = [];
  let removed = 0;
  // Work on the raw query so the parameters we keep are byte-for-byte unchanged.
  for (const part of u.search.slice(1).split("&")) {
    if (!part) continue;
    let name = part.split("=")[0];
    try { name = decodeURIComponent(name.replace(/\+/g, " ")); } catch { /* keep the raw name */ }
    const lower = name.toLowerCase();
    const tracking = TRACKING_PARAMS.has(lower) || TRACKING_PREFIXES.some((p) => lower.startsWith(p));
    if (tracking && !exceptions.some((e) => e.params.test(lower))) removed++;
    else keep.push(part);
  }
  if (!removed) return null;
  u.search = keep.length ? "?" + keep.join("&") : "";
  return u.toString();
}

/** @param {string} host */
export function isLocalHost(host) {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal") || h.endsWith(".lan") || h.endsWith(".home.arpa")) return true;
  if (!h.includes(".") && !h.includes(":")) return true; // intranet single-label names
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) {
    const [a, b] = h.split(".").map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
  }
  if (h.includes(":")) return h === "::1" || h.startsWith("fe80:") || h.startsWith("fc") || h.startsWith("fd");
  return false;
}

/**
 * HTTPS-only mode: the https:// URL to try instead of an http:// one, or null to leave it.
 * @param {string} url
 * @param {{ has(host: string): boolean }} [exceptions] hosts the user chose to visit over HTTP
 */
export function httpsUpgrade(url, exceptions) {
  let u;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== "http:") return null;
  if (isLocalHost(u.hostname)) return null;
  if (u.hostname.endsWith(".onion") || u.hostname.endsWith(".i2p")) return null;
  if (u.port && u.port !== "80") return null; // a custom port almost never speaks TLS
  if (exceptions?.has(u.hostname)) return null;
  u.protocol = "https:";
  return u.toString();
}

/**
 * The "site" (registrable domain, eTLD+1) of a URL or host: news.example.co.uk -> example.co.uk.
 * Hosts without one (IP addresses, localhost) are their own site.
 * @param {string} urlOrHost
 */
export function siteOf(urlOrHost) {
  if (!urlOrHost) return "";
  let host = urlOrHost;
  if (urlOrHost.includes("/")) {
    try { host = new URL(urlOrHost).hostname; } catch { return ""; }
  }
  host = host.replace(/^\[|\]$/g, "").toLowerCase();
  return getDomain(host, { allowPrivateDomains: true }) || host;
}

/** @param {string} url */
export function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch { return ""; }
}

/**
 * Is a request to `url` third-party relative to the page at `topUrl`?
 * @param {string} url
 * @param {string} topUrl
 */
export function isThirdParty(url, topUrl) {
  if (!topUrl || !/^https?:/.test(topUrl)) return false;
  const a = siteOf(url), b = siteOf(topUrl);
  return !!a && !!b && a !== b;
}

/**
 * A stable, unguessable seed for fingerprint randomisation: the same for every page
 * of one site during one session, different across sites and across sessions.
 * @param {string} sessionKey random per browser session
 * @param {string} site
 */
export function farbleSeed(sessionKey, site) {
  return createHmac("sha256", sessionKey).update(site || "").digest("hex").slice(0, 16);
}

/** Cheap check used by the omnibox and pages: is this http(s)? */
export function isWebUrl(url) {
  return /^https?:\/\//i.test(url);
}

/** Domain info for cosmetic filtering. */
export function hostnameAndDomain(url) {
  const p = parse(url, { allowPrivateDomains: true });
  return { hostname: p.hostname || "", domain: p.domain || p.hostname || "" };
}
