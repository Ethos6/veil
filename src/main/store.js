// Small JSON stores written atomically. Each store lives in its own file in the profile folder.
import fs from "node:fs";
import path from "node:path";

/** @template T */
export class JsonStore {
  /**
   * @param {string} file
   * @param {() => T} defaults
   * @param {{ delay?: number, normalize?: (value: any) => T }} [opts]
   */
  constructor(file, defaults, opts = {}) {
    this.file = file;
    this.defaults = defaults;
    this.delay = opts.delay ?? 400;
    this.normalize = opts.normalize || ((v) => v);
    /** @type {T} */
    this.data = this.#load();
    /** @type {NodeJS.Timeout | null} */
    this.timer = null;
    this.disabled = false;
  }

  #load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8"));
      return this.normalize(raw);
    } catch (e) {
      if (/** @type {any} */ (e).code !== "ENOENT") {
        // Keep a copy of an unreadable file instead of silently overwriting it.
        try { fs.renameSync(this.file, this.file + ".corrupt-" + Date.now()); } catch { /* ignore */ }
      }
      return this.normalize(this.defaults());
    }
  }

  /** Schedule a write. */
  save() {
    if (this.disabled) return;
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.flush(); }, this.delay);
    this.timer.unref?.();
  }

  /** Write now (atomically: temp file then rename). */
  flush() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.disabled) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  /** Reset to defaults and remove the file. */
  clear() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.data = this.normalize(this.defaults());
    try { fs.rmSync(this.file, { force: true }); } catch { /* ignore */ }
  }
}

/**
 * Merge saved settings over defaults, keeping only known keys with valid values.
 * @template {Record<string, any>} T
 * @param {T} defaults
 * @param {any} saved
 * @param {(key: string, value: any) => boolean} [valid]
 * @returns {T}
 */
export function mergeSettings(defaults, saved, valid) {
  /** @type {any} */
  const out = structuredClone(defaults);
  if (!saved || typeof saved !== "object") return out;
  for (const [k, v] of Object.entries(defaults)) {
    if (!Object.hasOwn(saved, k)) continue;
    const s = saved[k];
    if (valid && !valid(k, s)) continue;
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      if (s && typeof s === "object" && !Array.isArray(s)) out[k] = { ...s };
    } else if (typeof s === typeof v) out[k] = s;
  }
  return out;
}

/** History is capped so the file stays small. */
export const HISTORY_LIMIT = 20_000;

/**
 * @typedef {{ url: string, title: string, visits: number, last: number }} HistoryEntry
 * @typedef {{ id: string, url: string, title: string, added: number }} Bookmark
 */

/** @param {any} v @returns {{ entries: HistoryEntry[] }} */
export function normalizeHistory(v) {
  const entries = Array.isArray(v?.entries) ? v.entries.filter((e) => e && typeof e.url === "string") : [];
  return { entries };
}

/**
 * Record a visit, most recent first.
 * @param {{ entries: HistoryEntry[] }} h
 * @param {string} url
 * @param {string} title
 * @param {number} [now]
 */
export function addVisit(h, url, title, now = Date.now()) {
  const i = h.entries.findIndex((e) => e.url === url);
  /** @type {HistoryEntry} */
  let entry;
  if (i >= 0) {
    entry = h.entries[i];
    h.entries.splice(i, 1);
    entry.visits += 1;
    entry.last = now;
    if (title) entry.title = title;
  } else entry = { url, title: title || "", visits: 1, last: now };
  h.entries.unshift(entry);
  if (h.entries.length > HISTORY_LIMIT) h.entries.length = HISTORY_LIMIT;
}

/** @param {{ entries: HistoryEntry[] }} h @param {string} url @param {string} title */
export function setTitle(h, url, title) {
  const e = h.entries.find((x) => x.url === url);
  if (e && title) e.title = title;
}
