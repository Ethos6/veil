import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Blocker, countRules, looksLikeFilterList, redirectResource } from "../../src/main/blocker.js";

const FIX = path.join(import.meta.dirname, "..", "fixtures");
const filters = fs.readFileSync(path.join(FIX, "filters.txt"), "utf8");
const resources = fs.readFileSync(path.join(FIX, "resources.json"), "utf8");

function loaded() {
  const b = new Blocker({ lists: [] });
  b.loadText(filters, resources);
  return b;
}

test("network rules block, respect $third-party, and redirect to neutered resources", () => {
  const b = loaded();
  assert.equal(b.match({ url: "https://ads.test/ad.js", type: "script", sourceUrl: "https://site.test/" }).block, true);
  assert.equal(b.match({ url: "https://tracker.test/t.js", type: "script", sourceUrl: "https://site.test/" }).block, true);
  assert.equal(b.match({ url: "https://tracker.test/t.js", type: "script", sourceUrl: "https://tracker.test/" }).block, false, "first party");
  assert.equal(b.match({ url: "https://cdn.site.test/app.js", type: "script", sourceUrl: "https://site.test/" }).block, false);
  const r = b.match({ url: "https://redirect.test/lib.js", type: "script", sourceUrl: "https://site.test/" });
  assert.equal(r.redirect, `veil-res://${b.token}/noop.js`);
  const res = redirectResource(b, r.redirect);
  assert.equal(res.type, "application/javascript");
  assert.match(res.body.toString(), /__noop/);
  assert.equal(redirectResource(b, `veil-res://${b.token}/unknown.js`), null);
  assert.equal(redirectResource(b, "veil-res://guess/noop.js"), null, "the per-run token is required");
  // Electron's fetch() resource type is matched like XHR
  assert.equal(b.match({ url: "https://ads.test/x", type: "fetch", sourceUrl: "https://site.test/" }).block, true);
  // main frames are never blocked by match(); see matchDocument
  assert.equal(b.match({ url: "https://ads.test/", type: "mainFrame" }).block, false);
});

test("whole pages are blocked only by $document or whole-host rules", () => {
  const b = new Blocker({ lists: [] });
  b.loadText("||scam.example^$document\n||adhost.example^\n/banner/*\n||cdn.example^$script\n||x.example/path\n");
  assert.equal(b.matchDocument("https://scam.example/login").block, true);
  assert.equal(b.matchDocument("https://adhost.example/").block, true);
  assert.equal(b.matchDocument("https://news.example/banner/today").block, false, "a path pattern never blocks a page");
  assert.equal(b.matchDocument("https://cdn.example/").block, false, "type-limited rules don't block pages");
  assert.equal(b.matchDocument("https://x.example/path").block, false);
  assert.equal(b.matchDocument("https://fine.example/").block, false);
});

