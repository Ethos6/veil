import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { decideRequest, blockCookiesFor, topUrlOf } from "../../src/main/network.js";
import { Blocker } from "../../src/main/blocker.js";
import { DEFAULT_SETTINGS } from "../../src/main/config.js";

const FIX = path.join(import.meta.dirname, "..", "fixtures");
const blocker = new Blocker({ lists: [] });
blocker.loadText(fs.readFileSync(path.join(FIX, "filters.txt"), "utf8"), fs.readFileSync(path.join(FIX, "resources.json"), "utf8"));

function host(over = {}, sites = {}) {
  const events = [];
  const settings = { ...DEFAULT_SETTINGS, ...over };
  return {
    events,
    settings: () => settings,
    shieldsOn: (site) => sites[site]?.shields !== false,
    scriptsBlocked: (site) => sites[site]?.scripts === "block",
    httpExceptions: new Set(),
    allowedDocuments: new Set(),
    blocker,
    onBlocked: (id, url, type) => events.push(["blocked", url, type]),
    onUpgraded: (id, from, to) => events.push(["upgraded", from, to]),
    isUpgradeLoop: () => false,
    onStripped: () => events.push(["stripped"]),
    onDocumentBlocked: (id, url) => events.push(["document", url]),
  };
}
const req = (url, resourceType, extra = {}) => ({ url, resourceType, method: "GET", webContentsId: 1, ...extra });

test("navigations: upgrade first, then strip tracking params", () => {
  const h = host();
  assert.deepEqual(decideRequest(req("http://example.com/?utm_source=x", "mainFrame"), "", "", h), { redirectURL: "https://example.com/?utm_source=x" });
  assert.deepEqual(decideRequest(req("https://example.com/?utm_source=x", "mainFrame"), "", "", h), { redirectURL: "https://example.com/" });
  assert.deepEqual(decideRequest(req("https://example.com/", "mainFrame"), "", "", h), {});
  assert.deepEqual(h.events.map((e) => e[0]), ["upgraded", "stripped"]);
  // POST navigations keep their URL
  assert.deepEqual(decideRequest(req("https://example.com/?fbclid=1", "mainFrame", { method: "POST" }), "", "", h), {});
});

test("settings switch features off", () => {
  const h = host({ httpsOnly: false, stripTrackingParams: false, blockAds: false });
  assert.deepEqual(decideRequest(req("http://example.com/?fbclid=1", "mainFrame"), "", "", h), {});
  assert.deepEqual(decideRequest(req("https://ads.test/ad.js", "script"), "https://site.test/", "https://site.test/", h), {});
  assert.deepEqual(decideRequest(req("https://scam.test/", "mainFrame"), "", "", h), {});
});

test("subresources are blocked or redirected; shields-down sites are left alone", () => {
  const h = host();
  assert.deepEqual(decideRequest(req("https://ads.test/ad.js", "script"), "https://site.test/", "https://site.test/", h), { cancel: true });
  assert.deepEqual(decideRequest(req("https://redirect.test/lib.js", "script"), "https://site.test/", "https://site.test/", h), { redirectURL: `veil-res://${blocker.token}/noop.js` });
  assert.deepEqual(decideRequest(req("wss://ads.test/socket", "webSocket"), "https://site.test/", "https://site.test/", h), { cancel: true });
  assert.deepEqual(decideRequest(req("veil://newtab/", "mainFrame"), "", "", h), {});
  const off = host({}, { "site.test": { shields: false } });
  assert.deepEqual(decideRequest(req("https://ads.test/ad.js", "script"), "https://site.test/", "https://site.test/", off), {});
  assert.deepEqual(decideRequest(req("http://site.test/", "mainFrame"), "", "", off), {}, "no upgrade either");
});

test("per-site script blocking", () => {
  const h = host({}, { "site.test": { scripts: "block" } });
  assert.deepEqual(decideRequest(req("https://cdn.site.test/app.js", "script"), "https://site.test/", "https://site.test/", h), { cancel: true });
  assert.deepEqual(decideRequest(req("https://cdn.site.test/app.css", "stylesheet"), "https://site.test/", "https://site.test/", h), {});
});

test("documents on scam hosts are cancelled unless the user allowed them", () => {
  const h = host();
  assert.deepEqual(decideRequest(req("https://scam.test/x", "mainFrame"), "", "", h), { cancel: true });
  assert.deepEqual(h.events.pop(), ["document", "https://scam.test/x"]);
  h.allowedDocuments.add("https://scam.test/x");
  assert.deepEqual(decideRequest(req("https://scam.test/x", "mainFrame"), "", "", h), {});
});

test("HTTPS upgrade loops are stopped", () => {
  const h = host();
  h.isUpgradeLoop = () => true;
  assert.deepEqual(decideRequest(req("http://loop.example/", "mainFrame"), "", "", h), { cancel: true });
  assert.deepEqual(decideRequest(req("http://loop.example/", "subFrame"), "https://a.example/", "https://a.example/", h), {});
});

test("Veil strips cookies itself only in block-all mode (Chromium blocks cross-site ones)", () => {
  assert.equal(blockCookiesFor("https://tracker.net/p", "https://news.example/", host()), false);
  assert.equal(blockCookiesFor("https://news.example/p", "https://news.example/", host({ cookies: "all" })), true);
  assert.equal(blockCookiesFor("https://news.example/p", "https://news.example/", host({ cookies: "all" }, { "news.example": { shields: false } })), false);
  assert.equal(blockCookiesFor("https://tracker.net/p", "https://news.example/", host({ cookies: "none" })), false);
});

test("the top-level page of a request is found from its frame, the tab or the referrer", () => {
  assert.equal(topUrlOf({ resourceType: "mainFrame", url: "https://a.example/" }), "https://a.example/");
  assert.equal(topUrlOf({ resourceType: "script", url: "https://x/", frame: { top: { url: "https://top.example/" } } }), "https://top.example/");
  assert.equal(topUrlOf({ resourceType: "script", url: "https://x/", frame: { get top() { throw new Error("gone"); } }, webContents: { isDestroyed: () => false, getURL: () => "https://tab.example/" } }), "https://tab.example/");
  assert.equal(topUrlOf({ resourceType: "script", url: "https://x/", referrer: "https://ref.example/" }), "https://ref.example/");
});
