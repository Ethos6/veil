// The content blocker: filter lists compiled into one fast matching engine.
// Network filters block or neuter requests; cosmetic filters hide page elements
// and run uBlock-style scriptlets; $csp filters add policies to pages.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { FiltersEngine, Request } from "@ghostery/adblocker";
import { LISTS, RESOURCES_URL } from "./config.js";
import { hostnameAndDomain } from "./privacy.js";

/**
 * @typedef {{ id: string, name: string, on: boolean, sources: string[][] }} ListDef
 * @typedef {{ id: string, ok: boolean, rules: number, source?: string, error?: string }} ListResult
 * @typedef {{ updated: number, lists: ListResult[], resources: boolean, networkFilters: number, cosmeticFilters: number }} EngineInfo
 */

export const REDIRECT_SCHEME = "veil-res";

/** @param {{ token: string }} b */
const blockerToken = (b) => b.token;

/**
 * The replacement resource for a veil-res:// URL.
 * @param {Blocker} blocker @param {string} url
 * @returns {{ body: Buffer, type: string } | null}
 */
export function redirectResource(blocker, url) {
  let name = "";
  try {
    const u = new URL(url);
    if (u.hostname !== blocker.token) return null;
    name = decodeURIComponent(u.pathname.slice(1));
  } catch { return null; }
  const r = blocker.redirects.get(name);
  if (!r) return null;
  const [type, enc] = String(r.contentType || "text/plain").split(";");
  const body = enc && enc.trim() === "base64" ? Buffer.from(r.body, "base64") : Buffer.from(r.body, "utf8");
  return { body, type: type.trim() };
}

/** Electron resource types the engine understands as-is, plus fetch(), which Electron reports separately. */
const TYPE_ALIASES = { fetch: "xhr" };

export class Blocker {
  /**
   * @param {{
   *   cacheFile?: string,          // where an updated engine is saved (in the profile)
   *   bundledFile?: string,        // engine built at packaging time (read-only)
   *   lists?: ListDef[],
   *   resourcesUrl?: string | null,
   *   fetch?: typeof fetch,
   *   log?: (msg: string) => void,
   * }} opts
   */
  constructor(opts = {}) {
    this.cacheFile = opts.cacheFile;
    this.bundledFile = opts.bundledFile;
    this.lists = opts.lists || LISTS;
    this.resourcesUrl = opts.resourcesUrl === undefined ? RESOURCES_URL : opts.resourcesUrl;
    this.fetch = opts.fetch || globalThis.fetch;
    this.log = opts.log || (() => {});
    /** @type {FiltersEngine} */
    this.engine = FiltersEngine.empty();
    /** @type {EngineInfo | null} */
    this.info = null;
    /** @type {Promise<EngineInfo | null> | null} */
    this.updating = null;
    /** Neutered replacements served on veil-res:// (Chromium won't redirect a request to a data: URL). @type {Map<string, { body: string, contentType: string }>} */
    this.redirects = new Map();
    /** Random per run, so pages can't probe veil-res:// for resources on their own. */
    this.token = crypto.randomBytes(12).toString("hex");
  }

  /** Load the most recent engine available on disk. Never touches the network. */
  load() {
    for (const file of [this.cacheFile, this.bundledFile]) {
      if (!file) continue;
      try {
        const buf = fs.readFileSync(file);
        this.engine = FiltersEngine.deserialize(new Uint8Array(buf));
        this.info = readInfo(file) || {
          updated: 0, lists: [], resources: false,
          networkFilters: countNetwork(this.engine), cosmeticFilters: countCosmetic(this.engine),
        };
        this.log(`blocker: loaded ${path.basename(file)}`);
        return true;
      } catch (e) {
        if (/** @type {any} */ (e).code !== "ENOENT") this.log(`blocker: could not load ${file}: ${/** @type {Error} */ (e).message}`);
      }
    }
    return false;
  }

  /**
   * Compile filters given as text (used by tests and for custom lists).
   * @param {string} text @param {string} [resources] uBlock-style resources JSON
   */
  loadText(text, resources) {
    this.engine = FiltersEngine.parse(text, { enableCompression: true, loadCosmeticFilters: true, loadNetworkFilters: true, loadCSPFilters: true });
    if (resources) this.engine.updateResources(resources, String(resources.length));
    this.info = {
      updated: Date.now(), lists: [], resources: !!resources,
      networkFilters: countNetwork(this.engine), cosmeticFilters: countCosmetic(this.engine),
    };
  }

