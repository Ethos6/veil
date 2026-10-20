// The browser around the pages: toolbar, tabs, windows, internal pages, downloads, permissions.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { launch, open, activePage, startServers, seen, tabState, until, sleep, waitForPage } from "./harness.js";

let servers, veil, app, ui;
const errors = [];
before(async () => {
  servers = await startServers();
  veil = await launch(servers.rules);
  ({ app, ui } = veil);
  ui.on("pageerror", (e) => errors.push(`ui: ${e.message}`));
  ui.on("console", (m) => m.type() === "error" && errors.push(`ui: ${m.text()}`));
});
after(async () => {
  await app?.close();
  servers?.close();
});

const tabs = () => app.evaluate(() => globalThis.veil.windows[0].tabs.map((t) => ({ id: t.id, url: t.url, title: t.title })));
const press = (keys) => ui.keyboard.press(keys);
/** Send a key the way the OS would (CDP key events skip Electron's before-input-event). */
const nativeKey = (keyCode, modifiers = []) => app.evaluate((_e, [k, m]) => {
  const wc = globalThis.veil.windows[0].ui.webContents;
  wc.sendInputEvent({ type: "keyDown", keyCode: k, modifiers: m });
  wc.sendInputEvent({ type: "keyUp", keyCode: k, modifiers: m });
}, [keyCode, modifiers]);
const mod = process.platform === "darwin" ? "Meta" : "Control";

test("starts on the new tab page with the address bar focused and stats shown", async () => {
  const page = await activePage(app, (u) => u.startsWith("veil://newtab"));
  await page.waitForSelector("#s-blocked");
  assert.match(await page.textContent(".foot"), /filters loaded/);
  await until(() => ui.evaluate(() => document.activeElement?.id === "address"), 5000, "address bar focus");
  assert.equal(await ui.inputValue("#address"), "");
  assert.equal(await page.evaluate(() => typeof window.veil?.call), "function", "Veil's own pages get the page API");
});

