// One tab: a sandboxed WebContentsView plus the state the toolbar shows.
import { WebContentsView } from "electron";
import { NEW_TAB_URL } from "./config.js";
import { hostOf, siteOf } from "./privacy.js";

let nextId = 1;

/** Web pages run sandboxed, isolated from Veil's code, with our preload in every frame. @param {Electron.Session} session */
export function tabPreferences(session) {
  return {
    session,
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInSubFrames: true, // with the sandbox on, this only lets our preload run in iframes
    webviewTag: false,
    safeDialogs: true,
    spellcheck: process.platform === "darwin", // macOS uses its own spell checker; elsewhere dictionaries would be downloaded
    navigateOnDragDrop: false,
    autoplayPolicy: /** @type {const} */ ("document-user-activation-required"),
  };
}
let nextInfobarId = 1;

/** Network errors after which an upgraded http->https page falls back to the HTTPS-only warning. */
const HTTPS_FALLBACK_ERRORS = new Set([
  -100, -101, -102, -104, -106, -107, -109, -110, -111, -112, -113, -114, -116, -117, -118, -123, -125, -126, -129, -130, -134, -135, -136, -137, -141, -148, -150, -159, -164, -165, -166, -172,
  -200, -201, -202, -203, -204, -205, -206, -207, -208, -210, -211, -212, -213, -214, -215, -216, -217, -218,
]);

/**
 * @typedef {{ id: number, kind: string, text: string, origin?: string, actions: { id: string, label: string, primary?: boolean }[], data?: any }} Infobar
 */

export class Tab {
  /**
   * @param {import("./window.js").BrowserWin} win
   * @param {{ url?: string, webContents?: Electron.WebContents }} [opts]
   * `webContents` adopts one Chromium created for window.open or a target=_blank link.
   */
  constructor(win, opts = {}) {
    this.id = nextId++;
    this.win = win;
    this.browser = win.browser;
    this.private = win.private;
    this.view = opts.webContents
      ? new WebContentsView({ webContents: opts.webContents })
      : new WebContentsView({ webPreferences: tabPreferences(win.session) });
    this.view.setBackgroundColor("#ffffff");
    this.wc = this.view.webContents;
    this.title = "New Tab";
    this.favicon = "";
    this.loading = false;
    this.audible = false;
    this.crashed = false;
    /** URL shown in the address bar when the page is one of Veil's error pages. */
    this.errorFor = "";
    /** @type {Infobar[]} */
    this.infobars = [];
    this.blocked = 0;
    /** @type {Map<string, number>} hosts blocked on the current page */
    this.blockedHosts = new Map();
    this.upgraded = 0;
    this.stripped = 0;
    this.lastInput = 0;
    /** @type {{ http: string, https: string, at: number } | null} */
    this.lastUpgrade = null;
    /** @type {{ text: string, active: number, matches: number } | null} */
    this.find = null;
    this.pinned = false;
    this.#wire();
    this.browser.registerContents(this.wc, this);
    if (opts.url !== undefined) this.load(opts.url || NEW_TAB_URL);
  }

  get session() {
    return this.win.session;
  }

  get url() {
    if (this.wc.isDestroyed()) return "";
    return this.wc.getURL();
  }

  /** What the address bar shows. */
  get displayUrl() {
    const u = this.url;
    if (this.errorFor && u.startsWith("veil://error")) return this.errorFor;
    if (u === NEW_TAB_URL || u === "veil://newtab") return "";
    return u;
  }

  /** @param {string} url */
  load(url) {
    this.errorFor = "";
    this.crashed = false;
    this.wc.loadURL(url).catch(() => { /* failures are reported by did-fail-load */ });
  }

  reload(ignoreCache = false) {
    if (this.errorFor && this.url.startsWith("veil://error")) return this.load(this.errorFor);
    if (ignoreCache) this.wc.reloadIgnoringCache(); else this.wc.reload();
  }

