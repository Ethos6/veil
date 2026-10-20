import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { JsonStore, mergeSettings, addVisit, normalizeHistory, HISTORY_LIMIT } from "../../src/main/store.js";
import { DEFAULT_SETTINGS, chromeUserAgent, LISTS } from "../../src/main/config.js";
import { resolveInternal } from "../../src/main/protocol.js";
import { matchShortcut, chordOf, ACTIONS } from "../../src/main/shortcuts.js";
import { uniquePath, newerVersion, topSites, parseBookmarkHtml, bookmarksToHtml } from "../../src/main/util.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "veil-unit-"));

test("settings merge keeps known keys of the right type only", () => {
  const s = mergeSettings(DEFAULT_SETTINGS, { searchEngine: "brave", httpsOnly: "yes", evil: 1, lists: { easylist: false }, __proto__: { polluted: true } });
  assert.equal(s.searchEngine, "brave");
  assert.equal(s.httpsOnly, true);
  assert.equal("evil" in s, false);
  assert.deepEqual(s.lists, { easylist: false });
  assert.equal(/** @type {any} */ ({}).polluted, undefined);
  assert.deepEqual(mergeSettings(DEFAULT_SETTINGS, null), DEFAULT_SETTINGS);
});

test("JSON stores write atomically and survive a corrupt file", () => {
  const dir = tmp();
  const file = path.join(dir, "s.json");
  const st = new JsonStore(file, () => ({ a: 1 }));
  st.data.a = 2;
  st.flush();
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { a: 2 });
  assert.deepEqual(fs.readdirSync(dir), ["s.json"]);
  fs.writeFileSync(file, "{not json");
  const st2 = new JsonStore(file, () => ({ a: 1 }));
  assert.deepEqual(st2.data, { a: 1 });
  assert.ok(fs.readdirSync(dir).some((f) => f.startsWith("s.json.corrupt-")), "the unreadable file is kept aside");
});

test("history keeps one entry per URL, newest first, capped", () => {
  const h = normalizeHistory({ entries: [{ url: "https://a/" , title: "A", visits: 1, last: 1 }, null, { nope: 1 }] });
  assert.equal(h.entries.length, 1);
  addVisit(h, "https://b/", "B", 10);
  addVisit(h, "https://a/", "", 20);
  assert.deepEqual(h.entries.map((e) => [e.url, e.visits, e.title]), [["https://a/", 2, "A"], ["https://b/", 1, "B"]]);
  for (let i = 0; i < HISTORY_LIMIT + 5; i++) h.entries.push({ url: `https://x/${i}`, title: "", visits: 1, last: 0 });
  addVisit(h, "https://new/", "N");
  assert.equal(h.entries.length, HISTORY_LIMIT);
});

test("the user agent is a plain Chrome one for each platform", () => {
  assert.equal(chromeUserAgent("win32", "152.0.7977.167"), "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36");
  assert.match(chromeUserAgent("darwin", "152.1"), /Macintosh; Intel Mac OS X 10_15_7.*Chrome\/152\.0\.0\.0/);
  assert.match(chromeUserAgent("linux", "152.1"), /X11; Linux x86_64/);
});