test("typing an address opens it over HTTPS; words search with the chosen engine", async () => {
  await ui.click("#address");
  await ui.fill("#address", "site.test");
  await ui.waitForSelector("#suggestions:not([hidden]) .row");
  assert.match(await ui.textContent("#suggestions .row.sel"), /https:\/\/site\.test\//);
  await press("Enter");
  await activePage(app, (u) => u === "https://site.test/");
  await until(async () => (await ui.inputValue("#address")) === "site.test", 4000, "pretty URL");
  assert.equal(await ui.isHidden("#suggestions"), true);

  await ui.click("#address");
  await ui.fill("#address", "privacy browser");
  await ui.waitForSelector("#suggestions:not([hidden])");
  assert.match(await ui.textContent("#suggestions .row.sel"), /Search with DuckDuckGo/);
  await press("Enter");
  await until(async () => (await tabState(app)).url.startsWith("https://duckduckgo.com/?q=privacy+browser"), 8000, "search URL");
});

test("history suggestions appear as you type, from local history only", async () => {
  await open(app, "https://other.test/notes/page-one");
  await ui.click("#address");
  await ui.fill("#address", "page-o");
  await ui.waitForSelector("#suggestions:not([hidden])");
  await until(async () => /other\.test\/notes\/page-one/.test(await ui.textContent("#suggestions")), 3000, "history suggestion");
  await press("Escape");
  await press("Escape");
});

test("tabs: new, switch, close and reopen with the keyboard and the mouse", async () => {
  const start = (await tabs()).length;
  await ui.click("#newtab");
  await until(async () => (await tabs()).length === start + 1, 3000, "new tab");
  await ui.fill("#address", "other.test/second");
  await press("Enter");
  await until(async () => (await tabState(app)).url === "https://other.test/second", 8000, "second tab loaded");
  // switch with Ctrl+1
  if (process.platform !== "darwin") {
    await nativeKey("1", ["control"]);
    await until(async () => (await tabState(app)).id === (await tabs())[0].id, 3000, "first tab active");
    await nativeKey("Tab", ["control"]);
    await until(async () => (await tabState(app)).url === "https://other.test/second", 3000, "next tab");
    // close and reopen
    await nativeKey("w", ["control"]);
    await until(async () => (await tabs()).length === start, 3000, "tab closed");
    await nativeKey("t", ["control", "shift"]);
    await until(async () => (await tabs()).some((t) => t.url === "https://other.test/second"), 5000, "tab reopened");
  }
  // close with the tab's x button
  const n = (await tabs()).length;
  await ui.click(".tab.active .x");
  await until(async () => (await tabs()).length === n - 1, 3000, "closed by mouse");
});

test("pop-ups without a click are blocked with a notice; links with target=_blank open tabs", async () => {
  const before = (await tabs()).length;
  const page = await open(app, "https://site.test/popup");
  await ui.waitForSelector(".infobar >> text=Pop-up blocked");
  assert.equal((await tabs()).length, before, "no tab was opened");
  assert.equal(await page.evaluate(() => window.__popup), null);
  // "Open it" from the notice
  await ui.click(".infobar >> text=Open it");
  await until(async () => (await tabs()).some((t) => t.url === "https://other.test/?auto"), 4000, "blocked pop-up opened on request");
  await app.evaluate(() => { const w = globalThis.veil.windows[0]; w.activate(w.tabs.find((t) => t.url.endsWith("/popup"))); });
  await page.click("#link");
  await until(async () => (await tabs()).length === before + 2, 4000, "link opened a tab");
  await app.evaluate(() => { const w = globalThis.veil.windows[0]; for (const t of [...w.tabs].slice(1)) w.closeTab(t); });
});

test("web pages can't reach Veil's internal pages or API", async () => {
  const page = await open(app, "https://site.test/internal-link");
  assert.equal(await page.evaluate(() => window.__veil), "undefined");
  await page.click("#go", { noWaitAfter: true });
  await sleep(600);
  assert.equal((await tabState(app)).url, "https://site.test/internal-link");
  const framed = await page.evaluate(() => new Promise((r) => {
    const f = document.createElement("iframe");
    f.src = "veil://settings/";
    f.onload = () => { try { r(f.contentDocument ? "readable" : "opaque"); } catch { r("opaque"); } };
    setTimeout(() => r("blocked"), 1500);
    document.body.append(f);
  }));
  assert.notEqual(framed, "readable");
  const fetched = await page.evaluate(() => fetch("veil://settings/").then(() => "ok", () => "failed"));
  assert.equal(fetched, "failed");
});

test("find in page highlights and counts matches", async () => {
  await open(app, "https://other.test/find");
  await app.evaluate(() => globalThis.veil.runAction(globalThis.veil.windows[0], "find"));
  await ui.waitForSelector("#findbar:not([hidden])");
  await ui.fill("#find-input", "apple");
  await until(async () => /\/3$/.test(await ui.textContent("#find-count")), 4000, "3 matches");
  await ui.press("#find-input", "Enter");
  await until(async () => (await ui.textContent("#find-count")) === "2/3", 4000, "second match");
  await ui.press("#find-input", "Escape");
  await until(() => ui.isHidden("#findbar"), 3000, "find bar closed");
});

test("bookmarks: the star adds one, the bookmarks page lists and removes it", async () => {
  await open(app, "https://other.test/bookmark-me");
  await until(async () => !(await ui.isHidden("#star")), 3000, "star visible");
  await ui.click("#star");
  await until(async () => (await ui.getAttribute("#star", "class")).includes("on"), 3000, "starred");
  const page = await open(app, "veil://bookmarks/");
  await page.waitForSelector(".entry");
  assert.match(await page.textContent("#list"), /other\.test/);
  await page.hover(".entry");
  await page.click(".entry button[title=Delete]");
  await page.waitForSelector(".empty");
});

test("history page lists visits and can remove them; private windows record nothing", async () => {
  await open(app, "https://other.test/remember-me");
  const page = await open(app, "veil://history/");
  await page.waitForSelector(".entry");
  assert.match(await page.textContent("#list"), /remember-me|other\.test/);
  await page.fill("#q", "remember-me");
  await until(async () => (await page.$$(".entry")).length === 1, 3000, "search filters history");
  await page.hover(".entry");
  await page.click(".entry .x");
  await page.waitForSelector(".empty");

  // Private window: separate cookies, nothing written to history
  await open(app, "https://other.test/set-cookie");
  await app.evaluate(() => globalThis.veil.newWindow({ private: true, url: "https://other.test/private-visit" }));
  await until(() => app.evaluate(() => globalThis.veil.windows.length === 2), 3000, "private window");
  await until(() => seen.some((s) => s.path === "/private-visit"), 5000, "private visit loaded");
  const req = seen.filter((s) => s.path === "/private-visit").pop();
  assert.equal(req.headers.cookie, undefined, "the private window doesn't see normal cookies");
  const hist = await app.evaluate(() => globalThis.veil.historyStore.data.entries.map((e) => e.url));
  assert.ok(hist.every((u) => u !== "https://other.test/private-visit"));
  const privUi = await waitForPage(app, (u) => u.startsWith("veil://ui/?private=1"));
  await privUi.waitForSelector("#private-badge:not([hidden])");
  await app.evaluate(() => globalThis.veil.windows[1].window.close());
  await until(() => app.evaluate(() => globalThis.veil.windows.length === 1), 3000, "private window closed");
});

test("settings: changes apply immediately and are saved", async () => {
  const page = await open(app, "veil://settings/");
  await page.waitForSelector("#search select");
  await page.selectOption("#search select", "brave");
  await until(() => app.evaluate(() => globalThis.veil.settings.searchEngine === "brave"), 3000, "engine saved");
  await app.evaluate(() => globalThis.veil.settingsStore.flush());
  const saved = JSON.parse(fs.readFileSync(path.join(veil.profile, "settings.json"), "utf8"));
  assert.equal(saved.searchEngine, "brave");
  // The filter list section reports what's loaded
  assert.match(await page.textContent("#lists"), /network and .* cosmetic filters/);
  // A page can't set unknown keys
  const err = await page.evaluate(() => window.veil.call("settings.set", "__proto__", 1).then(() => "ok", (e) => e.message));
  assert.match(err, /unknown setting/);
  await page.selectOption("#search select", "duckduckgo");
});

test("downloads are saved to the download folder and listed", async () => {
  const page = await open(app, "https://other.test/files");
  await page.click("#dl");
  const file = path.join(veil.downloads, "hello.txt");
  await until(() => fs.existsSync(file) && fs.readFileSync(file, "utf8") === "hello from veil", 8000, "download saved");
  await until(async () => !(await ui.isHidden("#downloads")), 3000, "downloads button");
  const dl = await open(app, "veil://downloads/");
  await dl.waitForSelector("text=hello.txt");
  // Same name again gets a new file, not an overwrite
  const again = await open(app, "https://other.test/files");
  await again.click("#dl");
  await until(() => fs.existsSync(path.join(veil.downloads, "hello (1).txt")), 8000, "second download");
});

test("permission requests ask first and remember the answer", async () => {
  const page = await open(app, "https://site.test/perm");
  await ui.waitForSelector(".infobar >> text=wants to show notifications");
  await ui.click(".infobar >> text=Block");
  assert.equal(await page.evaluate(() => window.__perm), "denied");
  const again = await open(app, "https://site.test/perm");
  assert.equal(await again.evaluate(() => window.__perm), "denied");
  await sleep(300);
  assert.equal((await tabState(app)).infobars.length, 0, "no second prompt");
  const perms = await app.evaluate(() => globalThis.veil.siteStore.data.perms);
  assert.equal(perms["https://site.test"].notifications, "block");
});

test("network errors show Veil's error page, keeping the address", async () => {
  const page = await open(app, "https://nowhere.invalid/", { expect: (u) => u.startsWith("veil://error/") });
  assert.match(await page.textContent("h1"), /can't be reached/);
  assert.equal((await tabState(app)).url, "https://nowhere.invalid/");
  assert.match(await ui.inputValue("#address"), /nowhere\.invalid/);
});

test("the toolbar works at a narrow window width with many tabs", async () => {
  await app.evaluate(() => { const w = globalThis.veil.windows[0]; w.window.setSize(520, 600); for (let i = 0; i < 12; i++) w.newTab(); });
  await sleep(400);
  const overflow = await ui.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  assert.equal(overflow, false);
  const narrow = await ui.$$eval(".tab.narrow", (els) => els.length);
  assert.ok(narrow > 0, "tabs shrink to icons");
  await app.evaluate(() => { const w = globalThis.veil.windows[0]; for (const t of [...w.tabs].slice(1)) w.closeTab(t); w.window.setSize(1280, 860); });
});

test("no errors in the toolbar", () => {
  assert.deepEqual(errors, []);
});
