// The browser: profile data, sessions, windows, Shields and the IPC surface.
import { app, BrowserWindow, Menu, clipboard, dialog, ipcMain, nativeTheme, session, shell, webContents } from "electron";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Blocker, redirectResource } from "./blocker.js";
import {
  DEFAULT_SETTINGS, INTERNAL_SCHEME, validSetting, LISTS, LIST_UPDATE_INTERVAL_MS, MS_SAVED_PER_BLOCK, NEW_TAB_URL,
  RELEASES_API, RELEASES_PAGE, SEARCH_ENGINES, chromeUserAgent,
} from "./config.js";
import { installPipeline } from "./network.js";
import { resolveInput, searchUrl, suggest } from "./omnibox.js";
import { farbleSeed, hostOf, siteOf } from "./privacy.js";
import { registerInternalProtocol } from "./protocol.js";
import { ACTIONS, matchShortcut } from "./shortcuts.js";
import { JsonStore, addVisit, mergeSettings, normalizeHistory, setTitle } from "./store.js";
import { bookmarksToHtml, newerVersion, parseBookmarkHtml, topSites, uniquePath } from "./util.js";
import { BrowserWin } from "./window.js";

const isMac = process.platform === "darwin";

/** Permissions granted without asking (they need a user gesture or are harmless). */
const ALWAYS_ALLOW = new Set(["fullscreen", "clipboard-sanitized-write", "pointerLock", "keyboardLock", "persistent-storage", "speaker-selection", "window-placement"]);
/** Permissions Veil asks about. Everything else (geolocation, USB, HID, serial…) is refused. */
const ASKABLE = {
  media: "use your camera or microphone",
  notifications: "show notifications",
  "clipboard-read": "see text and images copied to the clipboard",
  midi: "use your MIDI devices",
  midiSysex: "control your MIDI devices",
  "idle-detection": "know when you're actively using this device",
  "storage-access": "use its cookies while embedded on other sites",
  "top-level-storage-access": "use its cookies while embedded on other sites",
  fileSystem: "edit files on your device",
};

/**
 * @typedef {{ id: string, url: string, filename: string, path: string, state: string, received: number, total: number, started: number, private: boolean, session?: Electron.Session, item?: Electron.DownloadItem }} Download
 */

export class Browser {
  /**
   * @param {{ srcDir: string, userData: string, resourcesDir: string, test?: boolean, iconPath?: string }} opts
   */
  constructor(opts) {
    this.srcDir = opts.srcDir;
    this.userData = opts.userData;
    this.resourcesDir = opts.resourcesDir;
    this.iconPath = opts.iconPath;
    this.test = !!opts.test;
    /** @type {BrowserWin[]} */
    this.windows = [];
    /** @type {BrowserWin | null} */
    this.focusedWindow = null;
    /** @type {Map<number, any>} webContents id -> Tab or popup owner */
    this.contents = new Map();
    /**
     * Choices that last only as long as a session: hosts opened over plain HTTP, pages
     * opened despite a $document rule, and (for private windows) Shields and permission
     * choices. Each private window has its own session, so nothing crosses between them.
     * @type {WeakMap<Electron.Session, { httpExceptions: Set<string>, allowedDocuments: Set<string>, sites: Map<string, any>, perms: Map<string, any> }>}
     */
    this.ephemeral = new WeakMap();
    /** @type {Map<number, { url: string, filter: string }>} */
    this.pendingDocBlocks = new Map();
    /** @type {WeakMap<Electron.Session, string>} */
    this.sessionKeys = new WeakMap();
    /** @type {Map<string, Download>} */
    this.downloads = new Map();
    this.faviconCache = new Map();
    /** Download URLs the user just approved from a prompt. */
    this.approvedDownloads = new Set();
    this.privateCount = 0;
    this.quitting = false;
    this.update = null;
    this.windowStates = [];
  }

  /* ------------------------------------------------------------------ setup */

  init() {
    const d = this.userData;
    this.settingsStore = new JsonStore(path.join(d, "settings.json"), () => DEFAULT_SETTINGS, { normalize: (v) => mergeSettings(DEFAULT_SETTINGS, v, validSetting) });
    this.historyStore = new JsonStore(path.join(d, "history.json"), () => ({ entries: [] }), { normalize: normalizeHistory, delay: 2000 });
    this.bookmarkStore = new JsonStore(path.join(d, "bookmarks.json"), () => ({ items: [] }), { normalize: (v) => ({ items: Array.isArray(v?.items) ? v.items.filter((b) => b && typeof b.url === "string") : [] }) });
    this.siteStore = new JsonStore(path.join(d, "sites.json"), () => ({ sites: {}, perms: {} }), { normalize: (v) => ({ sites: dict(v?.sites), perms: dict(v?.perms) }) });
    this.statsStore = new JsonStore(path.join(d, "stats.json"), () => ({ blocked: 0, upgraded: 0, stripped: 0, since: Date.now() }), { delay: 5000 });
    this.downloadStore = new JsonStore(path.join(d, "downloads.json"), () => ({ items: [] }), { normalize: (v) => ({ items: Array.isArray(v?.items) ? v.items.slice(0, 200) : [] }) });
    this.sessionStore = new JsonStore(path.join(d, "session.json"), () => ({ windows: [] }), { delay: 1000 });
    for (const dl of this.downloadStore.data.items) this.downloads.set(dl.id, { ...dl, state: dl.state === "progressing" ? "interrupted" : dl.state, private: false });

    nativeTheme.themeSource = /** @type {any} */ (this.settings.theme);
    nativeTheme.on("updated", () => {
      for (const w of this.windows) w.pushState();
      this.broadcastPages("theme", nativeTheme.shouldUseDarkColors ? "dark" : "light");
    });
    app.userAgentFallback = chromeUserAgent();

    // Filter lists: the most recent compiled engine on disk, then refreshed in the background.
    this.blocker = new Blocker({
      cacheFile: path.join(d, "filters", "engine.bin"),
      bundledFile: path.join(this.resourcesDir, "engine.bin"),
      fetch: (url, init) => this.netSession.fetch(url, init),
      log: (m) => this.log(m),
    });

    this.uiSession = session.fromPartition("veil-ui");
    this.netSession = session.fromPartition("veil-net"); // in memory, for list and update checks only
    this.netSession.setUserAgent("Veil");
    registerInternalProtocol(this.uiSession, this.srcDir);
    this.uiSession.setPermissionRequestHandler((_wc, _p, cb) => cb(false));
    this.uiSession.setPermissionCheckHandler(() => false);
    this.uiSession.webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, (d2, cb) => cb({ cancel: !d2.url.startsWith("veil:") && !d2.url.startsWith("data:") && !d2.url.startsWith("devtools:") }));
    this.mainSession = session.fromPartition("persist:veil");
    this.setupSession(this.mainSession, false);

