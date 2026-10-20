// Regression tests for problems found in review: each one failed before its fix.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { launch, open, load, evalTab, clickTab, startServers, seen, tabState, until, sleep } from "./harness.js";

let servers, veil, app, ui;
before(async () => {
  servers = await startServers();
  veil = await launch(servers.rules);
  ({ app, ui } = veil);
});
after(async () => {
  await app?.close();
  servers?.close();
});

const tabs = () => app.evaluate(() => globalThis.veil.windows[0].tabs.map((t) => t.url));
const closeExtraTabs = () => app.evaluate(() => { const w = globalThis.veil.windows[0]; for (const t of [...w.tabs].slice(1)) w.closeTab(t); });

test("third-party cookies can't be read through a script-made frame (blocked in Chromium itself)", async () => {
  await open(app, "https://other.test/set-cookie");
  const page = await open(app, "https://site.test/embed?src=" + encodeURIComponent("https://other.test/cookie-escape"));
  const m = await page.evaluate(() => window.__msg);
  assert.equal(m.direct, "");
  assert.equal(m.viaBlankFrame, "");
});

test("a third-party service worker's requests carry no cookies", async () => {
  const page = await open(app, "https://site.test/embed?src=" + encodeURIComponent("https://other.test/sw-frame"));
  await page.evaluate(() => window.__msg);
  const r = await until(() => seen.find((s) => s.path === "/from-sw"), 6000, "service worker request");
  assert.equal(r.headers.cookie, undefined);
});

test("fingerprint protection covers frames reached by index, and looks native", async () => {
  const page = await open(app, "https://site.test/fp-frames");
  const r = await page.evaluate(() => window.__r);
  assert.deepEqual(r, { sameAsFrames: true, sameAsAppended: true, enumerable: true, writable: true });
});

test("the HTTPS fallback survives a cleaned-up URL", async () => {
  const err = await open(app, "http://insecure.test/?utm_source=x&id=1", { expect: (u) => u.startsWith("veil://error/") });
  assert.match(err.url(), /type=https/);
  await err.click("text=Continue to HTTP site");
  await until(async () => (await tabState(app)).url.startsWith("http://insecure.test/"), 5000, "HTTP page");
});

test("a pop-up can't open more windows without a click", async () => {
  await load(app, "https://site.test/opener");
  await clickTab(app, "#b");
  await until(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((w) => w.webContents.getURL() === "https://other.test/spammer")), 5000, "pop-up window");
  await sleep(1000);
  assert.deepEqual((await tabs()).filter((u) => u.includes("/spam")), []);
  await app.evaluate(({ BrowserWindow }) => { for (const w of BrowserWindow.getAllWindows()) if (w.webContents.getURL().includes("spammer")) w.close(); });
});

test("target=_blank forms keep their POST body, and window.open() returns a usable window", async () => {
  await load(app, "https://site.test/post-form");
  await clickTab(app, "#go");
  await until(() => seen.some((s) => s.path === "/posted" && s.headers["content-length"] === "3"), 5000, "POST in new tab");
  await until(async () => (await tabs()).includes("https://other.test/posted"), 5000, "posted tab");
  await app.evaluate(() => { const w = globalThis.veil.windows[0]; w.activate(w.tabs.find((t) => t.url.endsWith("/post-form"))); });
  await clickTab(app, "#w");
  await until(async () => (await tabs()).includes("https://other.test/written"), 5000, "window navigated by its opener");
  await app.evaluate(() => { const w = globalThis.veil.windows[0]; w.activate(w.tabs.find((t) => t.url.endsWith("/post-form"))); });
  assert.equal(await evalTab(app, "window.__isWindow"), true);
  await closeExtraTabs();
});

test("web pages can't load Veil's internal files", async () => {
  await load(app, "https://site.test/probe-veil");
  assert.deepEqual(await evalTab(app, "window.__probe"), ["blocked", "blocked", "blocked"]);
  assert.equal(await evalTab(app, "typeof window.V"), "undefined");
});