test("cosmetic rules: generic and site-specific hiding, and scriptlets on the first call only", () => {
  const b = loaded();
  const first = b.cosmetics({ url: "https://site.test/", first: true });
  assert.match(first.styles, /#cookie-notice/);
  assert.equal(first.scripts.length, 1);
  assert.match(first.scripts[0], /veilMark/);
  const other = b.cosmetics({ url: "https://other.test/", first: true });
  assert.doesNotMatch(other.styles, /#cookie-notice/);
  assert.equal(other.scripts.length, 0);
  const dom = b.cosmetics({ url: "https://other.test/", first: false, classes: ["ad-banner", "x"], ids: [], hrefs: [] });
  assert.match(dom.styles, /\.ad-banner/);
  assert.deepEqual(b.cosmetics({ url: "about:blank", first: true }), { styles: "", scripts: [] });
});

test("$csp rules produce a policy for documents", () => {
  const b = loaded();
  assert.equal(b.csp({ url: "https://csp.test/", type: "mainFrame" }), "script-src 'none'");
  assert.equal(b.csp({ url: "https://site.test/", type: "mainFrame" }), undefined);
});

test("updating falls back to the mirror, saves the engine, and loads it again", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "veil-blocker-"));
  const calls = [];
  const fakeFetch = async (url) => {
    calls.push(url);
    if (url.startsWith("https://up.example/")) return new Response("down", { status: 503 });
    if (url === "https://mirror.example/a.txt") return new Response("! list\n||ads.example^\n##.ad\n");
    if (url === "https://mirror.example/b1.txt") return new Response("||t1.example^\n");
    if (url === "https://mirror.example/b2.txt") return new Response("||t2.example^\n");
    if (url === "https://html.example/c.txt") return new Response("<!doctype html><html>captive portal</html>");
    if (url === "https://res.example/r.json") return new Response(resources);
    return new Response("", { status: 404 });
  };
  const lists = [
    { id: "a", name: "A", on: true, sources: [["https://up.example/a.txt"], ["https://mirror.example/a.txt"]] },
    { id: "b", name: "B", on: true, sources: [["https://mirror.example/b1.txt", "https://mirror.example/b2.txt"]] },
    { id: "c", name: "C", on: true, sources: [["https://html.example/c.txt"]] },
    { id: "d", name: "D", on: false, sources: [["https://up.example/d.txt"]] },
  ];
  const b = new Blocker({ lists, fetch: fakeFetch, resourcesUrl: "https://res.example/r.json", cacheFile: path.join(dir, "engine.bin") });
  const info = await b.update();
  assert.ok(info);
  assert.deepEqual(info.lists.map((l) => [l.id, l.ok]), [["a", true], ["b", true], ["c", false]]);
  assert.equal(info.lists[0].source, "mirror.example");
  assert.equal(info.resources, true);
  assert.ok(!calls.some((u) => u.includes("d.txt")), "disabled lists aren't downloaded");
  assert.equal(b.match({ url: "https://t2.example/x.js", type: "script", sourceUrl: "https://s.example/" }).block, true, "multi-part lists are joined");

  const again = new Blocker({ lists, cacheFile: path.join(dir, "engine.bin"), fetch: fakeFetch });
  assert.equal(again.load(), true);
  assert.equal(again.match({ url: "https://ads.example/x.js", type: "script", sourceUrl: "https://s.example/" }).block, true);
  assert.equal(again.info.networkFilters, info.networkFilters);

  // enabling D and failing everything keeps the old engine
  const failing = new Blocker({ lists, fetch: async () => new Response("", { status: 500 }), cacheFile: path.join(dir, "engine.bin") });
  failing.load();
  assert.equal(await failing.update({ d: true }), null);
  assert.equal(failing.match({ url: "https://ads.example/x.js", type: "script", sourceUrl: "https://s.example/" }).block, true);
});

test("concurrent updates share one download", async () => {
  let n = 0;
  const b = new Blocker({ lists: [{ id: "a", name: "A", on: true, sources: [["https://x.example/a"]] }], resourcesUrl: null, fetch: async () => { n++; await new Promise((r) => setTimeout(r, 20)); return new Response("||a.example^\n"); } });
  const [x, y] = await Promise.all([b.update(), b.update()]);
  assert.equal(x, y);
  assert.equal(n, 1);
});

test("a corrupt engine file is ignored", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "veil-blocker-"));
  fs.writeFileSync(path.join(dir, "engine.bin"), "garbage");
  const b = new Blocker({ cacheFile: path.join(dir, "engine.bin"), lists: [] });
  assert.equal(b.load(), false);
  assert.equal(b.match({ url: "https://ads.test/x", type: "script", sourceUrl: "https://s.test/" }).block, false);
});

test("filter list sanity checks", () => {
  assert.equal(looksLikeFilterList("<!DOCTYPE html><html><body>Sign in to Wi-Fi</body></html>"), false);
  assert.equal(looksLikeFilterList(""), false);
  assert.equal(looksLikeFilterList("! Title: x\n||ads.example^\n##.ad\n"), true);
  assert.equal(countRules("! comment\n[Adblock Plus 2.0]\n||a^\n##.b\n\n# hosts comment\n"), 2);
});
