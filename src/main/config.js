// Constants shared by the main process. No Electron imports here, so unit tests can load it.

/** Where filter lists are mirrored when an upstream host can't be reached. */
const MIRROR = "https://raw.githubusercontent.com/ghostery/adblocker/master/packages/adblocker/assets/";

/**
 * Filter lists. Each list has one or more sources, tried in order; a source is
 * one URL or several URLs whose text is joined (for lists the mirror splits into parts).
 * @type {{ id: string, name: string, group: "ads" | "privacy" | "security" | "annoyances", on: boolean, sources: string[][], home: string }[]}
 */
export const LISTS = [
  {
    id: "easylist", name: "EasyList", group: "ads", on: true, home: "https://easylist.to",
    sources: [["https://easylist.to/easylist/easylist.txt"], [MIRROR + "easylist/easylist.txt"]],
  },
  {
    id: "easyprivacy", name: "EasyPrivacy", group: "privacy", on: true, home: "https://easylist.to",
    sources: [["https://easylist.to/easylist/easyprivacy.txt"], [MIRROR + "easylist/easyprivacy.txt"]],
  },
  {
    id: "ubo", name: "uBlock filters", group: "ads", on: true, home: "https://github.com/uBlockOrigin/uAssets",
    sources: [
      ["https://ublockorigin.github.io/uAssets/filters/filters.min.txt"],
      ["2020", "2021", "2022", "2023", "2024", ""].map((y) => `${MIRROR}ublock-origin/filters${y ? "-" + y : ""}.txt`),
    ],
  },
  {
    id: "ubo-privacy", name: "uBlock filters – Privacy", group: "privacy", on: true, home: "https://github.com/uBlockOrigin/uAssets",
    sources: [["https://ublockorigin.github.io/uAssets/filters/privacy.min.txt"], [MIRROR + "ublock-origin/privacy.txt"]],
  },
  {
    id: "ubo-badware", name: "uBlock filters – Badware risks", group: "security", on: true, home: "https://github.com/uBlockOrigin/uAssets",
    sources: [["https://ublockorigin.github.io/uAssets/filters/badware.min.txt"], [MIRROR + "ublock-origin/badware.txt"]],
  },
  {
    id: "ubo-quick", name: "uBlock filters – Quick fixes", group: "ads", on: true, home: "https://github.com/uBlockOrigin/uAssets",
    sources: [["https://ublockorigin.github.io/uAssets/filters/quick-fixes.min.txt"], [MIRROR + "ublock-origin/quick-fixes.txt"]],
  },
  {
    id: "ubo-unbreak", name: "uBlock filters – Unbreak", group: "ads", on: true, home: "https://github.com/uBlockOrigin/uAssets",
    sources: [["https://ublockorigin.github.io/uAssets/filters/unbreak.min.txt"], [MIRROR + "ublock-origin/unbreak.txt"]],
  },
  {
    id: "ubo-abuse", name: "uBlock filters – Resource abuse (cryptominers)", group: "security", on: true, home: "https://github.com/uBlockOrigin/uAssets",
    sources: [["https://ublockorigin.github.io/uAssets/filters/resource-abuse.txt"], [MIRROR + "ublock-origin/resource-abuse.txt"]],
  },
  {
    id: "peter-lowe", name: "Peter Lowe's Ad and tracking server list", group: "privacy", on: true, home: "https://pgl.yoyo.org/adservers/",
    sources: [["https://pgl.yoyo.org/adservers/serverlist.php?hostformat=adblockplus&showintro=1&mimetype=plaintext"], [MIRROR + "peter-lowe/serverlist.txt"]],
  },
  {
    id: "cookies", name: "EasyList Cookie (cookie notices)", group: "annoyances", on: true, home: "https://easylist.to",
    sources: [["https://secure.fanboy.co.nz/fanboy-cookiemonster.txt"], [MIRROR + "easylist/easylist-cookie.txt"]],
  },
  {
    id: "ubo-cookies", name: "uBlock filters – Cookie notices", group: "annoyances", on: true, home: "https://github.com/uBlockOrigin/uAssets",
    sources: [["https://ublockorigin.github.io/uAssets/filters/annoyances-cookies.txt"], [MIRROR + "ublock-origin/annoyances-cookies.txt"]],
  },
  {
    id: "ubo-annoyances", name: "uBlock filters – Other annoyances", group: "annoyances", on: false, home: "https://github.com/uBlockOrigin/uAssets",
    sources: [["https://ublockorigin.github.io/uAssets/filters/annoyances-others.txt"], [MIRROR + "ublock-origin/annoyances-others.txt"]],
  },
];