  /** @returns {boolean} true when no filters are loaded */
  get empty() {
    return !this.info || this.info.networkFilters + this.info.cosmeticFilters === 0;
  }

  /**
   * Download the enabled lists and rebuild the engine. Lists that fail keep the
   * previous engine in place unless at least one list succeeded.
   * @param {Record<string, boolean>} [enabled] per-list overrides
   * @returns {Promise<EngineInfo | null>}
   */
  update(enabled = {}) {
    if (this.updating) return this.updating;
    this.updating = this.#update(enabled).finally(() => { this.updating = null; });
    return this.updating;
  }

  /** @param {Record<string, boolean>} enabled */
  async #update(enabled) {
    const active = this.lists.filter((l) => enabled[l.id] ?? l.on);
    const results = await Promise.all(active.map((l) => this.#fetchList(l)));
    const ok = results.filter((r) => r.text);
    if (!ok.length) {
      this.log("blocker: no filter list could be downloaded; keeping the current filters");
      return null;
    }
    const engine = FiltersEngine.parse(ok.map((r) => r.text).join("\n"), {
      enableCompression: true,
      loadCosmeticFilters: true,
      loadNetworkFilters: true,
      enableHtmlFiltering: false,
      loadCSPFilters: true,
    });
    let resources = false;
    if (this.resourcesUrl) {
      try {
        const res = await this.#get(this.resourcesUrl);
        engine.updateResources(res, String(res.length));
        resources = true;
      } catch (e) {
        this.log(`blocker: scriptlet resources unavailable: ${/** @type {Error} */ (e).message}`);
      }
    }
    /** @type {EngineInfo} */
    const info = {
      updated: Date.now(),
      resources,
      networkFilters: countNetwork(engine),
      cosmeticFilters: countCosmetic(engine),
      lists: results.map(({ text, ...r }) => r),
    };
    this.engine = engine;
    this.info = info;
    if (this.cacheFile) this.save(this.cacheFile);
    return info;
  }

  /** Write the engine (and its info next to it). */
  save(file) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + ".tmp";
    fs.writeFileSync(tmp, this.engine.serialize());
    fs.renameSync(tmp, file);
    fs.writeFileSync(file + ".json", JSON.stringify(this.info));
  }

