// Turn what the user typed into a URL to open, and rank local suggestions.
import { parse } from "tldts";
import { SEARCH_ENGINES } from "./config.js";
import { isLocalHost } from "./privacy.js";

/** Schemes that may be opened from the address bar. Anything else (javascript:, data:…) is searched for. */
const OPENABLE = new Set(["http", "https", "veil", "file", "view-source"]);
/** Suffixes that aren't public but are real on local networks. */
const LOCAL_SUFFIXES = /\.(local|lan|internal|localhost|home\.arpa|test|example|invalid)$/i;

/**
 * @param {string} input
 * @param {string} engineId
 * @returns {{ url: string, kind: "url" | "search" }}
 */
export function resolveInput(input, engineId = "duckduckgo") {
  const text = String(input || "").trim();
  if (!text) return { url: "veil://newtab/", kind: "url" };
  if (/^about:blank$/i.test(text)) return { url: "about:blank", kind: "url" };

  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(text)?.[1]?.toLowerCase();
  if (scheme && OPENABLE.has(scheme) && (!/^https?$/.test(scheme) || /^https?:\/\//i.test(text))) {
    try {
      if (scheme === "view-source") {
        const inner = new URL(text.slice("view-source:".length).replace(/ /g, "%20"));
        if (/^https?:$/.test(inner.protocol)) return { url: "view-source:" + inner.toString(), kind: "url" };
      } else {
        // A pasted URL with spaces is still a URL, not a search for it.
        return { url: new URL(text.replace(/ /g, "%20")).toString(), kind: "url" };
      }
    } catch { /* not a valid URL: search */ }
  }

  // host[:port][/path?query#hash], where only the path part may contain spaces
  const isOtherScheme = scheme && !/^[^:]+:\d/.test(text); // "localhost:3000" isn't a scheme
  const m = isOtherScheme ? null : /^([^\s/?#]+)([/?#].*)?$/su.exec(text);
  if (m) {
    const hostPort = m[1];
    const rest = m[2] || "";
    const portMatch = /^(.*?)(?::(\d{1,5}))?$/.exec(hostPort);
    const host = (portMatch?.[1] || hostPort).replace(/\.$/, "").replace(/^\[|\]$/g, "");
    const hasPort = !!portMatch?.[2];
    const ipv4 = /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
    const ipv6 = hostPort.startsWith("[") && /^[0-9a-f:.]+$/i.test(host);
    const validLabels = host.split(".").every((l) => /^[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?$/u.test(l));
    const dotted = host.includes(".");
    const info = dotted && validLabels ? parse(host, { allowPrivateDomains: true }) : null;
    const knownSuffix = !!info && (info.isIcann || info.isPrivate) && !!info.domain;
    const looksLikeHost =
      ipv4 || ipv6 || host.toLowerCase() === "localhost" ||
      (validLabels && dotted && (knownSuffix || LOCAL_SUFFIXES.test(host) || rest.startsWith("/"))) ||
      (validLabels && !dotted && hasPort);
    if (looksLikeHost) {
      const local = isLocalHost(host) || LOCAL_SUFFIXES.test(host) && !/\.(test|example|invalid)$/i.test(host);
      try {
        const url = new URL(`${local ? "http" : "https"}://${hostPort.replace(/\.(?=:|$)/, "")}${rest.replace(/ /g, "%20")}`);
        return { url: url.toString(), kind: "url" };
      } catch { /* search */ }
    }
  }
  return { url: searchUrl(text, engineId), kind: "search" };
}

/** @param {string} query @param {string} engineId */
export function searchUrl(query, engineId) {
  const engine = SEARCH_ENGINES[engineId] || SEARCH_ENGINES.duckduckgo;
  return engine.url.replace("%s", encodeURIComponent(query).replace(/%20/g, "+"));
}

/**
 * Rank history and bookmarks for what's typed. Everything stays local: no
 * request is made to a search engine while you type.
 * @param {string} input
 * @param {{ url: string, title: string, visits?: number, last?: number }[]} history
 * @param {{ url: string, title: string }[]} bookmarks
 * @param {number} [limit]
 */
export function suggest(input, history, bookmarks, limit = 6) {
  const q = String(input || "").trim().toLowerCase();
  if (!q) return [];
  const words = q.split(/\s+/);
  /** @type {Map<string, { url: string, title: string, score: number, bookmark: boolean }>} */
  const out = new Map();
  const now = Date.now();
  const consider = (item, bookmark) => {
    const url = item.url.toLowerCase();
    const title = (item.title || "").toLowerCase();
    const bare = url.replace(/^https?:\/\/(www\.)?/, "");
    if (!words.every((w) => bare.includes(w) || title.includes(w))) return;
    let score = 0;
    if (bare.startsWith(q)) score += 100;
    else if (bare.split(/[./]/).some((p) => p.startsWith(words[0]))) score += 40;
    if (title.startsWith(q)) score += 30;
    score += Math.min(30, (item.visits || 0) * 3);
    if (item.last) score += Math.max(0, 20 - (now - item.last) / 86_400_000);
    if (bookmark) score += 25;
    const prev = out.get(item.url);
    if (!prev || prev.score < score) out.set(item.url, { url: item.url, title: item.title || "", score, bookmark: bookmark || !!prev?.bookmark });
  };
  for (const b of bookmarks) consider(b, true);
  for (const h of history) consider(h, false);
  return [...out.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}