/** Scriptlet and redirect resources (uBlock Origin's, as packaged by Ghostery). */
export const RESOURCES_URL = MIRROR + "ublock-origin/resources.json";

/** How often filter lists are refreshed in the background. */
export const LIST_UPDATE_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** @type {Record<string, { name: string, url: string, home: string }>} */
export const SEARCH_ENGINES = {
  duckduckgo: { name: "DuckDuckGo", url: "https://duckduckgo.com/?q=%s", home: "https://duckduckgo.com" },
  brave: { name: "Brave Search", url: "https://search.brave.com/search?q=%s", home: "https://search.brave.com" },
  startpage: { name: "Startpage", url: "https://www.startpage.com/do/search?query=%s", home: "https://www.startpage.com" },
  mojeek: { name: "Mojeek", url: "https://www.mojeek.com/search?q=%s", home: "https://www.mojeek.com" },
  ecosia: { name: "Ecosia", url: "https://www.ecosia.org/search?q=%s", home: "https://www.ecosia.org" },
  qwant: { name: "Qwant", url: "https://www.qwant.com/?q=%s", home: "https://www.qwant.com" },
  bing: { name: "Bing", url: "https://www.bing.com/search?q=%s", home: "https://www.bing.com" },
  google: { name: "Google", url: "https://www.google.com/search?q=%s", home: "https://www.google.com" },
};

/** Default settings. Every key here can be changed on veil://settings. */
export const DEFAULT_SETTINGS = {
  searchEngine: "duckduckgo",
  theme: "system", // system | light | dark
  // Shields defaults (each site can override blocking and scripts)
  blockAds: true,
  blockCookieNotices: true,
  httpsOnly: true,
  stripTrackingParams: true,
  fingerprinting: true,
  cookies: "cross-site", // cross-site | all | none (what to block)
  gpc: true,
  blockPopups: true,
  webrtc: "default_public_interface_only",
  // Startup and data
  restoreSession: false,
  clearOnExit: false,
  // Network requests Veil makes by itself
  autoUpdateLists: true,
  checkForUpdates: true,
  /** @type {Record<string, boolean>} list id -> enabled; missing means the list's default */
  lists: {},
  downloadDir: "",
  askWhereToSave: false,
  zoom: 1,
};

/** Allowed values for settings that are a choice. */
export const SETTING_CHOICES = {
  searchEngine: Object.keys(SEARCH_ENGINES),
  theme: ["system", "light", "dark"],
  cookies: ["cross-site", "all", "none"],
  webrtc: ["default_public_interface_only", "disable_non_proxied_udp", "default_public_and_private_interfaces", "default"],
};

/** Is this a valid value for a setting? (Type and, for choices, one of the options.) */
export function validSetting(key, value) {
  if (!Object.hasOwn(DEFAULT_SETTINGS, key)) return false;
  const def = /** @type {any} */ (DEFAULT_SETTINGS)[key];
  if (def !== null && typeof def === "object") return !!value && typeof value === "object" && !Array.isArray(value);
  if (typeof value !== typeof def) return false;
  const choices = /** @type {Record<string, string[]>} */ (SETTING_CHOICES)[key];
  if (choices && !choices.includes(value)) return false;
  if (typeof value === "number" && !Number.isFinite(value)) return false;
  return true;
}

/** Origins of Veil's own pages. */
export const INTERNAL_SCHEME = "veil";
export const INTERNAL_PAGES = ["newtab", "settings", "history", "bookmarks", "downloads", "error", "about"];

export const NEW_TAB_URL = "veil://newtab/";

/** Estimate used for the "time saved" counter (the same order of magnitude other blockers use). */
export const MS_SAVED_PER_BLOCK = 50;

export const RELEASES_API = "https://api.github.com/repos/Ethos6/veil/releases/latest";
export const RELEASES_PAGE = "https://github.com/Ethos6/veil/releases/latest";

/** A plain Chrome user agent for the platform: no "Electron/x" or app name, and the reduced form Chrome sends. */
export function chromeUserAgent(platform = process.platform, chromeVersion = process.versions.chrome || "152.0.0.0") {
  const major = String(chromeVersion).split(".")[0];
  const os = platform === "win32" ? "Windows NT 10.0; Win64; x64"
    : platform === "darwin" ? "Macintosh; Intel Mac OS X 10_15_7"
    : "X11; Linux x86_64";
  return `Mozilla/5.0 (${os}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}
