// Shields end to end: real requests through Veil's pipeline to local test sites.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, open, activePage, startServers, seen, tabState, until, sleep } from "./harness.js";

let servers, veil;
before(async () => {
  servers = await startServers();
  veil = await launch(servers.rules);
});
after(async () => {
  await veil?.app.close();
  servers?.close();
});

test("Veil identifies as plain Chrome, with no Electron or app name", async () => {
  const page = await open(veil.app, "https://other.test/ua");
  const ua = await page.evaluate(() => navigator.userAgent);
  assert.match(ua, /Chrome\/\d+\.0\.0\.0 Safari\/537\.36$/);
  assert.doesNotMatch(ua, /Electron|Veil/i);
  const brands = await page.evaluate(() => navigator.userAgentData.brands.map((b) => b.brand).join(","));
  assert.doesNotMatch(brands, /Electron/);
  const req = seen.filter((s) => s.host === "other.test" && s.path === "/ua").pop();
  assert.doesNotMatch(req.headers["user-agent"], /Electron|Veil/i);
});

test("ads and third-party trackers are blocked, scriptlets run first, redirects neuter scripts", async () => {
  const before = seen.length;
  const page = await open(veil.app, "https://site.test/");
  const r = await page.evaluate(() => ({ ad: window.__adLoaded, tracked: window.__tracked, noop: window.__noop, real: window.__libReal, marked: window.__marked, early: window.__early }));
  assert.equal(r.ad, undefined, "ad script must not load");
  assert.equal(r.tracked, undefined, "third-party tracker must not load");
  assert.equal(r.noop, true, "redirect rule serves the neutered script");
  assert.equal(r.real, undefined);
  assert.equal(r.marked, "scriptlet ran before page scripts: true");
  assert.equal(r.early, "scriptlet ran before page scripts: true", "the page's first script already sees the scriptlet's effect");
  const hosts = seen.slice(before).map((s) => s.host);
  assert.ok(!hosts.includes("ads.test") && !hosts.includes("tracker.test") && !hosts.includes("redirect.test"), `blocked requests never reach the network (saw ${hosts})`);
  // Cosmetic filters: generic (.ad-banner) and site-specific (#cookie-notice)
  const display = await page.evaluate(() => ["ad", "cookie-notice", "content"].map((id) => getComputedStyle(document.getElementById(id)).display));
  assert.deepEqual(display, ["none", "none", "block"]);
  const st = await until(async () => { const s = await tabState(veil.app); return s.blocked >= 3 && s; }, 5000, "blocked count");
  assert.ok(st.blocked >= 3);
  // The toolbar shows the count on the Shields button
  await until(async () => (await veil.ui.textContent("#shield-count")) === String(st.blocked), 3000, "toolbar badge");
});

test("first-party tracker hosts are not blocked by a $third-party rule", async () => {
  const page = await open(veil.app, "https://tracker.test/");
  assert.match(await page.textContent("body"), /__tracked/);
});

test("Shields can be turned off for one site from the toolbar", async () => {
  await open(veil.app, "https://site.test/");
  await veil.ui.click("#shields");
  await veil.ui.waitForSelector("#shields-panel:not([hidden]) .sh-head");
  assert.match(await veil.ui.textContent("#shields-panel"), /site\.test.*Shields are UP/s);
  assert.match(await veil.ui.textContent("#shields-panel"), /Blocked from \d+ domains?/);
  await veil.ui.click("#shields-panel .sh-head .switch");
  const page = await activePage(veil.app, (u) => u === "https://site.test/");
  await until(() => page.evaluate(() => window.__adLoaded === true), 8000, "ads load with shields down");
  assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById("ad")).display), "block");
  await veil.ui.keyboard.press("Escape");
  // back on
  await veil.ui.click("#shields");
  await veil.ui.click("#shields-panel .sh-head .switch");
  await veil.ui.keyboard.press("Escape");
  await sleep(500);
  const again = await activePage(veil.app, (u) => u === "https://site.test/");
  await until(() => again.evaluate(() => document.readyState === "complete" && window.__adLoaded === undefined), 8000, "ads blocked again");
});

test("Global Privacy Control is sent and visible to pages", async () => {
  const page = await open(veil.app, "https://site.test/");
  assert.equal(await page.evaluate(() => window.__gpc), true);
  const req = seen.filter((s) => s.host === "site.test" && s.path === "/").pop();
  assert.equal(req.headers["sec-gpc"], "1");
});

