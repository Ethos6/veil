// Small helpers with no Electron dependency (unit-tested directly).
import fs from "node:fs";
import path from "node:path";
import { siteOf } from "./privacy.js";

/** A free file name in a folder: report.pdf, report (1).pdf, … */
export function uniquePath(dir, name, taken = new Set()) {
  const clean = (name || "download").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").replace(/^\.+/, "_").slice(0, 200) || "download";
  const ext = path.extname(clean);
  const base = clean.slice(0, clean.length - ext.length);
  let p = path.join(dir, clean);
  for (let i = 1; (fs.existsSync(p) || taken.has(p)) && i < 10_000; i++) p = path.join(dir, `${base} (${i})${ext}`);
  return p;
}

/** @param {string} latest @param {string} current */
export function newerVersion(latest, current) {
  const a = latest.split(/[.-]/).slice(0, 3).map((x) => parseInt(x, 10));
  const b = current.split(/[.-]/).slice(0, 3).map((x) => parseInt(x, 10));
  if (a.some(Number.isNaN)) return false;
  for (let i = 0; i < 3; i++) {
    if ((a[i] || 0) > (b[i] || 0)) return true;
    if ((a[i] || 0) < (b[i] || 0)) return false;
  }
  return false;
}

/** Most visited sites for the new tab page, one entry per site. */
export function topSites(entries, n) {
  /** @type {Map<string, { url: string, title: string, visits: number, last: number }>} */
  const bySite = new Map();
  for (const e of entries) {
    const site = siteOf(e.url);
    if (!site) continue;
    const cur = bySite.get(site);
    if (!cur) bySite.set(site, { url: e.url, title: e.title, visits: e.visits, last: e.last });
    else {
      cur.visits += e.visits;
      // Prefer the shortest URL as the site's entry point.
      if (e.url.length < cur.url.length) { cur.url = e.url; cur.title = e.title || cur.title; }
    }
  }
  return [...bySite.values()].filter((s) => s.visits >= 2).sort((a, b) => b.visits - a.visits).slice(0, n)
    .map((s) => ({ url: new URL(s.url).origin + "/", title: s.title, site: siteOf(s.url) }));
}

/** @param {string} html */
export function parseBookmarkHtml(html) {
  /** @type {{ url: string, title: string }[]} */
  const out = [];
  const re = /<a\s[^>]*href\s*=\s*"([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) && out.length < 50_000) {
    const url = decodeEntities(m[1]);
    if (!/^https?:\/\//i.test(url)) continue;
    out.push({ url, title: decodeEntities(m[2].replace(/<[^>]*>/g, "")).trim().slice(0, 500) || url });
  }
  return out;
}

/** @param {{ url: string, title: string, added: number }[]} items */
export function bookmarksToHtml(items) {
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  return [
    "<!DOCTYPE NETSCAPE-Bookmark-file-1>",
    '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
    "<TITLE>Bookmarks</TITLE>",
    "<H1>Bookmarks</H1>",
    "<DL><p>",
    ...items.map((b) => `    <DT><A HREF="${esc(b.url)}" ADD_DATE="${Math.floor((b.added || 0) / 1000)}">${esc(b.title)}</A>`),
    "</DL><p>",
    "",
  ].join("\n");
}

function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|#39);/gi, (_m, e) => {
    const l = e.toLowerCase();
    if (l === "amp") return "&";
    if (l === "lt") return "<";
    if (l === "gt") return ">";
    if (l === "quot") return '"';
    if (l === "apos" || l === "#39") return "'";
    const code = l.startsWith("#x") ? parseInt(l.slice(2), 16) : parseInt(l.slice(1), 10);
    return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : "";
  });
}