test("filter lists all have an upstream and a fallback source", () => {
  for (const l of LISTS) {
    assert.ok(l.sources.length >= 2, l.id);
    for (const parts of l.sources) for (const u of parts) assert.match(u, /^https:\/\//);
  }
  assert.equal(new Set(LISTS.map((l) => l.id)).size, LISTS.length);
});

test("veil:// URLs map to files inside the app and nowhere else", () => {
  const root = "/app/src";
  assert.equal(resolveInternal(root, "veil://settings/"), path.resolve("/app/src/pages/settings.html"));
  assert.equal(resolveInternal(root, "veil://settings/settings.js"), path.resolve("/app/src/pages/settings.js"));
  assert.equal(resolveInternal(root, "veil://newtab/common.css"), path.resolve("/app/src/pages/common.css"));
  assert.equal(resolveInternal(root, "veil://ui/"), path.resolve("/app/src/ui/index.html"));
  const inside = (r, dir) => r === null || r.startsWith(path.resolve(root, dir) + path.sep);
  assert.ok(inside(resolveInternal(root, "veil://ui/%2e%2e/main/main.js"), "ui"), "dot segments can't leave the folder");
  assert.ok(inside(resolveInternal(root, "veil://ui/../../package.json"), "ui"));
  assert.equal(resolveInternal(root, "veil://settings/..%2f..%2fpackage.json"), null);
  assert.equal(resolveInternal(root, "veil://settings/%00x"), null);
  assert.equal(resolveInternal(root, "veil://evil/"), null);
  assert.equal(resolveInternal(root, "https://settings/"), null);
});

test("shortcuts match by physical key", () => {
  const k = (key, code, mods = {}) => matchShortcut({ type: "keyDown", key, code, ...mods });
  assert.equal(k("t", "KeyT", { control: true })?.id, "newTab");
  assert.equal(k("T", "KeyT", { control: true, shift: true })?.id, "reopenTab");
  assert.equal(k("!", "Digit1", { control: true, shift: false })?.arg, 0);
  assert.equal(k("ArrowLeft", "ArrowLeft", { alt: true })?.id, "back");
  assert.equal(k("F5", "F5")?.id, "reload");
  assert.equal(k("+", "Equal", { control: true, shift: true })?.id, "zoomIn");
  assert.equal(k("t", "KeyT"), null, "plain typing isn't a shortcut");
  assert.equal(matchShortcut({ type: "keyUp", key: "t", code: "KeyT", control: true }), null);
  assert.equal(chordOf({ key: "л", code: "KeyK", control: true }), "mod+k", "non-Latin layouts still work");
  const macAccels = ACTIONS.map((a) => a.mac).filter(Boolean);
  assert.equal(new Set(macAccels).size, macAccels.length, "no duplicate macOS accelerators");
});

test("download names never overwrite or escape the folder", () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "report.pdf"), "");
  fs.writeFileSync(path.join(dir, "report (1).pdf"), "");
  assert.equal(uniquePath(dir, "report.pdf"), path.join(dir, "report (2).pdf"));
  assert.equal(path.dirname(uniquePath(dir, "../../etc/passwd")), dir);
  assert.equal(path.basename(uniquePath(dir, "..")), "_");
  assert.equal(path.basename(uniquePath(dir, "")), "download");
  assert.equal(path.basename(uniquePath(dir, "a:b*c?.txt")), "a_b_c_.txt");
});

test("version comparison", () => {
  assert.equal(newerVersion("1.2.0", "1.1.9"), true);
  assert.equal(newerVersion("1.10.0", "1.9.0"), true);
  assert.equal(newerVersion("1.0.0", "1.0.0"), false);
  assert.equal(newerVersion("0.9.9", "1.0.0"), false);
  assert.equal(newerVersion("garbage", "1.0.0"), false);
});

test("top sites: one per site, visited at least twice, most visited first", () => {
  const e = [
    { url: "https://www.a.com/x/y", title: "A deep", visits: 3, last: 1 },
    { url: "https://www.a.com/", title: "A", visits: 2, last: 1 },
    { url: "https://b.com/", title: "B", visits: 1, last: 1 },
    { url: "https://c.org/p", title: "C", visits: 9, last: 1 },
  ];
  assert.deepEqual(topSites(e, 8).map((s) => s.url), ["https://c.org/", "https://www.a.com/"]);
});

test("bookmarks import from browser exports and export back", () => {
  const html = `<!DOCTYPE NETSCAPE-Bookmark-file-1><DL><p><DT><H3>Folder</H3><DL><p>
    <DT><A HREF="https://example.com/?a=1&amp;b=2" ADD_DATE="1">Example &amp; Co</A>
    <DT><A HREF="javascript:alert(1)">bad</A>
    <DT><A HREF="https://x.org/">&#60;b&#62;</A></DL></DL>`;
  const items = parseBookmarkHtml(html);
  assert.deepEqual(items, [{ url: "https://example.com/?a=1&b=2", title: "Example & Co" }, { url: "https://x.org/", title: "<b>" }]);
  const out = bookmarksToHtml(items.map((b, i) => ({ ...b, added: i * 1000 })));
  assert.match(out, /HREF="https:\/\/example\.com\/\?a=1&amp;b=2"/);
  assert.match(out, />&lt;b&gt;</);
  assert.deepEqual(parseBookmarkHtml(out), items, "round trip");
});
