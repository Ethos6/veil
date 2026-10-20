// Veil: entry point of the main process.
import { app, protocol } from "electron";
import path from "node:path";
import fs from "node:fs";
import { Browser } from "./browser.js";
import { resolveInput } from "./omnibox.js";

const srcDir = path.resolve(import.meta.dirname, "..");
const rootDir = path.resolve(srcDir, "..");
// Test mode (end-to-end tests only; never in a packaged build).
const test = process.env.VEIL_TEST === "1" && !app.isPackaged;

// A separate profile for tests and for anyone who asks for one.
const profileArg = process.argv.find((a) => a.startsWith("--profile="));
const profile = test ? process.env.VEIL_PROFILE : profileArg ? path.resolve(profileArg.slice(10)) : "";
if (profile) app.setPath("userData", profile);
if (test) {
  if (process.env.VEIL_HOST_RULES) app.commandLine.appendSwitch("host-resolver-rules", process.env.VEIL_HOST_RULES);
  app.commandLine.appendSwitch("ignore-certificate-errors");
  app.commandLine.appendSwitch("no-proxy-server");
}

// Advertising and measurement APIs Chromium ships for Google's Privacy Sandbox: off.
app.commandLine.appendSwitch("disable-features", [
  "BrowsingTopics", "BrowsingTopicsXHR", "InterestGroupStorage", "Fledge", "AdInterestGroupAPI",
  "AttributionReportingCrossAppWeb", "PrivateAggregationApi", "SharedStorageAPI", "FencedFrames",
  "PrivacySandboxAdsAPIsOverride", "InterestFeedContentSuggestions", "MediaRouter", "OptimizationHints",
].join(","));
app.commandLine.appendSwitch("enable-features", "StrictOriginIsolation");

// Cross-site cookies are blocked inside Chromium itself (covering scripts, frames,
// service workers and every other path), unless the user chose to allow them.
// Sites can still ask for access through the Storage Access API, which Veil prompts for.
if (readCookieSetting() !== "none") app.commandLine.appendSwitch("test-third-party-cookie-phaseout");

function readCookieSetting() {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(app.getPath("userData"), "settings.json"), "utf8"));
    return typeof s?.cookies === "string" ? s.cookies : "cross-site";
  } catch {
    return "cross-site";
  }
}

protocol.registerSchemesAsPrivileged([
  { scheme: "veil", privileges: { standard: true, secure: true, supportFetchAPI: false, corsEnabled: false, stream: false } },
  // Neutered stand-ins for blocked scripts and images (uBlock-style "redirect" filters).
  { scheme: "veil-res", privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);

/** URLs passed on the command line (Veil set as the default browser, or `veil https://…`). */
function urlsFromArgv(argv) {
  return argv.slice(1).filter((a) => !a.startsWith("-") && /^(https?:\/\/|www\.)/i.test(a)).map((a) => resolveInput(a).url);
}

if (!test && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  /** @type {Browser | null} */
  let browser = null;
  /** @type {string[]} */
  const pending = [];

  app.on("second-instance", (_e, argv) => {
    if (!browser) return;
    const urls = urlsFromArgv(argv);
    if (urls.length) for (const u of urls) browser.openUrl(u);
    else browser.newWindow();
  });

  app.on("open-url", (e, url) => {
    e.preventDefault();
    if (browser) browser.openUrl(url);
    else pending.push(url);
  });

  app.on("web-contents-created", (_e, wc) => {
    wc.on("will-attach-webview", (ev) => ev.preventDefault());
  });

  app.whenReady().then(async () => {
    const packaged = app.isPackaged;
    const resourcesDir = packaged ? process.resourcesPath : path.join(rootDir, "resources");
    const iconPath = [path.join(resourcesDir, "icon.png"), path.join(rootDir, "build", "icon.png")].find((p) => fs.existsSync(p));
    browser = new Browser({ srcDir, userData: app.getPath("userData"), resourcesDir, test, iconPath });
    browser.init();
    await browser.prepare();
    const urls = [...urlsFromArgv(process.argv), ...pending];
    if (urls.length) browser.newWindow({ urls });
    else browser.restoreOrNew();
    // For end-to-end tests.
    if (test) /** @type {any} */ (globalThis).veil = browser;
  });

  app.on("activate", () => {
    if (browser && browser.windows.length === 0) browser.newWindow();
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin" || test) app.quit();
  });

  let quitReady = false;
  app.on("before-quit", (e) => {
    if (quitReady || !browser) return;
    e.preventDefault();
    browser.beforeQuit().catch((err) => console.error(err)).finally(() => {
      quitReady = true;
      app.quit();
    });
  });
}
