// A browser window: the toolbar view on top, the active tab's view below it.
import { BaseWindow, WebContentsView, nativeTheme } from "electron";
import path from "node:path";
import { Tab } from "./tab.js";
import { NEW_TAB_URL } from "./config.js";

/** Height of the tab strip plus toolbar, in CSS pixels. The toolbar can ask for more (find bar, infobars). */
export const CHROME_HEIGHT = 82;

export class BrowserWin {
  /**
   * @param {import("./browser.js").Browser} browser
   * @param {{ private?: boolean, bounds?: Electron.Rectangle, maximized?: boolean, urls?: string[], openUrl?: string | null }} [opts]
   */
  constructor(browser, opts = {}) {
    this.browser = browser;
    this.private = !!opts.private;
    this.session = this.private ? browser.newPrivateSession() : browser.mainSession;
    const b = opts.bounds;
    this.window = new BaseWindow({
      width: b?.width || 1280,
      height: b?.height || 860,
      x: b?.x, y: b?.y,
      minWidth: 420,
      minHeight: 300,
      title: this.private ? "Veil – Private" : "Veil",
      backgroundColor: this.private ? "#1b1530" : nativeTheme.shouldUseDarkColors ? "#1d1f24" : "#f3f4f6",
      icon: browser.iconPath,
      show: false,
      autoHideMenuBar: true,
    });
    if (opts.maximized) this.window.maximize();
    /** @type {Tab[]} */
    this.tabs = [];
    /** @type {Tab | null} */
    this.active = null;
    this.chromeHeight = CHROME_HEIGHT;
    this.overlay = false;
    this.htmlFullscreen = false;
    /** @type {{ url: string, entries?: any[], index?: number }[]} */
    this.closed = [];
    this.ui = new WebContentsView({
      webPreferences: {
        session: browser.uiSession,
        preload: path.join(browser.srcDir, "preload", "ui.cjs"),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        spellcheck: false,
      },
    });
    this.ui.setBackgroundColor("#00000000");
    this.ui.webContents.on("before-input-event", (event, input) => {
      if (this.browser.handleShortcut(this, input)) event.preventDefault();
    });
    this.ui.webContents.on("will-navigate", (e) => e.preventDefault());
    this.ui.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    this.ui.webContents.on("did-finish-load", () => {
      this.pushState(true);
      const a = this.active;
      if (a && (!a.url || a.url.startsWith("veil://newtab"))) this.focusAddressBar();
    });
    this.ui.webContents.loadURL(`veil://ui/?private=${this.private ? 1 : 0}`);
    this.window.contentView.addChildView(this.ui);
    this.window.on("resize", () => this.layout());
    this.window.on("enter-full-screen", () => this.layout());
    this.window.on("leave-full-screen", () => this.layout());
    this.window.on("focus", () => this.browser.focusedWindow = this);
    this.window.on("close", () => this.browser.onWindowClosing(this));
    this.window.on("session-end", () => this.browser.onSessionEnd()); // Windows logout/shutdown
    this.window.on("closed", () => this.#destroy());
    this.stateTimer = null;
    const urls = opts.urls?.length ? opts.urls : [opts.openUrl || NEW_TAB_URL];
    for (const u of urls) this.newTab(u, { background: false });
    if (this.tabs.length) this.activate(this.tabs[0]);
    this.window.show();
    this.layout();
  }

  /** @param {string} [url] @param {{ background?: boolean, index?: number, webContents?: Electron.WebContents, webPreferences?: any }} [opts] */
  newTab(url = NEW_TAB_URL, opts = {}) {
    const tab = new Tab(this, opts.webContents ? { webContents: opts.webContents } : { url });
    const index = opts.index ?? this.tabs.length;
    this.tabs.splice(Math.max(0, Math.min(index, this.tabs.length)), 0, tab);
    this.window.contentView.addChildView(tab.view);
    tab.view.setVisible(false);
    this.window.contentView.addChildView(this.ui); // keep the toolbar on top
    if (!opts.background || !this.active) this.activate(tab);
    else this.pushState();
    return tab;
  }

  /** @param {Tab} tab */
  activate(tab) {
    if (!this.tabs.includes(tab)) return;
    if (this.active && this.active !== tab) {
      this.active.view.setVisible(false);
      if (this.active.find) { this.active.wc.stopFindInPage("keepSelection"); this.active.find = null; }
    }
    this.active = tab;
    tab.view.setVisible(true);
    this.layout();
    if (!tab.url || tab.url.startsWith("veil://newtab")) this.focusAddressBar();
    else tab.wc.focus();
    this.pushState();
  }

  /** @param {Tab} tab */
  closeTab(tab) {
    const i = this.tabs.indexOf(tab);
    if (i < 0) return;
    if (!this.private && tab.url && !tab.url.startsWith("veil://newtab")) {
      try {
        const nav = tab.wc.navigationHistory;
        this.closed.push({ url: tab.url, entries: nav.getAllEntries(), index: nav.getActiveIndex() });
      } catch {
        this.closed.push({ url: tab.url });
      }
      if (this.closed.length > 25) this.closed.shift();
    }
    this.tabs.splice(i, 1);
    this.window.contentView.removeChildView(tab.view);
    tab.destroy();
    if (!this.tabs.length) {
      this.window.close();
      return;
    }
    if (this.active === tab) this.activate(this.tabs[Math.min(i, this.tabs.length - 1)]);
    else this.pushState();
  }

  reopenClosed() {
    const last = this.closed.pop();
    if (!last) return;
    const tab = this.newTab(undefined, {});
    if (last.entries?.length) {
      tab.wc.navigationHistory.restore({ entries: last.entries, index: last.index ?? last.entries.length - 1 }).catch(() => tab.load(last.url));
    } else tab.load(last.url);
  }

  /** @param {Tab} tab @param {number} index */
  moveTab(tab, index) {
    const i = this.tabs.indexOf(tab);
    if (i < 0) return;
    this.tabs.splice(i, 1);
    this.tabs.splice(Math.max(0, Math.min(index, this.tabs.length)), 0, tab);
    this.pushState();
  }

  /** @param {boolean} on */
  setHtmlFullscreen(on) {
    this.htmlFullscreen = on;
    if (on) this.window.setFullScreen(true);
    else if (this.window.isFullScreen()) this.window.setFullScreen(false);
    this.layout();
  }

  /** @param {number} h */
  setChromeHeight(h) {
    const v = Math.max(CHROME_HEIGHT, Math.min(400, Math.round(h)));
    if (v === this.chromeHeight) return;
    this.chromeHeight = v;
    this.layout();
  }

  /** While a menu or panel is open the toolbar covers the window (its empty area is transparent). */
  setOverlay(on) {
    this.overlay = !!on;
    this.layout();
  }

  layout() {
    if (this.window.isDestroyed()) return;
    const { width, height } = this.window.getContentBounds();
    const top = this.htmlFullscreen ? 0 : this.chromeHeight;
    if (this.active) this.active.view.setBounds({ x: 0, y: top, width, height: Math.max(0, height - top) });
    this.ui.setVisible(!this.htmlFullscreen);
    this.ui.setBounds({ x: 0, y: 0, width, height: this.overlay ? height : this.chromeHeight });
  }

  focusAddressBar() {
    this.sendUi("focus-address", null);
    this.ui.webContents.focus();
  }

  /** @param {string} name @param {any} data */
  sendUi(name, data) {
    if (!this.ui.webContents.isDestroyed()) this.ui.webContents.send("veil:ui-event", name, data);
  }

  /** @param {Tab} tab */
  tabChanged(tab) {
    this.pushState();
    if (tab === this.active && !this.window.isDestroyed()) {
      const title = tab.title && tab.title !== "New Tab" ? `${tab.title} – Veil` : "Veil";
      this.window.setTitle(this.private ? `${title} (Private)` : title);
    }
  }

  /** Send the toolbar a fresh copy of the tab list, at most every 40 ms. */
  pushState(now = false) {
    if (now) return this.#sendState();
    if (this.stateTimer) return;
    this.stateTimer = setTimeout(() => this.#sendState(), 40);
  }

  #sendState() {
    if (this.stateTimer) clearTimeout(this.stateTimer);
    this.stateTimer = null;
    if (this.window.isDestroyed()) return;
    const active = this.active;
    this.sendUi("state", {
      private: this.private,
      theme: nativeTheme.shouldUseDarkColors ? "dark" : "light",
      tabs: this.tabs.map((t) => t.summary()),
      activeId: active?.id ?? null,
      bookmarked: active ? this.browser.isBookmarked(active.displayUrl) : false,
      shields: active ? this.browser.shieldsSummary(active) : null,
      downloads: this.browser.downloadsSummary(this.session),
      canReopen: this.closed.length > 0,
    });
  }

  /** @param {number} id */
  tabById(id) {
    return this.tabs.find((t) => t.id === id) || null;
  }

  #destroy() {
    for (const t of this.tabs) t.destroy();
    this.tabs = [];
    this.active = null;
    if (!this.ui.webContents.isDestroyed()) this.ui.webContents.close();
    this.browser.onWindowClosed(this);
  }
}