    if (this.test && process.env.VEIL_TEST_FILTERS) {
      const res = process.env.VEIL_TEST_RESOURCES ? fs.readFileSync(process.env.VEIL_TEST_RESOURCES, "utf8") : undefined;
      this.blocker.loadText(fs.readFileSync(process.env.VEIL_TEST_FILTERS, "utf8"), res);
    } else this.blocker.load();
    this.#ipc();
    this.#appMenu();
    if (!this.test) this.#scheduleListUpdates();
    if (!this.test && this.settings.checkForUpdates) setTimeout(() => this.checkForUpdates(), 20_000).unref?.();
  }

  get settings() {
    return this.settingsStore.data;
  }

  log(msg) {
    if (process.env.VEIL_DEBUG || this.test) console.log(`[veil] ${msg}`);
  }

  /** @param {Electron.Session} ses */
  eph(ses) {
    let e = this.ephemeral.get(ses);
    if (!e) {
      e = { httpExceptions: new Set(), allowedDocuments: new Set(), sites: new Map(), perms: new Map() };
      this.ephemeral.set(ses, e);
    }
    return e;
  }

  /** @param {Electron.Session} ses */
  isPrivate(ses) {
    return !!ses && ses !== this.mainSession;
  }

  /** @param {Electron.Session} ses @param {boolean} isPrivate */
  setupSession(ses, isPrivate) {
    this.sessionKeys.set(ses, crypto.randomBytes(32).toString("hex"));
    const eph = this.eph(ses);
    ses.setUserAgent(chromeUserAgent(), "en-US,en");
    registerInternalProtocol(ses, this.srcDir);
    ses.protocol.handle("veil-res", (req) => {
      const r = redirectResource(this.blocker, req.url);
      if (!r) return new Response("", { status: 404 });
      return new Response(new Uint8Array(r.body), { headers: { "content-type": r.type, "access-control-allow-origin": "*", "cache-control": "no-store", "x-content-type-options": "nosniff" } });
    });
    installPipeline(ses, {
      settings: () => this.settings,
      shieldsOn: (site) => this.shieldsOn(site, ses),
      scriptsBlocked: (site) => this.siteState(site, ses).scripts === "block",
      httpExceptions: eph.httpExceptions,
      allowedDocuments: eph.allowedDocuments,
      blocker: this.blocker,
      onBlocked: (id, url, type) => this.#onBlocked(id, url, type),
      onUpgraded: (id, from, to, main) => this.#onUpgraded(id, from, to, main),
      isUpgradeLoop: (id, url) => this.#isUpgradeLoop(id, url),
      onStripped: (id) => this.#onStripped(id),
      onDocumentBlocked: (id, url, filter) => { if (id !== undefined) this.pendingDocBlocks.set(id, { url, filter }); },
    });
    ses.registerPreloadScript({ type: "frame", id: "veil-content", filePath: path.join(this.srcDir, "preload", "content.cjs") });
    ses.setPermissionRequestHandler((wc, permission, callback, details) => this.#onPermissionRequest(wc, permission, callback, details, ses));
    ses.setPermissionCheckHandler((wc, permission, origin, details) => this.#onPermissionCheck(wc, permission, origin, details, ses));
    ses.setDevicePermissionHandler(() => false);
    // Spell-check dictionaries would be downloaded from Google's servers on Windows and Linux.
    ses.setSpellCheckerDictionaryDownloadURL("https://0.0.0.0/");
    if (!isMac) ses.setSpellCheckerEnabled(false);
    ses.on("will-download", (e, item, wc) => this.#onDownload(e, item, wc, ses));
  }

  newPrivateSession() {
    const ses = session.fromPartition(`veil-private-${++this.privateCount}-${crypto.randomBytes(4).toString("hex")}`);
    this.setupSession(ses, true);
    return ses;
  }

  /* ---------------------------------------------------------------- windows */

  /** @param {{ private?: boolean, url?: string, urls?: string[], bounds?: any, maximized?: boolean }} [opts] */
  newWindow(opts = {}) {
    const ref = this.focusedWindow?.window;
    const bounds = opts.bounds || (ref && !ref.isDestroyed() ? { ...ref.getBounds(), x: ref.getBounds().x + 24, y: ref.getBounds().y + 24 } : this.windowStates[0]?.bounds);
    const win = new BrowserWin(this, { private: opts.private, urls: opts.urls, openUrl: opts.url, bounds, maximized: opts.maximized });
    this.windows.push(win);
    this.focusedWindow = win;
    return win;
  }

  /** Open a URL in a new tab of the last focused normal window (or a new window). */
  openUrl(url) {
    const win = this.windows.find((w) => w === this.focusedWindow && !w.private) || this.windows.find((w) => !w.private);
    if (win) {
      win.newTab(url);
      if (win.window.isMinimized()) win.window.restore();
      win.window.focus();
    } else this.newWindow({ url });
  }

  restoreOrNew() {
    const saved = this.settings.restoreSession ? this.sessionStore.data.windows : [];
    if (saved?.length) {
      for (const w of saved) this.newWindow({ urls: w.urls, bounds: w.bounds, maximized: w.maximized });
    } else this.newWindow();
  }

  /** @param {BrowserWin} win */
  onWindowClosing(win) {
    if (!win.private) {
      const b = win.window.getNormalBounds();
      this.windowStates = [{ bounds: b }];
      this.#saveSession(win);
    }
  }

  /** @param {BrowserWin} win */
  onWindowClosed(win) {
    this.windows = this.windows.filter((w) => w !== win);
    if (this.focusedWindow === win) this.focusedWindow = this.windows[this.windows.length - 1] || null;
    if (win.private && !this.windows.some((w) => w.session === win.session)) {
      // Everything a private window stored goes with it.
      win.session.clearStorageData().catch(() => {});
      win.session.clearCache().catch(() => {});
      this.ephemeral.delete(win.session);
      for (const [id, d] of this.downloads) if (d.session === win.session && d.state !== "progressing" && d.state !== "paused") this.downloads.delete(id);
    }
  }

  /** Remember open tabs of normal windows so they can be restored next time. */
  #saveSession(closing) {
    if (!this.settings.restoreSession || this.settings.clearOnExit) return;
    const wins = this.windows.filter((w) => !w.private && (this.quitting || w !== closing) && !w.window.isDestroyed());
    if (!this.quitting && closing && !closing.private && wins.length === 0) wins.push(closing);
    this.sessionStore.data = {
      windows: wins.map((w) => ({
        urls: w.tabs.map((t) => t.displayUrl || t.url).filter((u) => u && !u.startsWith("veil://error")).slice(0, 100),
        bounds: w.window.getNormalBounds(),
        maximized: w.window.isMaximized(),
      })).filter((w) => w.urls.length),
    };
    this.sessionStore.flush();
  }

  get #dirtyMarker() {
    return path.join(this.userData, ".clear-on-exit-pending");
  }

  /** With "clear on exit" on, leave a marker while running so an unclean exit is cleaned up next start. */
  #markDirty(on) {
    try {
      if (on) fs.writeFileSync(this.#dirtyMarker, String(Date.now()));
      else fs.rmSync(this.#dirtyMarker, { force: true });
    } catch { /* ignore */ }
  }

  /** Runs before the first window opens. */
  async prepare() {
    if (fs.existsSync(this.#dirtyMarker)) {
      // Last time Veil didn't get to clear its data (crash, power loss, OS shutdown).
      if (this.settings.clearOnExit) await this.clearData({ history: true, cookies: true, cache: true, downloads: true }).catch(() => {});
      this.#markDirty(false);
    }
    if (this.settings.clearOnExit) this.#markDirty(true);
  }

  /** The OS is logging out or shutting down (Windows): before-quit may never come. */
  onSessionEnd() {
    this.quitting = true;
    if (this.settings.restoreSession && this.windows.some((w) => !w.private)) this.#saveSession(null);
    for (const st of [this.settingsStore, this.historyStore, this.bookmarkStore, this.siteStore, this.statsStore, this.downloadStore]) {
      try { st.flush(); } catch { /* ignore */ }
    }
  }

  async beforeQuit() {
    this.quitting = true;
    // Quitting with windows open (menu, Ctrl+Shift+Q): remember them. If the last window was
    // simply closed, onWindowClosing already saved it.
    if (this.settings.restoreSession && this.windows.some((w) => !w.private)) this.#saveSession(null);
    if (this.settings.clearOnExit) {
      await this.clearData({ history: true, cookies: true, cache: true, downloads: true });
      this.sessionStore.clear();
      this.#markDirty(false);
    }
    for (const s of [this.settingsStore, this.historyStore, this.bookmarkStore, this.siteStore, this.statsStore, this.downloadStore]) {
      try { s.flush(); } catch (e) { console.error(e); }
    }
  }

  /* ------------------------------------------------------------ contents */

  /** @param {Electron.WebContents} wc @param {any} owner */
  registerContents(wc, owner) {
    const id = wc.id;
    this.contents.set(id, owner);
    try { wc.setWebRTCIPHandlingPolicy(/** @type {any} */ (this.settings.webrtc)); } catch { /* invalid value */ }
    wc.once("destroyed", () => { this.contents.delete(id); this.pendingDocBlocks.delete(id); });
  }

  /** @param {Electron.WebContents} wc */
  unregisterContents(wc) {
    if (!wc.isDestroyed()) this.contents.delete(wc.id);
  }

  /** @param {number | undefined} id */
  ownerOf(id) {
    return id === undefined ? null : this.contents.get(id) || null;
  }

  /* --------------------------------------------------------------- shields */

  /** Saved per-site settings, overlaid with in-memory ones for a private session. @param {string} site @param {Electron.Session} [ses] */
  siteState(site, ses) {
    const saved = Object.hasOwn(this.siteStore.data.sites, site) ? this.siteStore.data.sites[site] : {};
    if (this.isPrivate(ses)) return { ...saved, ...(this.eph(ses).sites.get(site) || {}) };
    return saved;
  }

  /** @param {string} site @param {Electron.Session} [ses] */
  shieldsOn(site, ses) {
    if (!site) return true;
    return this.siteState(site, ses).shields !== false;
  }

  /** @param {string} site @param {Electron.Session} ses @param {Record<string, any>} patch */
  setSiteState(site, ses, patch) {
    const isPrivate = this.isPrivate(ses);
    if (!site) return;
    const apply = (cur) => {
      const next = { ...cur, ...patch };
      for (const [k, v] of Object.entries(next)) if (v === undefined || v === null) delete next[k];
      return next;
    };
    if (isPrivate) this.eph(ses).sites.set(site, apply(this.eph(ses).sites.get(site) || {}));
    else {
      const next = apply(this.siteStore.data.sites[site] || {});
      if (Object.keys(next).length) this.siteStore.data.sites[site] = next;
      else delete this.siteStore.data.sites[site];
      this.siteStore.save();
    }
  }

  /** @param {import("./tab.js").Tab} tab */
  shieldsSummary(tab) {
    const site = tab.site;
    const state = site ? this.siteState(site, tab.session) : {};
    return {
      site,
      on: site ? this.shieldsOn(site, tab.session) : false,
      applicable: !!site,
      blocked: tab.blocked,
      upgraded: tab.upgraded,
      stripped: tab.stripped,
      scripts: state.scripts === "block",
      popups: !!state.popups,
      fingerprinting: this.settings.fingerprinting,
      cookies: this.settings.cookies,
      hosts: [...tab.blockedHosts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 50),
    };
  }

  #onBlocked(id, url, type) {
    this.statsStore.data.blocked++;
    this.statsStore.save();
    const owner = this.ownerOf(id);
    owner?.countBlocked?.(url, type);
  }

  #onUpgraded(id, from, to, main) {
    this.statsStore.data.upgraded++;
    this.statsStore.save();
    const owner = this.ownerOf(id);
    if (!owner) return;
    if (main) {
      const prev = owner.lastUpgrade;
      owner.lastUpgrade = { http: from, https: to, at: Date.now(), count: prev && prev.http === from ? (prev.count || 1) + 1 : 1 };
    }
    if (typeof owner.upgraded === "number") { owner.upgraded++; owner.changed?.(); }
  }

  #isUpgradeLoop(id, url) {
    const owner = this.ownerOf(id);
    const lu = owner?.lastUpgrade;
    if (!lu || lu.http !== url || Date.now() - lu.at > 5000) return false;
    // The https page sent us straight back to http: the site doesn't really support HTTPS.
    owner.lastUpgrade = null;
    setImmediate(() => { if (!owner.wc?.isDestroyed?.()) owner.showError?.("https", url, -310, "ERR_TOO_MANY_REDIRECTS"); });
    return true;
  }

  #onStripped(id) {
    this.statsStore.data.stripped++;
    this.statsStore.save();
    const owner = this.ownerOf(id);
    if (owner && typeof owner.stripped === "number") { owner.stripped++; owner.changed?.(); }
  }

  /** Called by a tab whose main-frame load failed with ERR_BLOCKED_BY_CLIENT. */
  documentBlockPending(tab, url) {
    const p = this.pendingDocBlocks.get(tab.wc.id);
    if (!p || p.url !== url) return false;
    this.pendingDocBlocks.delete(tab.wc.id);
    tab.showError("blocked", url, -20, "ERR_BLOCKED_BY_CLIENT", p.filter);
    return true;
  }

  /* ----------------------------------------------------------- tab events */

  /** @param {import("./tab.js").Tab} tab @param {string} url */
  onNavigated(tab, url) {
    if (tab.private || !/^https?:/.test(url)) return;
    addVisit(this.historyStore.data, url, tab.wc.getTitle() === url ? "" : tab.wc.getTitle());
    this.historyStore.save();
  }

  /** @param {import("./tab.js").Tab} tab @param {string} title */
  onTitle(tab, title) {
    if (tab.private) return;
    const url = tab.url;
    if (!/^https?:/.test(url)) return;
    setTitle(this.historyStore.data, url, title);
    this.historyStore.save();
  }

  internalTitle(url) {
    const host = hostOf(url);
    return { newtab: "New Tab", settings: "Settings", history: "History", bookmarks: "Bookmarks", downloads: "Downloads", about: "About Veil", error: "Error" }[host] || "Veil";
  }

  /**
   * Fetch the page's icon through the tab's own session (so Shields apply) and keep it as a data: URL.
   * @param {import("./tab.js").Tab} tab @param {string[]} favicons
   */
  async loadFavicon(tab, favicons) {
    const url = favicons.find((f) => /^(https?|data):/.test(f));
    if (!url) return;
    const pageUrl = tab.url;
    if (this.faviconCache.has(url)) {
      tab.favicon = this.faviconCache.get(url);
      return tab.changed();
    }
    let data = "";
    if (url.startsWith("data:image/")) data = url.length < 200_000 ? url : "";
    else {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      try {
        const res = await tab.wc.session.fetch(url, { signal: ctrl.signal, credentials: "omit", referrerPolicy: "no-referrer" });
        const type = (res.headers.get("content-type") || "").split(";")[0].trim();
        if (res.ok && /^image\/(png|x-icon|vnd\.microsoft\.icon|gif|jpeg|webp|svg\+xml|avif)$/.test(type)) {
          const buf = Buffer.from(await res.arrayBuffer());
          if (buf.length < 150_000) data = `data:${type};base64,${buf.toString("base64")}`;
        }
      } catch { /* no icon */ } finally { clearTimeout(timer); }
    }
    if (!data) return;
    if (this.faviconCache.size > 300) this.faviconCache.delete(this.faviconCache.keys().next().value);
    if (!tab.private) this.faviconCache.set(url, data);
    if (tab.wc.isDestroyed() || tab.url !== pageUrl) return;
    tab.favicon = data;
    tab.changed();
  }

  /**
   * Stop web pages from opening Veil's internal pages.
   * @param {Electron.Event & { url: string, frame?: Electron.WebFrameMain | null, isMainFrame?: boolean }} e
   * @param {Electron.WebContents} wc
   */
  guardNavigation(e, wc) {
    const target = e.url || "";
    if (!target.toLowerCase().startsWith(INTERNAL_SCHEME + ":")) return;
    let from = "";
    try { from = e.frame ? (e.frame.parent ? e.frame.parent.url : e.frame.url) : wc.getURL(); } catch { from = wc.getURL(); }
    const fromInternal = from.startsWith(INTERNAL_SCHEME + ":") && (!e.frame || !e.frame.parent);
    if (fromInternal) return;
    // A page's own Back link may return to a Veil page that is already in this tab's history.
    const isMain = !e.frame || !e.frame.parent;
    let inHistory = false;
    try { inHistory = isMain && wc.navigationHistory.getAllEntries().some((x) => x.url === target); } catch { /* ignore */ }
    if (!inHistory) e.preventDefault();
  }

  /**
   * window.open and target=_blank links, from a tab or a pop-up window.
   * @param {any} tab
   * @param {Electron.HandlerDetails} details
   * @returns {Electron.WindowOpenHandlerResponse}
   */
  handleWindowOpen(tab, details) {
    const { url, disposition, features } = details;
    const win = tab.win;
    const fromInternal = tab.url.startsWith("veil:");
    if (/^veil:/i.test(url) && !fromInternal) return { action: "deny" };
    if (!/^(https?:|about:blank|veil:)/i.test(url)) return { action: "deny" };
    if (win.window.isDestroyed()) return { action: "deny" };
    const site = tab.site;
    const gesture = Date.now() - (tab.lastInput || 0) < 1500;
    if (this.settings.blockPopups && !gesture && site && this.shieldsOn(site, tab.session) && !this.siteState(site, tab.session).popups) {
      tab.addInfobar?.({
        kind: "popup",
        origin: site,
        text: `Pop-up blocked: ${hostOf(url) || url}`,
        actions: [{ id: "open", label: "Open it" }, { id: "always", label: `Always allow on ${site}` }],
      }, (action) => {
        if (action === "open" || action === "always") win.newTab(url, { index: indexAfter(win, tab) });
        if (action === "always") this.setSiteState(site, tab.session, { popups: true });
      });
      return { action: "deny" };
    }
    // A page that opens several windows from one click gets one; the gesture is used up.
    tab.lastInput = 0;
    if (disposition === "new-window" && features) {
      // A real pop-up (sign-in, payment): its own small window, window.opener kept.
      return {
        action: "allow",
        overrideBrowserWindowOptions: {
          autoHideMenuBar: true,
          backgroundColor: "#ffffff",
          icon: this.iconPath,
          webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: true, webviewTag: false, safeDialogs: true },
        },
      };
    }
    // Everything else becomes a tab. Chromium creates it, so POST forms keep their body
    // and window.open() returns a real window the page can use.
    return {
      action: "allow",
      outlivesOpener: true,
      createWindow: (options) => {
        const t = win.newTab(undefined, { webContents: /** @type {any} */ (options).webContents, webPreferences: options.webPreferences, background: disposition === "background-tab", index: indexAfter(win, tab) });
        return t.wc;
      },
    };
  }

  /**
   * A pop-up window opened by a page.
   * @param {Electron.BrowserWindow} child @param {{ private: boolean, win: BrowserWin }} tab the tab (or pop-up) that opened it
   */
  setupPopup(child, tab) {
    const wc = child.webContents;
    const owner = {
      private: tab.private,
      win: tab.win,
      session: wc.session,
      wc,
      lastInput: 0,
      lastUpgrade: null,
      countBlocked: () => {},
      showError: () => {},
      get url() { return wc.isDestroyed() ? "" : wc.getURL(); },
      get site() { return wc.isDestroyed() ? "" : siteOf(wc.getURL()); },
    };
    this.registerContents(wc, owner);
    const setTitle = () => {
      if (child.isDestroyed()) return;
      const u = wc.getURL();
      let origin = u;
      try { origin = new URL(u).host || u; } catch { /* keep */ }
      // Always show where a pop-up really is: it has no address bar.
      child.setTitle(`${origin} – ${wc.getTitle() || ""}`);
    };
    child.on("page-title-updated", (e) => { e.preventDefault(); setTitle(); });
    wc.on("did-navigate", setTitle);
    wc.on("did-navigate-in-page", setTitle);
    wc.on("will-navigate", (e) => this.guardNavigation(e, wc));
    wc.on("will-frame-navigate", (e) => this.guardNavigation(e, wc));
    wc.on("will-redirect", (e) => this.guardNavigation(e, wc));
    wc.on("input-event", (_e, input) => {
      if (["mouseDown", "touchStart", "gestureTap", "keyDown", "rawKeyDown"].includes(input.type)) owner.lastInput = Date.now();
    });
    wc.on("before-input-event", (event, input) => {
      if (input.type !== "keyDown") return;
      const a = !isMac && matchShortcut(input);
      if (a && a.id === "closeTab") { event.preventDefault(); child.close(); }
      if (a && a.id === "devtools") { event.preventDefault(); wc.openDevTools({ mode: "detach" }); }
    });
    wc.on("context-menu", (_e, params) => this.contextMenu(null, params, wc, owner.win));
    // Pop-ups follow the same pop-up rules as tabs, judged by their own clicks.
    wc.setWindowOpenHandler((d) => this.handleWindowOpen(owner, d));
    wc.on("did-create-window", (child2) => this.setupPopup(child2, owner));
    setTitle();
  }

  /* ------------------------------------------------------------- history */

  isBookmarked(url) {
    return !!url && this.bookmarkStore.data.items.some((b) => b.url === url);
  }

  toggleBookmark(tab) {
    const url = tab.displayUrl;
    if (!url || url.startsWith("veil:")) return false;
    const items = this.bookmarkStore.data.items;
    const i = items.findIndex((b) => b.url === url);
    if (i >= 0) items.splice(i, 1);
    else items.unshift({ id: crypto.randomUUID(), url, title: tab.title || url, added: Date.now() });
    this.bookmarkStore.save();
    for (const w of this.windows) w.pushState();
    this.broadcastPages("bookmarks", null);
    return i < 0;
  }

  /* ------------------------------------------------------------ downloads */

  /** @param {Electron.Event} event @param {Electron.DownloadItem} item @param {Electron.WebContents} wc @param {Electron.Session} ses */
  #onDownload(event, item, wc, ses) {
    const owner = this.ownerOf(wc?.id);
    const fromPage = owner && wc && !wc.isDestroyed() && /^https?:/.test(wc.getURL());
    const url = item.getURL();
    if (fromPage && Date.now() - (owner.lastInput || 0) > 5000 && !this.approvedDownloads.delete(url)) {
      // A page started a download on its own (no click or key press): ask first.
      event.preventDefault();
      const name = item.getFilename();
      if (!owner.addInfobar || /^(data|blob):/.test(url)) return;
      owner.addInfobar({
        kind: "download",
        origin: hostOf(wc.getURL()),
        text: `${hostOf(wc.getURL()) || "This page"} wants to download ${name}.`,
        actions: [{ id: "allow", label: "Download", primary: true }, { id: "block", label: "Block" }],
      }, (a) => {
        if (a !== "allow" || wc.isDestroyed()) return;
        this.approvedDownloads.add(url);
        wc.downloadURL(url);
      });
      return;
    }
    const id = crypto.randomUUID();
    if (!this.settings.askWhereToSave) {
      const dir = this.settings.downloadDir && fs.existsSync(this.settings.downloadDir) ? this.settings.downloadDir : app.getPath("downloads");
      // Downloads still in flight have no file yet: reserve their names too.
      const taken = new Set([...this.downloads.values()].filter((d) => d.item).map((d) => d.path));
      item.setSavePath(uniquePath(dir, item.getFilename(), taken));
    }
    /** @type {Download} */
    const dl = { id, url: item.getURL(), filename: path.basename(item.getSavePath() || "") || item.getFilename(), path: item.getSavePath(), state: "progressing", received: 0, total: item.getTotalBytes(), started: Date.now(), private: this.isPrivate(ses), session: ses, item };
    this.downloads.set(id, dl);
    let last = 0;
    item.on("updated", (_e, state) => {
      dl.state = state === "interrupted" ? "interrupted" : item.isPaused() ? "paused" : "progressing";
      dl.received = item.getReceivedBytes();
      dl.total = item.getTotalBytes();
      dl.path = item.getSavePath() || dl.path;
      dl.filename = path.basename(dl.path) || dl.filename;
      const now = Date.now();
      if (now - last > 250) { last = now; this.#downloadsChanged(); }
    });
    item.once("done", (_e, state) => {
      dl.state = state; // completed | cancelled | interrupted
      dl.received = item.getReceivedBytes();
      dl.path = item.getSavePath() || dl.path;
      dl.filename = path.basename(dl.path) || dl.filename;
      delete dl.item;
      this.#downloadsChanged(true);
      if (state === "completed" && isMac) app.dock?.downloadFinished(dl.path);
    });
    this.#downloadsChanged(true);
    if (dl.state === "progressing") owner?.win?.sendUi?.("download-started", { filename: dl.filename });
  }

  #downloadsChanged(persist = false) {
    if (persist) {
      this.downloadStore.data.items = [...this.downloads.values()].filter((d) => !d.private).map(publicDownload).slice(-200);
      this.downloadStore.save();
    }
    for (const w of this.windows) w.pushState();
    for (const [id] of this.contents) {
      const wc = webContents.fromId(id);
      if (wc && !wc.isDestroyed() && wc.getURL().startsWith("veil://downloads")) wc.send("veil:page-event", "downloads", this.listDownloads(wc.session));
    }
  }

  /** Downloads a window may see: a private window sees only its own, a normal one never sees private ones. @param {Electron.Session} ses */
  #visibleDownloads(ses) {
    const priv = this.isPrivate(ses);
    return [...this.downloads.values()].filter((d) => (priv ? d.session === ses : !d.private));
  }

  /** @param {Electron.Session} ses */
  listDownloads(ses) {
    return this.#visibleDownloads(ses).map((d) => ({ ...publicDownload(d), exists: d.state === "completed" ? fs.existsSync(d.path) : undefined })).reverse();
  }

  /** @param {Electron.Session} ses */
  downloadsSummary(ses) {
    const list = this.#visibleDownloads(ses);
    const active = list.filter((d) => d.state === "progressing" || d.state === "paused");
    const received = active.reduce((a, d) => a + d.received, 0);
    const total = active.reduce((a, d) => a + (d.total || 0), 0);
    return { active: active.length, progress: total ? received / total : null, recent: list.slice(-5).reverse().map(publicDownload) };
  }

  /** @param {string} id @param {string} action @param {Electron.Session} ses */
  downloadAction(id, action, ses) {
    const dl = this.downloads.get(id);
    if (!dl || !this.#visibleDownloads(ses).includes(dl)) return false;
    switch (action) {
      case "open": if (dl.state === "completed") shell.openPath(dl.path); break;
      case "show": shell.showItemInFolder(dl.path); break;
      case "cancel": dl.item?.cancel(); break;
      case "pause": if (!dl.item || dl.state !== "progressing") return false; dl.item.pause(); dl.state = "paused"; break;
      case "resume": if (!dl.item?.canResume()) return false; dl.item.resume(); break;
      case "remove": if (dl.state !== "progressing" && dl.state !== "paused") this.downloads.delete(id); break;
      default: return false;
    }
    this.#downloadsChanged(true);
    return true;
  }

  /* ---------------------------------------------------------- permissions */

  #permKey(permission, details) {
    if (permission === "media") {
      const types = details?.mediaTypes || [];
      const out = [];
      if (types.includes("video")) out.push("camera");
      if (types.includes("audio")) out.push("microphone");
      return out.length ? out : ["camera", "microphone"];
    }
    return [permission];
  }

  /** @param {string} origin @param {string} name @param {Electron.Session} ses */
  getPerm(origin, name, ses) {
    const saved = Object.hasOwn(this.siteStore.data.perms, origin) ? this.siteStore.data.perms[origin] : undefined;
    if (this.isPrivate(ses)) {
      const p = this.eph(ses).perms.get(origin)?.[name];
      if (p) return p;
      // Private windows inherit blocks, never grants.
      return saved?.[name] === "block" ? "block" : undefined;
    }
    return saved && Object.hasOwn(saved, name) ? saved[name] : undefined;
  }

  setPerm(origin, name, value, ses) {
    if (this.isPrivate(ses)) {
      const perms = this.eph(ses).perms;
      const cur = perms.get(origin) || {};
      cur[name] = value;
      perms.set(origin, cur);
      return;
    }
    const perms = this.siteStore.data.perms;
    perms[origin] = { ...(perms[origin] || {}), [name]: value };
    this.siteStore.save();
  }

  #onPermissionRequest(wc, permission, callback, details, ses) {
    if (ALWAYS_ALLOW.has(permission)) return callback(true);
    let origin = "";
    try { origin = new URL(details.requestingUrl || wc.getURL()).origin; } catch { /* none */ }
    const owner = this.ownerOf(wc.id);
    if (permission === "openExternal") {
      const ext = details.externalURL || "";
      let scheme = "";
      try { scheme = new URL(ext).protocol.replace(":", ""); } catch { return callback(false); }
      if (!owner?.addInfobar || !/^(mailto|tel|sms|magnet|zoommtg|msteams|slack|spotify|steam|webcal|itms-apps|skype|facetime|whatsapp|tg|signal)$/.test(scheme)) return callback(false);
      owner.addInfobar({ kind: "external", origin, text: `${hostOf(origin) || "This page"} wants to open ${ext.length > 80 ? ext.slice(0, 79) + "…" : ext} in another app.`, actions: [{ id: "allow", label: "Open app", primary: true }, { id: "block", label: "Cancel" }] }, (a) => callback(a === "allow"));
      return;
    }
    if (!Object.hasOwn(ASKABLE, permission) || !origin.startsWith("https://") && !/^http:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(origin)) return callback(false);
    const names = this.#permKey(permission, details);
    const states = names.map((n) => this.getPerm(origin, n, ses));
    if (states.some((s) => s === "block")) return callback(false);
    if (states.every((s) => s === "allow")) return callback(true);
    if (!owner?.addInfobar) return callback(false);
    const what = permission === "media"
      ? `use your ${names.join(" and ")}`
      : ASKABLE[/** @type {keyof typeof ASKABLE} */ (permission)];
    owner.addInfobar({
      kind: "permission",
      origin,
      text: `${hostOf(origin)} wants to ${what}.`,
      actions: [{ id: "allow", label: "Allow", primary: true }, { id: "block", label: "Block" }],
    }, (action) => {
      if (action === "allow" || action === "block") for (const n of names) this.setPerm(origin, n, action, ses);
      callback(action === "allow");
    });
  }

  #onPermissionCheck(_wc, permission, origin, details, ses) {
    if (ALWAYS_ALLOW.has(permission)) return true;
    if (!origin) return false;
    let o = origin;
    try { o = new URL(origin).origin; } catch { return false; }
    if (permission === "media") {
      const name = details?.mediaType === "video" ? "camera" : details?.mediaType === "audio" ? "microphone" : null;
      if (!name) return false;
      return this.getPerm(o, name, ses) === "allow";
    }
    if (!Object.hasOwn(ASKABLE, permission)) return false;
    return this.getPerm(o, permission, ses) === "allow";
  }

  /* ------------------------------------------------------- data clean-up */

  /** @param {{ history?: boolean, cookies?: boolean, cache?: boolean, downloads?: boolean, sites?: boolean, since?: number }} what */
  async clearData(what) {
    const since = what.since || 0;
    if (what.history) {
      if (since) this.historyStore.data.entries = this.historyStore.data.entries.filter((e) => e.last < since);
      else this.historyStore.data.entries = [];
      this.historyStore.flush();
      for (const w of this.windows) w.closed = [];
    }
    if (what.downloads) {
      for (const [id, d] of this.downloads) if (!d.private && d.state !== "progressing" && d.state !== "paused") this.downloads.delete(id);
      this.#downloadsChanged(true);
    }
    if (what.cookies) await this.mainSession.clearStorageData();
    if (what.cache) {
      await this.mainSession.clearCache();
      this.faviconCache.clear();
    }
    if (what.sites) {
      this.siteStore.data = { sites: dict(null), perms: dict(null) };
      this.siteStore.flush();
    }
    this.broadcastPages("history", null);
    return true;
  }

  /* ------------------------------------------------------------- updates */

  #scheduleListUpdates() {
    const run = async () => {
      if (!this.settings.autoUpdateLists && !this.blocker.empty) return;
      const age = Date.now() - (this.blocker.info?.updated || 0);
      if (age < LIST_UPDATE_INTERVAL_MS && !this.blocker.empty) return;
      const info = await this.blocker.update(this.settings.lists);
      if (info) this.broadcastPages("lists", this.listsInfo());
    };
    setTimeout(run, this.blocker.empty ? 0 : 15_000).unref?.();
    setInterval(run, 60 * 60 * 1000).unref?.();
  }

  listsInfo() {
    const info = this.blocker.info;
    return {
      updated: info?.updated || 0,
      networkFilters: info?.networkFilters || 0,
      cosmeticFilters: info?.cosmeticFilters || 0,
      resources: !!info?.resources,
      updating: !!this.blocker.updating,
      lists: LISTS.map((l) => ({
        id: l.id, name: l.name, group: l.group, home: l.home,
        on: this.settings.lists[l.id] ?? l.on,
        result: info?.lists?.find((r) => r.id === l.id) || null,
      })),
    };
  }

  async checkForUpdates(manual = false) {
    try {
      const res = await this.netSession.fetch(RELEASES_API, { headers: { accept: "application/vnd.github+json" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const latest = String(json.tag_name || "").replace(/^v/, "");
      const newer = newerVersion(latest, app.getVersion());
      this.update = newer ? { version: latest, url: RELEASES_PAGE } : null;
      if (this.update) for (const w of this.windows) w.sendUi("update", this.update);
      return { ok: true, latest, newer, current: app.getVersion() };
    } catch (e) {
      if (manual) return { ok: false, error: /** @type {Error} */ (e).message, current: app.getVersion() };
      return null;
    } finally {
      if (!manual && this.settings.checkForUpdates) setTimeout(() => this.checkForUpdates(), 24 * 3600_000).unref?.();
    }
  }

  /* --------------------------------------------------------------- actions */

  /** @param {BrowserWin | null} win @param {string} id @param {any} [arg] */
  runAction(win, id, arg) {
    const tab = win?.active || null;
    switch (id) {
      case "newTab": return win ? win.newTab() : this.newWindow();
      case "newWindow": return this.newWindow();
      case "privateWindow": return this.newWindow({ private: true });
      case "reopenTab": return win?.reopenClosed();
      case "closeTab": return tab && win?.closeTab(tab);
      case "closeWindow": return win?.window.close();
      case "focusAddress": return win?.focusAddressBar();
      case "reload": return tab?.reload();
      case "hardReload": return tab?.reload(true);
      case "stop": return tab?.wc.stop();
      case "back": return tab?.wc.navigationHistory.canGoBack() && tab.wc.navigationHistory.goBack();
      case "forward": return tab?.wc.navigationHistory.canGoForward() && tab.wc.navigationHistory.goForward();
      case "home": return tab?.load(NEW_TAB_URL);
      case "nextTab":
      case "prevTab": {
        if (!win || !tab || win.tabs.length < 2) return;
        const i = win.tabs.indexOf(tab);
        const n = win.tabs.length;
        return win.activate(win.tabs[(i + (id === "nextTab" ? 1 : n - 1)) % n]);
      }
      case "selectTab": return win?.tabs[arg] && win.activate(win.tabs[arg]);
      case "lastTab": return win?.tabs.length && win.activate(win.tabs[win.tabs.length - 1]);
      case "find": return win?.sendUi("find-open", null);
      case "findNext":
      case "findPrev":
        if (tab?.find?.text) tab.wc.findInPage(tab.find.text, { forward: id === "findNext", findNext: false });
        else win?.sendUi("find-open", null);
        return;
      case "zoomIn":
      case "zoomOut":
      case "zoomReset": {
        if (!tab) return;
        const steps = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];
        const cur = tab.wc.getZoomFactor();
        let next = 1;
        if (id === "zoomIn") next = steps.find((s) => s > cur + 0.001) || 5;
        if (id === "zoomOut") next = [...steps].reverse().find((s) => s < cur - 0.001) || 0.25;
        tab.wc.setZoomFactor(next);
        return tab.changed();
      }
      case "bookmark": return tab && this.toggleBookmark(tab);
      case "history": return this.#openInternal(win, "veil://history/");
      case "bookmarks": return this.#openInternal(win, "veil://bookmarks/");
      case "downloads": return this.#openInternal(win, "veil://downloads/");
      case "settings": return this.#openInternal(win, "veil://settings/");
      case "about": return this.#openInternal(win, "veil://about/");
      case "print": return tab?.wc.print({}, () => {});
      case "viewSource": {
        const u = tab?.url;
        if (u && /^https?:/.test(u) && win) win.newTab("view-source:" + u, { index: win.tabs.indexOf(tab) + 1 });
        return;
      }
      case "devtools":
        if (!tab) return;
        if (tab.wc.isDevToolsOpened()) tab.wc.closeDevTools();
        else tab.wc.openDevTools({ mode: "detach" });
        return;
      case "fullscreen": return win && win.window.setFullScreen(!win.window.isFullScreen());
      case "quit": return app.quit();
      default: return undefined;
    }
  }

  /** Open an internal page, reusing the current tab if it's a new tab page. */
  #openInternal(win, url) {
    if (!win) return this.newWindow({ url });
    const existing = win.tabs.find((t) => t.url.startsWith(url));
    if (existing) return win.activate(existing);
    const tab = win.active;
    if (tab && (tab.url === "" || tab.url.startsWith("veil://newtab"))) tab.load(url);
    else win.newTab(url, { index: tab ? win.tabs.indexOf(tab) + 1 : undefined });
  }

  /** @param {BrowserWin} win @param {any} input @returns {boolean} handled */
  handleShortcut(win, input) {
    if (isMac) return false; // the application menu handles shortcuts on macOS
    const a = matchShortcut(input);
    if (!a) return false;
    this.runAction(win, a.id, a.arg);
    return true;
  }

  #appMenu() {
    if (!isMac) {
      Menu.setApplicationMenu(null);
      return;
    }
    const run = (id, arg) => () => this.runAction(this.focusedWindow && !this.focusedWindow.window.isDestroyed() ? this.focusedWindow : null, id, arg);
    const item = (id, extra = {}) => {
      const a = ACTIONS.find((x) => x.id === id && (extra.arg === undefined || x.arg === extra.arg));
      return { label: a?.label || id, accelerator: a?.mac || undefined, click: run(id, extra.arg), ...extra };
    };
    /** @type {Electron.MenuItemConstructorOptions[]} */
    const template = [
      { label: "Veil", submenu: [item("about", { label: "About Veil" }), { type: "separator" }, item("settings"), { type: "separator" }, { role: "services" }, { type: "separator" }, { role: "hide" }, { role: "hideOthers" }, { role: "unhide" }, { type: "separator" }, { role: "quit", label: "Quit Veil" }] },
      { label: "File", submenu: [item("newTab"), item("newWindow"), item("privateWindow"), item("reopenTab"), item("focusAddress"), { type: "separator" }, item("closeTab"), item("closeWindow"), { type: "separator" }, item("print")] },
      { role: "editMenu" },
      { label: "View", submenu: [item("reload"), item("hardReload"), { type: "separator" }, item("zoomReset"), item("zoomIn"), item("zoomOut"), { type: "separator" }, item("find"), item("findNext"), item("findPrev"), { type: "separator" }, item("fullscreen"), item("viewSource"), item("devtools")] },
      { label: "History", submenu: [item("back"), item("forward"), item("home"), { type: "separator" }, item("history")] },
      { label: "Bookmarks", submenu: [item("bookmark"), item("bookmarks")] },
      { label: "Window", submenu: [{ role: "minimize" }, { role: "zoom" }, { type: "separator" }, item("nextTab"), item("prevTab"), ...[0, 1, 2, 3, 4, 5, 6, 7].map((n) => item("selectTab", { arg: n, visible: false })), item("lastTab", { visible: false }), item("downloads"), { type: "separator" }, { role: "front" }] },
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  }

  /**
   * Right-click menu for pages.
   * @param {import("./tab.js").Tab | null} tab @param {Electron.ContextMenuParams} p @param {Electron.WebContents} [wcOverride] @param {BrowserWin} [winOverride]
   */
  contextMenu(tab, p, wcOverride, winOverride) {
    const wc = wcOverride || tab?.wc;
    if (!wc || wc.isDestroyed()) return;
    const win = tab?.win || winOverride || null;
    /** @type {Electron.MenuItemConstructorOptions[]} */
    const items = [];
    const sep = () => { if (items.length && items[items.length - 1].type !== "separator") items.push({ type: "separator" }); };
    const web = (u) => /^https?:/i.test(u);
    if (p.misspelledWord && p.dictionarySuggestions?.length) {
      for (const s of p.dictionarySuggestions.slice(0, 5)) items.push({ label: s, click: () => wc.replaceMisspelling(s) });
      items.push({ label: "Add to dictionary", click: () => wc.session.addWordToSpellCheckerDictionary(p.misspelledWord) });
      sep();
    }
    if (p.linkURL && web(p.linkURL)) {
      if (win) items.push({ label: "Open link in new tab", click: () => win.newTab(p.linkURL, { background: true, index: tab ? win.tabs.indexOf(tab) + 1 : undefined }) });
      items.push({ label: "Open link in new window", click: () => this.newWindow({ private: win?.private, url: p.linkURL }) });
      if (!win?.private) items.push({ label: "Open link in private window", click: () => this.newWindow({ private: true, url: p.linkURL }) });
      items.push({ label: "Copy link address", click: () => clipboard.writeText(p.linkURL) });
      sep();
    }
    if (p.mediaType === "image" && p.srcURL) {
      if (win && web(p.srcURL)) items.push({ label: "Open image in new tab", click: () => win.newTab(p.srcURL, { background: true }) });
      items.push({ label: "Save image as…", click: () => wc.downloadURL(p.srcURL) });
      items.push({ label: "Copy image", click: () => wc.copyImageAt(p.x, p.y) });
      if (web(p.srcURL)) items.push({ label: "Copy image address", click: () => clipboard.writeText(p.srcURL) });
      sep();
    }
    if ((p.mediaType === "video" || p.mediaType === "audio") && p.srcURL && web(p.srcURL)) {
      items.push({ label: `Save ${p.mediaType} as…`, click: () => wc.downloadURL(p.srcURL) });
      items.push({ label: `Copy ${p.mediaType} address`, click: () => clipboard.writeText(p.srcURL) });
      sep();
    }
    if (p.isEditable) {
      items.push({ role: "undo", enabled: p.editFlags.canUndo }, { role: "redo", enabled: p.editFlags.canRedo }, { type: "separator" });
      items.push({ role: "cut", enabled: p.editFlags.canCut }, { role: "copy", enabled: p.editFlags.canCopy }, { role: "paste", enabled: p.editFlags.canPaste }, { role: "pasteAndMatchStyle", enabled: p.editFlags.canPaste }, { role: "selectAll" });
      sep();
    } else if (p.selectionText?.trim()) {
      items.push({ role: "copy" });
      const text = p.selectionText.trim().replace(/\s+/g, " ");
      const engine = SEARCH_ENGINES[this.settings.searchEngine] || SEARCH_ENGINES.duckduckgo;
      const short = text.length > 28 ? text.slice(0, 27) + "…" : text;
      if (win) items.push({ label: `Search ${engine.name} for “${short}”`, click: () => win.newTab(searchUrl(text, this.settings.searchEngine), { index: tab ? win.tabs.indexOf(tab) + 1 : undefined }) });
      sep();
    }
    if (!p.linkURL && !p.isEditable && !p.selectionText && p.mediaType === "none" && tab) {
      items.push({ label: "Back", enabled: wc.navigationHistory.canGoBack(), click: () => wc.navigationHistory.goBack() });
      items.push({ label: "Forward", enabled: wc.navigationHistory.canGoForward(), click: () => wc.navigationHistory.goForward() });
      items.push({ label: "Reload", click: () => tab.reload() });
      sep();
      items.push({ label: "Print…", click: () => wc.print({}, () => {}) });
      if (/^https?:/.test(wc.getURL())) items.push({ label: "View page source", click: () => this.runAction(win, "viewSource") });
      sep();
    }
    items.push({ label: "Inspect", click: () => { wc.inspectElement(p.x, p.y); if (wc.isDevToolsOpened()) wc.devToolsWebContents?.focus(); } });
    // The page may be gone by the time an item is picked.
    for (const it of items) if (it.click) { const f = it.click; it.click = (...a) => { if (!wc.isDestroyed()) /** @type {any} */ (f)(...a); }; }
    const menu = Menu.buildFromTemplate(items);
    const host = win && !win.window.isDestroyed() ? win.window : BrowserWindow.fromWebContents(wc);
    menu.popup(host ? { window: /** @type {any} */ (host) } : {});
  }

  /* -------------------------------------------------------------- broadcast */

  /** Tell every open veil:// page about a change. */
  broadcastPages(name, data) {
    for (const [id] of this.contents) {
      const wc = webContents.fromId(id);
      if (wc && !wc.isDestroyed() && wc.getURL().startsWith("veil://")) wc.send("veil:page-event", name, data);
    }
  }

  /* ------------------------------------------------------------------- ipc */

  #ipc() {
    // Preload asks, before the page runs, what protection a frame gets.
    ipcMain.on("veil:frame-init", (event, href) => {
      try {
        event.returnValue = this.#frameConfig(event, String(href || ""));
      } catch (e) {
        console.error("veil: frame-init", e);
        event.returnValue = null;
      }
    });

    ipcMain.handle("veil:cosmetics", (event, msg) => {
      const frame = event.senderFrame;
      if (!frame || !msg || typeof msg !== "object") return "";
      const frameUrl = frame.url;
      if (!/^https?:/.test(frameUrl)) return "";
      let top = frameUrl;
      try { top = frame.top?.url || frameUrl; } catch { /* keep */ }
      if (!this.shieldsOn(siteOf(top), event.sender.session) || !this.settings.blockAds) return "";
      const arr = (v) => Array.isArray(v) ? v.filter((x) => typeof x === "string" && x.length < 300).slice(0, 5000) : [];
      return this.blocker.cosmetics({ url: frameUrl, first: false, classes: arr(msg.classes), ids: arr(msg.ids), hrefs: arr(msg.hrefs) }).styles;
    });

    ipcMain.handle("veil:ui", async (event, method, ...args) => {
      const win = this.windows.find((w) => w.ui.webContents === event.sender);
      if (!win) throw new Error("not allowed");
      return this.#uiCall(win, method, args);
    });

    ipcMain.handle("veil:page", async (event, method, ...args) => {
      const frame = event.senderFrame;
      if (!frame || frame.parent || !frame.url.startsWith("veil://")) throw new Error("not allowed");
      const owner = this.ownerOf(event.sender.id);
      if (!owner) throw new Error("not allowed");
      return this.#pageCall(owner, frame.url, method, args);
    });
  }

  #frameConfig(event, href) {
    const frame = event.senderFrame;
    if (!frame || !/^https?:/.test(href)) return null;
    let top = href;
    try { top = frame.top?.url || href; } catch { /* keep */ }
    if (!/^https?:/.test(top)) top = href;
    const ses = event.sender.session;
    const site = siteOf(top);
    const s = this.settings;
    const shields = this.shieldsOn(site, ses);
    const cosmetic = shields && s.blockAds;
    const first = cosmetic ? this.blocker.cosmetics({ url: href, first: true }) : { styles: "", scripts: [] };
    // Cross-site cookies are blocked by Chromium itself; "all" also stops first-party script cookies.
    const blockCookies = shields && s.cookies === "all";
    return {
      shields,
      gpc: s.gpc,
      farble: shields && s.fingerprinting,
      seed: farbleSeed(this.sessionKeys.get(ses) || "veil", site),
      blockCookies,
      cosmetic,
      styles: first.styles,
      scripts: first.scripts,
    };
  }

  /** @param {BrowserWin} win @param {string} method @param {any[]} args */
  async #uiCall(win, method, args) {
    const tab = win.active;
    const byId = (id) => win.tabById(Number(id));
    switch (method) {
      case "newTab": return void win.newTab(typeof args[0] === "string" ? resolveInput(args[0], this.settings.searchEngine).url : undefined);
      case "closeTab": { const t = byId(args[0]); if (t) win.closeTab(t); return; }
      case "activate": { const t = byId(args[0]); if (t) win.activate(t); return; }
      case "moveTab": { const t = byId(args[0]); if (t) win.moveTab(t, Number(args[1])); return; }
      case "navigate": {
        if (!tab) return;
        const { url } = resolveInput(String(args[0] || ""), this.settings.searchEngine);
        if (/^view-source:/i.test(url) && !/^view-source:https?:/i.test(url)) return;
        tab.load(url);
        tab.wc.focus();
        return;
      }
      case "suggest": {
        const text = String(args[0] || "").slice(0, 500);
        const list = win.private ? suggest(text, [], this.bookmarkStore.data.items) : suggest(text, this.historyStore.data.entries, this.bookmarkStore.data.items);
        const resolved = resolveInput(text, this.settings.searchEngine);
        const engine = SEARCH_ENGINES[this.settings.searchEngine] || SEARCH_ENGINES.duckduckgo;
        return { input: resolved, engine: engine.name, items: list };
      }
      case "action": return void this.runAction(win, String(args[0]), args[1]);
      case "setOverlay": return void win.setOverlay(!!args[0]);
      case "setChromeHeight": return void win.setChromeHeight(Number(args[0]) || 0);
      case "focusPage": return void tab?.wc.focus();
      case "find": {
        if (!tab) return;
        const text = String(args[0] || "");
        if (!text) { tab.wc.stopFindInPage("clearSelection"); tab.find = { text: "", active: 0, matches: 0 }; tab.changed(); return; }
        const next = !!tab.find && tab.find.text === text;
        tab.find = { text, active: tab.find?.active || 0, matches: tab.find?.matches || 0 };
        // Electron's findNext means "start a new search session": true for new text, false to step through matches.
        tab.wc.findInPage(text, { forward: args[1] !== false, findNext: !next });
        return;
      }
      case "findStop": {
        if (!tab) return;
        tab.wc.stopFindInPage("keepSelection");
        tab.find = null;
        tab.changed();
        tab.wc.focus();
        return;
      }
      case "toggleShields": {
        if (!tab?.site) return;
        const on = this.shieldsOn(tab.site, tab.session);
        this.setSiteState(tab.site, tab.session, { shields: on ? false : undefined });
        tab.reload();
        return;
      }
      case "setScripts": {
        if (!tab?.site) return;
        this.setSiteState(tab.site, tab.session, { scripts: args[0] ? "block" : undefined });
        tab.reload();
        return;
      }
      case "infobar": {
        const t = byId(args[0]);
        t?.dismissInfobar(Number(args[1]), String(args[2]));
        return;
      }
      case "muteTab": { const t = byId(args[0]); if (t) { t.wc.setAudioMuted(!t.wc.audioMuted); t.changed(); } return; }
      case "tabMenu": {
        const t = byId(args[0]);
        if (!t) return;
        const menu = Menu.buildFromTemplate([
          { label: "New tab to the right", click: () => win.newTab(undefined, { index: win.tabs.indexOf(t) + 1 }) },
          { type: "separator" },
          { label: "Reload", click: () => t.reload() },
          { label: "Duplicate", click: () => win.newTab(t.displayUrl || NEW_TAB_URL, { index: win.tabs.indexOf(t) + 1 }) },
          { label: t.wc.audioMuted ? "Unmute site" : "Mute tab", click: () => { t.wc.setAudioMuted(!t.wc.audioMuted); t.changed(); } },
          { type: "separator" },
          { label: "Close tab", click: () => win.closeTab(t) },
          { label: "Close other tabs", enabled: win.tabs.length > 1, click: () => { for (const o of [...win.tabs]) if (o !== t) win.closeTab(o); } },
          { label: "Close tabs to the right", enabled: win.tabs.indexOf(t) < win.tabs.length - 1, click: () => { for (const o of win.tabs.slice(win.tabs.indexOf(t) + 1)) win.closeTab(o); } },
          { type: "separator" },
          { label: "Reopen closed tab", enabled: win.closed.length > 0, click: () => win.reopenClosed() },
        ]);
        menu.popup({ window: /** @type {any} */ (win.window) });
        return;
      }
      case "downloadAction": return this.downloadAction(String(args[0]), String(args[1]), win.session);
      case "update": return this.update;
      default: throw new Error(`unknown method ${method}`);
    }
  }

  /** @param {any} owner @param {string} pageUrl @param {string} method @param {any[]} args */
  async #pageCall(owner, pageUrl, method, args) {
    const page = hostOf(pageUrl);
    const isPrivate = !!owner.private;
    switch (method) {
      case "settings.get":
        return {
          settings: this.settings,
          engines: Object.entries(SEARCH_ENGINES).map(([id, e]) => ({ id, name: e.name })),
          lists: this.listsInfo(),
          versions: this.#versions(),
          downloadDir: this.settings.downloadDir || app.getPath("downloads"),
        };
      case "settings.set": {
        const [key, value] = args;
        if (!Object.hasOwn(DEFAULT_SETTINGS, key) || key === "lists") throw new Error("unknown setting");
        if (!validSetting(key, value)) throw new Error("invalid value");
        if (key === "downloadDir" && value && !fs.existsSync(value)) throw new Error("folder not found");
        /** @type {any} */ (this.settings)[key] = value;
        this.settingsStore.save();
        if (key === "theme") {
          nativeTheme.themeSource = value;
          for (const w of this.windows) w.pushState();
          this.broadcastPages("theme", nativeTheme.shouldUseDarkColors ? "dark" : "light");
        }
        if (key === "clearOnExit") this.#markDirty(value);
        if (key === "webrtc") for (const id of this.contents.keys()) { try { webContents.fromId(id)?.setWebRTCIPHandlingPolicy(value); } catch { /* gone */ } }
        if (key === "checkForUpdates" && value) this.checkForUpdates();
        for (const w of this.windows) w.pushState();
        return this.settings;
      }
      case "lists.set": {
        const [id, on] = args;
        if (!LISTS.some((l) => l.id === id) || typeof on !== "boolean") throw new Error("unknown list");
        this.settings.lists = { ...this.settings.lists, [id]: on };
        this.settingsStore.save();
        return this.listsInfo();
      }
      case "lists.update": {
        const p = this.blocker.update(this.settings.lists);
        this.broadcastPages("lists", this.listsInfo());
        const info = await p;
        const out = this.listsInfo();
        this.broadcastPages("lists", out);
        return { ok: !!info, ...out };
      }
      case "chooseDownloadDir": {
        const win = owner.win?.window;
        const r = await dialog.showOpenDialog(win, { properties: ["openDirectory", "createDirectory"] });
        if (r.canceled || !r.filePaths[0]) return null;
        this.settings.downloadDir = r.filePaths[0];
        this.settingsStore.save();
        return r.filePaths[0];
      }
      case "checkForUpdates": return this.checkForUpdates(true);
      case "stats.get": {
        const st = this.statsStore.data;
        const top = isPrivate ? [] : topSites(this.historyStore.data.entries, 8);
        return {
          blocked: st.blocked, upgraded: st.upgraded, stripped: st.stripped, since: st.since,
          msSaved: st.blocked * MS_SAVED_PER_BLOCK,
          top,
          private: isPrivate,
          engine: (SEARCH_ENGINES[this.settings.searchEngine] || SEARCH_ENGINES.duckduckgo).name,
          lists: { networkFilters: this.blocker.info?.networkFilters || 0, updated: this.blocker.info?.updated || 0 },
        };
      }
      case "search": {
        const { url } = resolveInput(String(args[0] || ""), this.settings.searchEngine);
        owner.load?.(url);
        return;
      }
      case "history.list": {
        if (page !== "history") throw new Error("not allowed");
        const q = String(args[0] || "").toLowerCase();
        const offset = Math.max(0, Number(args[1]) || 0);
        const all = q ? this.historyStore.data.entries.filter((e) => e.url.toLowerCase().includes(q) || e.title.toLowerCase().includes(q)) : this.historyStore.data.entries;
        return { total: all.length, items: all.slice(offset, offset + 200) };
      }
      case "history.delete": {
        const urls = new Set([].concat(args[0]).map(String));
        this.historyStore.data.entries = this.historyStore.data.entries.filter((e) => !urls.has(e.url));
        this.historyStore.save();
        return true;
      }
      case "data.clear": {
        if (page !== "settings" && page !== "history") throw new Error("not allowed");
        const what = args[0] && typeof args[0] === "object" ? args[0] : {};
        return this.clearData({ history: !!what.history, cookies: !!what.cookies, cache: !!what.cache, downloads: !!what.downloads, sites: !!what.sites, since: Number(what.since) || 0 });
      }
      case "bookmarks.list": return this.bookmarkStore.data.items;
      case "bookmarks.add": {
        const url = String(args[0] || "");
        if (!/^(https?|file):/.test(url) || this.isBookmarked(url)) return false;
        this.bookmarkStore.data.items.unshift({ id: crypto.randomUUID(), url, title: String(args[1] || url).slice(0, 500), added: Date.now() });
        this.bookmarkStore.save();
        for (const w of this.windows) w.pushState();
        return true;
      }
      case "bookmarks.update": {
        const b = this.bookmarkStore.data.items.find((x) => x.id === args[0]);
        if (!b) return false;
        const patch = args[1] || {};
        if (typeof patch.title === "string") b.title = patch.title.slice(0, 500);
        if (typeof patch.url === "string" && /^(https?|file):/.test(patch.url)) b.url = patch.url;
        this.bookmarkStore.save();
        for (const w of this.windows) w.pushState();
        return true;
      }
      case "bookmarks.remove": {
        this.bookmarkStore.data.items = this.bookmarkStore.data.items.filter((x) => x.id !== args[0]);
        this.bookmarkStore.save();
        for (const w of this.windows) w.pushState();
        return true;
      }
      case "bookmarks.import": {
        // Netscape bookmark HTML (what every browser exports).
        const win = owner.win?.window;
        const r = await dialog.showOpenDialog(win, { properties: ["openFile"], filters: [{ name: "Bookmarks", extensions: ["html", "htm"] }] });
        if (r.canceled || !r.filePaths[0]) return 0;
        const html = fs.readFileSync(r.filePaths[0], "utf8").slice(0, 20_000_000);
        const found = parseBookmarkHtml(html);
        let n = 0;
        for (const b of found) {
          if (this.isBookmarked(b.url)) continue;
          this.bookmarkStore.data.items.push({ id: crypto.randomUUID(), url: b.url, title: b.title, added: Date.now() });
          n++;
        }
        this.bookmarkStore.save();
        return n;
      }
      case "bookmarks.export": {
        const win = owner.win?.window;
        const r = await dialog.showSaveDialog(win, { defaultPath: "veil-bookmarks.html" });
        if (r.canceled || !r.filePath) return false;
        fs.writeFileSync(r.filePath, bookmarksToHtml(this.bookmarkStore.data.items));
        return true;
      }
      case "downloads.list": return this.listDownloads(owner.session);
      case "downloads.action": return this.downloadAction(String(args[0]), String(args[1]), owner.session);
      case "downloads.clear": {
        const priv = this.isPrivate(owner.session);
        for (const [id, d] of this.downloads) if ((priv ? d.session === owner.session : !d.private) && d.state !== "progressing" && d.state !== "paused") this.downloads.delete(id);
        this.#downloadsChanged(true);
        return true;
      }
      case "sites.list": {
        if (page !== "settings") throw new Error("not allowed");
        return { sites: this.siteStore.data.sites, perms: this.siteStore.data.perms };
      }
      case "sites.reset": {
        if (page !== "settings") throw new Error("not allowed");
        const key = String(args[0] || "");
        delete this.siteStore.data.sites[key];
        delete this.siteStore.data.perms[key];
        this.siteStore.save();
        return true;
      }
      case "perm.set": {
        if (page !== "settings") throw new Error("not allowed");
        const [origin, name, value] = args.map(String);
        if (!["allow", "block", "ask"].includes(value)) throw new Error("bad value");
        const cur = { ...(this.siteStore.data.perms[origin] || {}) };
        if (value === "ask") delete cur[name]; else cur[name] = value;
        if (Object.keys(cur).length) this.siteStore.data.perms[origin] = cur; else delete this.siteStore.data.perms[origin];
        this.siteStore.save();
        return true;
      }
      case "allowHttp": {
        if (page !== "error") throw new Error("not allowed");
        const url = String(args[0] || "");
        if (!url.startsWith("http://")) return false;
        this.eph(owner.session).httpExceptions.add(hostOf(url));
        owner.load?.(url);
        return true;
      }
      case "allowDocument": {
        if (page !== "error") throw new Error("not allowed");
        const url = String(args[0] || "");
        if (!/^https?:/.test(url)) return false;
        this.eph(owner.session).allowedDocuments.add(url);
        owner.load?.(url);
        return true;
      }
      case "goBack": {
        const wc = owner.wc;
        if (wc?.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
        else owner.load?.(NEW_TAB_URL);
        return true;
      }
      case "retry": {
        if (owner.errorFor) owner.load(owner.errorFor);
        return true;
      }
      case "about": return { versions: this.#versions(), lists: this.listsInfo() };
      case "theme": return nativeTheme.shouldUseDarkColors ? "dark" : "light";
      case "openExternal": {
        const url = String(args[0] || "");
        if (!/^https:\/\//.test(url)) return false;
        this.openUrl(url);
        return true;
      }
      default: throw new Error(`unknown method ${method}`);
    }
  }

  #versions() {
    return {
      veil: app.getVersion(),
      chromium: process.versions.chrome,
      electron: process.versions.electron,
      v8: process.versions.v8,
      platform: `${process.platform} ${process.arch}`,
      userAgent: chromeUserAgent(),
      profile: this.userData,
    };
  }
}


/** A download without its live item and session, safe to save or send to a page. */
function publicDownload(d) {
  const { item, session: _s, ...rest } = d;
  return { ...rest, resumable: !!item && item.canResume() && rest.state !== "progressing" };
}

/** A plain lookup object with no prototype, so keys like "__proto__" are just keys. */
function dict(v) {
  const out = Object.create(null);
  if (v && typeof v === "object" && !Array.isArray(v)) for (const [k, val] of Object.entries(v)) if (val && typeof val === "object") out[k] = val;
  return out;
}

/** Insert position for a tab opened from `opener`: right after it, or at the end. */
function indexAfter(win, opener) {
  const i = win.tabs.indexOf(opener);
  return i >= 0 ? i + 1 : win.tabs.length;
}