  /** @param {ListDef} list */
  async #fetchList(list) {
    /** @type {string[]} */
    const errors = [];
    for (const parts of list.sources) {
      try {
        const texts = await Promise.all(parts.map((u) => this.#get(u)));
        const text = texts.join("\n");
        if (!looksLikeFilterList(text)) throw new Error("not a filter list");
        return { id: list.id, ok: true, rules: countRules(text), source: new URL(parts[0]).hostname, text };
      } catch (e) {
        errors.push(`${new URL(parts[0]).hostname}: ${/** @type {Error} */ (e).message}`);
      }
    }
    this.log(`blocker: ${list.id} failed (${errors.join("; ")})`);
    return { id: list.id, ok: false, rules: 0, error: errors.join("; "), text: "" };
  }

  /** @param {string} url */
  async #get(url) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 30_000);
    try {
      const res = await this.fetch(url, { signal: ctrl.signal, headers: { "user-agent": "Veil filter list updater" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } finally {
      clearTimeout(t);
    }
  }

  /**
   * Decide what to do with a request.
   * @param {{ url: string, type: string, sourceUrl?: string }} req
   * @returns {{ block: boolean, redirect?: string, filter?: string }}
   */
  match(req) {
    const type = TYPE_ALIASES[/** @type {keyof typeof TYPE_ALIASES} */ (req.type)] || req.type || "other";
    const request = Request.fromRawDetails({ url: req.url, sourceUrl: req.sourceUrl || "", type: /** @type {any} */ (type) });
    if (request.isMainFrame()) return { block: false };
    const { match, redirect, filter } = this.engine.match(request);
    if (redirect) {
      const name = redirect.filename || "noop";
      if (!this.redirects.has(name) && this.redirects.size < 500) this.redirects.set(name, { body: redirect.body, contentType: redirect.contentType });
      return { block: true, redirect: `${REDIRECT_SCHEME}://${blockerToken(this)}/${encodeURIComponent(name)}`, filter: filter?.toString() };
    }
    if (match) return { block: true, filter: filter?.toString() };
    return { block: false };
  }

  /**
   * Should opening this page at all be stopped? Like uBlock Origin's "strict blocking":
   * only rules written for documents ($document, e.g. the badware list) and rules that
   * block a whole host (||tracker.example^) count; path patterns that happen to match
   * a page URL don't.
   * @param {string} url
   * @returns {{ block: boolean, filter?: string }}
   */
  matchDocument(url) {
    const request = Request.fromRawDetails({ url, sourceUrl: url, type: "main_frame" });
    const { match, filter } = this.engine.match(request);
    if (!match || !filter || typeof filter.isException !== "function") return { block: false };
    const f = /** @type {import("@ghostery/adblocker").NetworkFilter} */ (filter);
    const explicitDocument = f.fromDocument() && !f.fromAny();
    const wholeHost = f.isHostnameAnchor() && !f.hasFilter() && !f.hasDomains() && f.fromAny() && !f.isRedirect() && !f.isCSP();
    if (explicitDocument || wholeHost) return { block: true, filter: f.toString() };
    return { block: false };
  }

  /**
   * Extra Content-Security-Policy from $csp filters for a document.
   * @param {{ url: string, type: string, sourceUrl?: string }} req
   */
  csp(req) {
    const request = Request.fromRawDetails({ url: req.url, sourceUrl: req.sourceUrl || "", type: /** @type {any} */ (req.type) });
    return this.engine.getCSPDirectives(request);
  }

  /**
   * Cosmetic rules for a frame.
   * @param {{ url: string, first: boolean, classes?: string[], ids?: string[], hrefs?: string[], ancestors?: string[] }} q
   * `first` is the call made before the page's own scripts run: it returns
   * generic and site-specific hiding rules plus scriptlets. Later calls only
   * return rules matching classes and ids seen in the page.
   * @returns {{ styles: string, scripts: string[] }}
   */
  cosmetics(q) {
    const { hostname, domain } = hostnameAndDomain(q.url);
    if (!hostname) return { styles: "", scripts: [] };
    const { active, styles, scripts } = this.engine.getCosmeticsFilters({
      url: q.url,
      hostname,
      domain,
      ancestors: q.ancestors?.map((u) => hostnameAndDomain(u)).filter((a) => a.hostname),
      classes: q.classes,
      ids: q.ids,
      hrefs: q.hrefs,
      getBaseRules: q.first,
      getInjectionRules: q.first,
      getExtendedRules: false,
      getRulesFromHostname: q.first,
      getRulesFromDOM: !q.first,
    });
    if (active === false) return { styles: "", scripts: [] };
    return { styles: styles || "", scripts: scripts || [] };
  }
}

/** @param {string} file @returns {EngineInfo | null} */
function readInfo(file) {
  try { return JSON.parse(fs.readFileSync(file + ".json", "utf8")); } catch { return null; }
}

/** A filter list is text, with rules, and not an HTML error page. */
export function looksLikeFilterList(text) {
  if (!text || text.length < 20) return false;
  const head = text.slice(0, 2000).toLowerCase();
  if (head.includes("<html") || head.includes("<!doctype")) return false;
  return countRules(text.slice(0, 200_000)) > 0;
}

/** @param {string} text */
export function countRules(text) {
  let n = 0;
  for (const line of text.split("\n")) {
    const l = line.trim();
    if (l && !l.startsWith("!") && !l.startsWith("[") && !l.startsWith("#")) n++;
    else if (l.startsWith("##") || l.startsWith("#@#")) n++;
  }
  return n;
}

/** @param {FiltersEngine} e */
function countNetwork(e) {
  try { return e.getFilters().networkFilters.length; } catch { return 0; }
}
/** @param {FiltersEngine} e */
function countCosmetic(e) {
  try { return e.getFilters().cosmeticFilters.length; } catch { return 0; }
}