test("third-party cookies are blocked, first-party cookies work", async () => {
  // Visit other.test directly: it may set its cookie as a first party.
  await open(veil.app, "https://other.test/set-cookie");
  await open(veil.app, "https://other.test/check");
  const firstParty = seen.filter((s) => s.host === "other.test" && s.path === "/check").pop();
  assert.match(firstParty.headers.cookie || "", /c_other=1/);
  // Embedded in site.test, other.test gets no cookies, and can't set or read them by script.
  const page = await open(veil.app, "https://site.test/");
  const frame = await page.evaluate(() => window.__frame);
  assert.equal(frame.frameCookie, "", "document.cookie is empty in a third-party frame");
  assert.equal(frame.gpc, true, "GPC applies inside frames too");
  const embedded = seen.filter((s) => s.host === "other.test" && s.path === "/frame").pop();
  assert.equal(embedded.headers.cookie, undefined, "no cookie header to a third party");
});

test("http:// is upgraded to https://, and sites without HTTPS get a warning first", async () => {
  await open(veil.app, "http://secure.test/page", { expect: (u) => u.startsWith("https://secure.test/") });
  assert.equal((await tabState(veil.app)).url, "https://secure.test/page");
  const last = seen.filter((s) => s.host === "secure.test").pop();
  assert.equal(last.proto, "https");

  const err = await open(veil.app, "http://insecure.test/", { expect: (u) => u.startsWith("veil://error/") });
  assert.match(await err.textContent("h1"), /doesn't support a secure connection/);
  assert.equal((await tabState(veil.app)).url, "http://insecure.test/", "the address bar keeps showing the site");
  await err.click("text=Continue to HTTP site");
  const page = await activePage(veil.app, (u) => u === "http://insecure.test/");
  assert.equal(await page.title(), "insecure.test");
  const st = await tabState(veil.app);
  assert.equal(st.secure, "insecure");
  // Back goes to the page before, not to the failed attempt
  assert.equal(st.canBack, true);
});

test("a site that redirects back to http stops with the warning instead of looping", async () => {
  const err = await open(veil.app, "http://loop.test/to-http", { expect: (u) => u.startsWith("veil://error/") });
  // https://loop.test/to-http redirects to http://loop.test/, which would be upgraded again.
  assert.ok(err.url().startsWith("veil://error/?type=https"), err.url());
  assert.match(await err.textContent("h1"), /doesn't support a secure connection/);
});

test("tracking parameters are removed before the page loads", async () => {
  await open(veil.app, "https://other.test/article?utm_source=news&id=5&fbclid=abc&gclid=x", { expect: (u) => u.startsWith("https://other.test/article") });
  assert.equal((await tabState(veil.app)).url, "https://other.test/article?id=5");
  const req = seen.filter((s) => s.host === "other.test" && s.path.startsWith("/article")).pop();
  assert.equal(req.path, "/article?id=5", "the server never saw the tracking parameters");
});

test("known scam pages are stopped with a warning that can be bypassed", async () => {
  const err = await open(veil.app, "https://scam.test/win", { expect: (u) => u.startsWith("veil://error/") });
  assert.match(await err.textContent("h1"), /Veil blocked this page/);
  assert.match(await err.textContent("#detail"), /scam\.test/);
  assert.ok(!seen.some((s) => s.host === "scam.test"), "the page was never requested");
  await err.click("text=Proceed anyway");
  const page = await activePage(veil.app, (u) => u === "https://scam.test/win");
  assert.equal(await page.title(), "scam.test");
});

test("$csp filters add a policy to the page", async () => {
  const page = await open(veil.app, "https://csp.test/");
  // Inline script on the default page is blocked by script-src 'none'; the h1 is still there.
  assert.equal(await page.textContent("h1"), "csp.test");
  const ran = await page.evaluate(() => { try { return eval("1"); } catch { return "blocked"; } }).catch(() => "blocked");
  assert.ok(ran === "blocked" || ran === 1); // evaluate itself bypasses CSP; the header check is below
  const hdr = await veil.app.evaluate(async ({ webContents }) => {
    const wc = webContents.getAllWebContents().find((w) => w.getURL() === "https://csp.test/");
    return wc.executeJavaScript("(() => { try { new Function('return 1')(); return 'allowed'; } catch { return 'blocked'; } })()");
  });
  assert.equal(hdr, "blocked");
});

test("fingerprinting readouts are randomised per site but stable within a site", async () => {
  const a = await (await open(veil.app, "https://site.test/fp")).evaluate(() => window.__fp);
  const b = await (await open(veil.app, "https://other.test/fp")).evaluate(() => window.__fp);
  const a2 = await (await open(veil.app, "https://site.test/fp")).evaluate(() => window.__fp);
  assert.equal(a.a, a.b, "same canvas twice on one page gives the same result");
  assert.equal(a.a, a2.a, "same site, same session: same result");
  assert.notEqual(a.a, b.a, "different sites see different canvases");
  assert.notEqual(a.pixels, b.pixels, "getImageData differs per site too");
  assert.equal(a.frame, a.a, "a script-made same-origin frame is protected the same way");
  assert.equal(a.battery, "undefined");
  assert.ok(a.cores >= 1);
  if (a.gl && typeof a.gl === "object" && a.gl.unmasked !== null) assert.equal(a.gl.unmasked, a.gl.masked, "the GPU model is hidden");
});