test("two downloads with the same name at once get two files", async () => {
  await load(app, "https://site.test/two-downloads");
  await clickTab(app, "#a");
  await clickTab(app, "#b");
  await until(() => fs.existsSync(path.join(veil.downloads, "same.txt")) && fs.existsSync(path.join(veil.downloads, "same (1).txt")), 8000, "both files");
  await sleep(1200);
  const contents = ["same.txt", "same (1).txt"].map((f) => fs.readFileSync(path.join(veil.downloads, f), "utf8")).sort();
  assert.deepEqual(contents, ["part-1-done", "part-2-done"]);
});

test("a download a page starts by itself waits for permission", async () => {
  const before = fs.readdirSync(veil.downloads).length;
  await app.evaluate(() => { globalThis.veil.windows[0].active.lastInput = 0; });
  await load(app, "https://other.test/auto-download");
  await until(async () => (await tabState(app)).infobars.some((b) => /wants to download hello\.txt/.test(b.text)), 6000, "download prompt");
  await sleep(500);
  assert.equal(fs.readdirSync(veil.downloads).filter((f) => !f.endsWith(".crdownload")).length, before);
  await ui.click(".infobar button.primary");
  await until(async () => (await tabState(app)).infobars.length === 0, 3000, "prompt answered");
  await until(() => fs.readdirSync(veil.downloads).some((f) => f.startsWith("hello")), 6000, "download allowed");
});

test("private windows don't show in, or leak to, normal windows", async () => {
  await app.evaluate(() => globalThis.veil.newWindow({ private: true, url: "https://other.test/files" }));
  await until(() => app.evaluate(() => globalThis.veil.windows.length === 2), 3000, "private window");
  await until(() => app.evaluate(() => globalThis.veil.windows[1].active.url === "https://other.test/files"), 5000, "loaded");
  await app.evaluate(async () => {
    const t = globalThis.veil.windows[1].active;
    t.lastInput = Date.now();
    await t.wc.executeJavaScript("document.getElementById('dl').click()", true);
  });
  await until(() => app.evaluate(() => [...globalThis.veil.downloads.values()].some((d) => d.private && d.state === "completed")), 6000, "private download");
  const normal = await app.evaluate(() => globalThis.veil.downloadsSummary(globalThis.veil.mainSession).recent.map((d) => d.private));
  assert.ok(!normal.includes(true), "the normal window doesn't list private downloads");
  // A permission granted in private is forgotten with the window
  await app.evaluate(() => { const w = globalThis.veil.windows[1]; globalThis.__privSession = w.session; globalThis.veil.setPerm("https://site.test", "notifications", "allow", w.session); w.window.close(); });
  await until(() => app.evaluate(() => globalThis.veil.windows.length === 1), 3000, "closed");
  assert.equal(await app.evaluate(() => globalThis.veil.ephemeral.has(globalThis.__privSession)), false);
  assert.equal(await app.evaluate(() => [...globalThis.veil.downloads.values()].some((d) => d.private)), false);
});

test("a page's own Back link can return to the new tab page", async () => {
  await open(app, "veil://newtab/");
  const page = await open(app, "https://other.test/back");
  await page.evaluate(() => history.back());
  await until(async () => (await tabState(app)).url === "", 4000, "back on the new tab page");
});

test("a bad value in settings.json doesn't stop Veil from starting", async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "veil-bad-"));
  fs.writeFileSync(path.join(profile, "settings.json"), JSON.stringify({ theme: "bogus", cookies: 7, searchEngine: "nope", webrtc: "x" }));
  const other = await launch(servers.rules, { profile });
  const s = await other.app.evaluate(() => globalThis.veil.settings);
  assert.equal(s.theme, "system");
  assert.equal(s.searchEngine, "duckduckgo");
  assert.equal(s.cookies, "cross-site");
  await other.app.close();
});