  summary() {
    const u = this.url;
    return {
      id: this.id,
      title: this.title || this.displayUrl || "New Tab",
      url: this.displayUrl,
      favicon: this.favicon,
      loading: this.loading,
      audible: this.audible,
      muted: this.wc.isDestroyed() ? false : this.wc.audioMuted,
      blocked: this.blocked,
      secure: this.errorFor && u.startsWith("veil://error") ? "other" : u.startsWith("https://") ? "secure" : u.startsWith("http://") ? "insecure" : u.startsWith("veil://") ? "internal" : "other",
      canBack: !this.wc.isDestroyed() && this.wc.navigationHistory.canGoBack(),
      canForward: !this.wc.isDestroyed() && this.wc.navigationHistory.canGoForward(),
      infobars: this.infobars.map(({ data, ...b }) => b),
      find: this.find,
      zoom: this.wc.isDestroyed() ? 1 : Math.round(this.wc.getZoomFactor() * 100) / 100,
      pinned: this.pinned,
      crashed: this.crashed,
    };
  }

  changed() {
    this.win.tabChanged(this);
  }

  /**
   * @param {Omit<Infobar, "id">} bar
   * @param {(action: string) => void} [onAction]
   * @returns {number}
   */
  addInfobar(bar, onAction) {
    // One bar per kind and origin: a page asking twice doesn't stack prompts.
    const dup = this.infobars.find((b) => b.kind === bar.kind && b.origin === bar.origin && b.text === bar.text);
    if (dup) return dup.id;
    const id = nextInfobarId++;
    this.infobars.push({ id, ...bar, data: { onAction } });
    if (this.infobars.length > 3) this.dismissInfobar(this.infobars[0].id, "dismiss");
    this.changed();
    return id;
  }

  /** @param {number} id @param {string} action */
  dismissInfobar(id, action) {
    const i = this.infobars.findIndex((b) => b.id === id);
    if (i < 0) return;
    const [bar] = this.infobars.splice(i, 1);
    try { bar.data?.onAction?.(action); } catch (e) { console.error(e); }
    this.changed();
  }

