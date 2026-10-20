// veil:// serves Veil's own pages (new tab, settings, history...) from the app folder.
import fs from "node:fs";
import path from "node:path";
import { INTERNAL_PAGES } from "./config.js";

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".json": "application/json",
};

const PAGE_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join("; ");

/**
 * Map a veil:// URL to a file. veil://settings/ -> pages/settings.html,
 * veil://settings/settings.js -> pages/settings.js, veil://ui/ -> ui/index.html.
 * @param {string} rootDir the src folder
 * @param {string} url
 * @returns {string | null}
 */
export function resolveInternal(rootDir, url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== "veil:") return null;
  const host = u.hostname;
  let rel = decodeURIComponent(u.pathname).replace(/^\/+/, "");
  let base;
  if (host === "ui") base = path.join(rootDir, "ui");
  else if (INTERNAL_PAGES.includes(host)) base = path.join(rootDir, "pages");
  else return null;
  if (!rel) rel = host === "ui" ? "index.html" : `${host}.html`;
  if (rel.includes("\0")) return null;
  const file = path.resolve(base, rel);
  // Shared assets (styles, icons) live next to the pages.
  if (!file.startsWith(base + path.sep)) return null;
  return file;
}

/**
 * @param {Electron.Session} ses
 * @param {string} rootDir
 */
export function registerInternalProtocol(ses, rootDir) {
  if (ses.protocol.isProtocolHandled("veil")) return;
  ses.protocol.handle("veil", async (request) => {
    const file = resolveInternal(rootDir, request.url);
    if (!file) return new Response("Not found", { status: 404 });
    try {
      const body = await fs.promises.readFile(file);
      return new Response(body, {
        status: 200,
        headers: {
          "content-type": TYPES[/** @type {keyof typeof TYPES} */ (path.extname(file))] || "application/octet-stream",
          "content-security-policy": PAGE_CSP,
          "x-content-type-options": "nosniff",
          "x-frame-options": "DENY",
          "cache-control": "no-store",
          "referrer-policy": "no-referrer",
        },
      });
    } catch {
      return new Response("Not found", { status: 404 });
    }
  });
}