  /** Clear bars that belong to the previous page (permission prompts are answered "no"). */
  #clearPageInfobars() {
    for (const b of [...this.infobars]) if (b.kind !== "update") this.dismissInfobar(b.id, "dismiss");
  }

  #wire() {
    const wc = this.wc;
    wc.setWindowOpenHandler((details) => this.browser.handleWindowOpen(this, details));
    wc.on("did-create-window", (child) => this.browser.setupPopup(child, this));
    wc.on("page-title-updated", (_e, title) => {
      this.title = title;
      this.browser.onTitle(this, title);
      this.changed();
    });
    wc.on("page-favicon-updated", (_e, favicons) => {
      this.browser.loadFavicon(this, favicons).catch(() => {});
    });
    wc.on("did-start-loading", () => { this.loading = true; this.changed(); });
    wc.on("did-stop-loading", () => { this.loading = false; this.changed(); });
    wc.on("did-start-navigation", (details) => {
      if (details.isMainFrame && !details.isSameDocument) {
        if (!details.url.startsWith("veil://error")) this.errorFor = "";
        // A new document is on its way: Shields counts start again. (Done here, not on commit,
        // because the new page's first requests can start before the commit is reported.)
        this.blocked = 0;
        this.blockedHosts.clear();
        this.upgraded = 0;
        this.stripped = 0;
      }
    });
    wc.on("did-navigate", (_e, url) => {
      this.favicon = "";
      this.find = null;
      if (!url.startsWith("veil://error")) this.#clearPageInfobars();
      if (url.startsWith("veil://")) this.title = this.browser.internalTitle(url);
      this.browser.onNavigated(this, url);
      this.changed();
    });
    wc.on("did-navigate-in-page", (_e, url, isMainFrame) => {
      if (isMainFrame) { this.browser.onNavigated(this, url); this.changed(); }
    });
    wc.on("did-fail-load", (_e, code, desc, validatedURL, isMainFrame) => {
      if (!isMainFrame || code === -3 /* aborted */ || code === -27 /* blocked by response, e.g. a download */) return;
      if (code === -20 /* blocked by client */ && this.browser.documentBlockPending(this, validatedURL)) return;
      const up = this.lastUpgrade;
      // Match the host, not the exact URL: the upgraded request may have been redirected or cleaned since.
      if (up && hostOf(up.https) === hostOf(validatedURL) && validatedURL.startsWith("https:") && Date.now() - up.at < 120_000 && HTTPS_FALLBACK_ERRORS.has(code)) {
        this.lastUpgrade = null;
        this.showError("https", up.http, code, desc, "", validatedURL);
      } else {
        this.showError(code <= -200 && code > -300 ? "cert" : "net", validatedURL, code, desc);
      }
    });
    wc.on("render-process-gone", (_e, details) => {
      if (details.reason === "clean-exit") return;
      this.crashed = true;
      this.loading = false;
      const url = this.displayUrl || this.url;
      this.changed();
      // Show the crash page instead of a blank view.
      setImmediate(() => { if (!wc.isDestroyed()) this.showError("crash", url, 0, details.reason); });
    });
    wc.on("found-in-page", (_e, r) => {
      if (!this.find) return;
      this.find.matches = r.matches;
      this.find.active = r.activeMatchOrdinal;
      this.changed();
    });
    wc.on("audio-state-changed", (e) => { this.audible = e.audible; this.changed(); });
    wc.on("enter-html-full-screen", () => this.win.setHtmlFullscreen(true));
    wc.on("leave-html-full-screen", () => this.win.setHtmlFullscreen(false));
    wc.on("context-menu", (_e, params) => this.browser.contextMenu(this, params));
    wc.on("before-input-event", (event, input) => {
      if (input.type === "keyDown" || input.type === "rawKeyDown") this.lastInput = Date.now();
      if (this.browser.handleShortcut(this.win, input)) event.preventDefault();
    });
    wc.on("input-event", (_e, input) => {
      if (input.type === "mouseDown" || input.type === "touchStart" || input.type === "gestureTap" || input.type === "keyDown" || input.type === "rawKeyDown") this.lastInput = Date.now();
    });
    wc.on("will-navigate", (e) => this.browser.guardNavigation(e, wc));
    wc.on("will-frame-navigate", (e) => this.browser.guardNavigation(e, wc));
    wc.on("will-redirect", (e) => this.browser.guardNavigation(e, wc));
    wc.on("will-attach-webview", (e) => e.preventDefault());
    wc.on("devtools-opened", () => this.changed());
  }

  /**
   * Replace the page with one of Veil's error pages, keeping the original URL in the address bar.
   * @param {"net" | "cert" | "https" | "crash" | "blocked"} type
   * @param {string} url @param {number} code @param {string} desc @param {string} [extra]
   * @param {string} [failedUrl] the URL whose failed attempt may sit in history
   */
  showError(type, url, code, desc, extra = "", failedUrl = url) {
    if (this.wc.isDestroyed()) return;
    const q = new URLSearchParams({ type, url, code: String(code), desc: desc || "", host: hostOf(url), extra });
    this.errorFor = url;
    this.title = hostOf(url) || "Error";
    const errorUrl = `veil://error/?${q}`;
    // Don't leave the failed attempt in history: Back should go to the page before it.
    const nav = this.wc.navigationHistory;
    const failedIndex = nav.getActiveIndex();
    this.wc.loadURL(errorUrl).then(() => {
      try {
        const entry = nav.getEntryAtIndex(failedIndex);
        if (entry && entry.url === failedUrl && failedIndex !== nav.getActiveIndex()) nav.removeEntryAtIndex(failedIndex);
      } catch { /* ignore */ }
      this.changed();
    }, () => {});
    this.changed();
  }

  /** @param {string} url @param {string} type */
  countBlocked(url, type) {
    this.blocked++;
    const h = hostOf(url);
    if (h && (this.blockedHosts.size < 500 || this.blockedHosts.has(h))) this.blockedHosts.set(h, (this.blockedHosts.get(h) || 0) + 1);
    this.changed();
  }

  /** The site whose Shields settings apply to this tab. */
  get site() {
    const u = this.displayUrl || this.url;
    return /^https?:/.test(u) ? siteOf(u) : "";
  }

  destroy() {
    this.browser.unregisterContents(this.wc);
    if (!this.wc.isDestroyed()) this.wc.close();
  }
}
