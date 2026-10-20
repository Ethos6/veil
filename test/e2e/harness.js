// Starts local "websites" and a Veil instance pointed at them.
// *.test hosts resolve to these servers (host-resolver-rules), port 80 -> HTTP, 443 -> HTTPS.
// insecure.test has no HTTPS (its port 443 speaks plain HTTP, so TLS fails).
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { _electron as electron } from "playwright";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const FIX = path.join(ROOT, "test", "fixtures");

/** Request log, by host, for assertions about what reached the network. */
export const seen = [];

function pageFor(host, url, req, res) {
  const u = new URL(url, `https://${host}`);
  seen.push({ host, path: u.pathname + u.search, headers: req.headers, proto: req.socket.encrypted ? "https" : "http" });
  const send = (body, type = "text/html; charset=utf-8", extra = {}) => {
    res.writeHead(200, { "content-type": type, "cache-control": "no-store", ...extra });
    res.end(body);
  };
  if (u.pathname === "/echo") return send(JSON.stringify(req.headers), "application/json", { "access-control-allow-origin": "*" });
  if (u.pathname === "/set-cookie") return send(`<title>cookie set</title>ok`, undefined, { "set-cookie": `c_${host.split(".")[0]}=1; Path=/; SameSite=None; Secure` });
  if (u.pathname === "/file.txt") return send("hello from veil", "text/plain", { "content-disposition": 'attachment; filename="hello.txt"' });
  if (u.pathname === "/insecure-only" && req.socket.encrypted) { res.destroy(); return; }
  if (u.pathname === "/to-http" && req.socket.encrypted) { res.writeHead(302, { location: `http://${host}/to-http` }); return res.end(); }
  if (u.pathname === "/frame") {
    return send(`<title>frame</title><script>
      document.cookie = "js_${host.split(".")[0]}=1; SameSite=None; Secure";
      parent.postMessage({ frameCookie: document.cookie, gpc: navigator.globalPrivacyControl }, "*");
    </script>`);
  }
  if (host === "ads.test" && u.pathname === "/ad.js") return send("window.__adLoaded = true;", "text/javascript");
  if (host === "redirect.test" && u.pathname === "/lib.js") return send("window.__libReal = true;", "text/javascript");
  if (host === "tracker.test") return send("window.__tracked = true;", "text/javascript");
  if (u.pathname === "/popup") {
    return send(`<title>popups</title><a id="link" href="https://other.test/" target="_blank">open</a>
      <script>setTimeout(() => { window.__popup = window.open("https://other.test/?auto"); }, 50);</script>`);
  }
  if (u.pathname === "/internal-link") return send(`<title>internal</title><a id="go" href="veil://settings/">settings</a><script>window.__veil = typeof window.veil;</script>`);
  if (u.pathname === "/perm") return send(`<title>perm</title><script>window.__perm = Notification.requestPermission();</script>`);
  if (u.pathname === "/find") return send(`<title>find</title><p>apple banana apple cherry apple</p>`);
  if (u.pathname === "/fp") return send(fs.readFileSync(path.join(FIX, "fp.html")));
  if (u.pathname === "/embed") return send(`<title>embed</title><iframe src="${u.searchParams.get("src")}"></iframe><script>window.__msg = new Promise((r) => addEventListener("message", (e) => r(e.data)));</script>`);
  if (u.pathname === "/cookie-escape") return send(`<body><script>
    const f = document.createElement("iframe"); document.body.appendChild(f);
    const get = Object.getOwnPropertyDescriptor(f.contentWindow.Document.prototype, "cookie").get;
    parent.postMessage({ direct: document.cookie, viaBlankFrame: get.call(document) }, "*");
  </script>`);
  if (u.pathname === "/sw-frame") return send(`<script>navigator.serviceWorker.register("/sw.js").then(() => parent.postMessage("registered", "*"), (e) => parent.postMessage("error " + e, "*"));</script>`);
  if (u.pathname === "/sw.js") return send(`self.addEventListener("install", (e) => e.waitUntil(fetch("/from-sw", { credentials: "include" })));`, "text/javascript");
  if (u.pathname === "/fp-frames") return send(`<canvas id="c" width="200" height="50"></canvas><iframe></iframe><script>
    const c = document.getElementById("c"); const x = c.getContext("2d"); x.font = "20px sans-serif"; x.fillStyle = "#f60"; x.fillRect(0, 0, 200, 50); x.fillStyle = "#069"; x.fillText("Veil 123", 5, 30);
    const main = c.toDataURL();
    const viaFrames = frames[0].HTMLCanvasElement.prototype.toDataURL.call(c);
    const g = document.createElement("iframe"); document.body.append(g);
    const viaAppended = window[1].HTMLCanvasElement.prototype.toDataURL.call(c);
    const d = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, "toDataURL");
    window.__r = { sameAsFrames: main === viaFrames, sameAsAppended: main === viaAppended, enumerable: d.enumerable, writable: d.writable };
  </script>`);
  if (u.pathname === "/opener") return send(`<title>opener</title><button id="b" onclick="window.__p = window.open('https://other.test/spammer', 'p', 'width=300,height=300')">open</button>`);
  if (u.pathname === "/spammer") return send(`<title>spammer</title><script>setTimeout(() => { for (let i = 0; i < 5; i++) window.open("https://other.test/spam" + i); }, 100);</script>`);
  if (u.pathname === "/post-form") return send(`<title>post</title><form id="f" method="post" action="https://other.test/posted" target="_blank"><input name="a" value="1"><button id="go">go</button></form>
    <button id="w" onclick="window.__w = window.open(); window.__w.location = 'https://other.test/written'; window.__isWindow = !!window.__w">w</button>`);
  if (u.pathname === "/posted") return send(`<title>posted ${req.method}</title>${req.method}`);
  if (u.pathname === "/probe-veil") return send(`<title>probe</title><script>
    window.__probe = Promise.all([
      new Promise((r) => { const l = document.createElement("link"); l.rel = "stylesheet"; l.href = "veil://newtab/common.css"; l.onload = () => r("loaded"); l.onerror = () => r("blocked"); document.head.append(l); }),
      new Promise((r) => { const s = document.createElement("script"); s.src = "veil://newtab/common.js"; s.onload = () => r("loaded"); s.onerror = () => r("blocked"); document.head.append(s); }),
      fetch("veil-res://anything/noop.js").then(() => "loaded", () => "blocked"),
    ]);
  </script>`);
  if (u.pathname === "/auto-download") return send(`<title>auto</title><script>setTimeout(() => { location.href = "/file.txt"; }, 50);</script>`);
  if (u.pathname === "/two-downloads") return send(`<title>two</title><a id="a" href="/slow-file?1" download>a</a><a id="b" href="/slow-file?2" download>b</a>`);
  if (u.pathname === "/slow-file") {
    res.writeHead(200, { "content-type": "application/octet-stream", "content-disposition": 'attachment; filename="same.txt"' });
    res.write("part-" + u.search.slice(1) + "-");
    setTimeout(() => res.end("done"), 700);
    return;
  }
  if (host === "news.test" && u.pathname === "/") return send(fs.readFileSync(path.join(FIX, "demo.html")));
  if (host === "site.test" && u.pathname === "/") return send(fs.readFileSync(path.join(FIX, "site.html")));
  return send(`<title>${host}</title><h1>${host}</h1><p>${u.pathname}</p><a id="dl" href="/file.txt">download</a>`);
}

export async function startServers() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "veil-cert-"));
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", path.join(dir, "k.pem"), "-out", path.join(dir, "c.pem"), "-days", "2", "-subj", "/CN=veil.test"], { stdio: "ignore" });
  const handler = (req, res) => {
    try { pageFor((req.headers.host || "").split(":")[0], req.url || "/", req, res); } catch (e) { res.writeHead(500); res.end(String(e)); }
  };
  const plain = http.createServer(handler);
  const tls = https.createServer({ key: fs.readFileSync(path.join(dir, "k.pem")), cert: fs.readFileSync(path.join(dir, "c.pem")) }, handler);
  await Promise.all([new Promise((r) => plain.listen(0, "127.0.0.1", r)), new Promise((r) => tls.listen(0, "127.0.0.1", r))]);
  const p = /** @type {any} */ (plain.address()).port;
  const t = /** @type {any} */ (tls.address()).port;
  const rules = [`MAP insecure.test:443 127.0.0.1:${p}`, `MAP *.test:80 127.0.0.1:${p}`, `MAP *.test:443 127.0.0.1:${t}`, "MAP *.invalid ~NOTFOUND"].join(", ");
  return { rules, close: () => { plain.closeAllConnections(); tls.closeAllConnections(); plain.close(); tls.close(); } };
}

/**
 * @param {string} rules
 * @param {{ settings?: object, profile?: string, realFilters?: boolean }} [opts]
 */
export async function launch(rules, opts = {}) {
  const profile = opts.profile || fs.mkdtempSync(path.join(os.tmpdir(), "veil-profile-"));
  const downloads = fs.mkdtempSync(path.join(os.tmpdir(), "veil-dl-"));
  if (!opts.profile) fs.writeFileSync(path.join(profile, "settings.json"), JSON.stringify({ downloadDir: downloads, ...(opts.settings || {}) }));
  const args = [ROOT];
  if (process.platform === "linux") args.unshift("--no-sandbox");
  const app = await electron.launch({
    args,
    cwd: ROOT,
    env: {
      ...process.env,
      VEIL_TEST: "1",
      VEIL_PROFILE: profile,
      VEIL_HOST_RULES: rules,
      VEIL_TEST_FILTERS: opts.realFilters ? "" : path.join(FIX, "filters.txt"),
      VEIL_TEST_RESOURCES: opts.realFilters ? "" : path.join(FIX, "resources.json"),
    },
  });
  if (process.env.VEIL_TEST_LOG) {
    app.process().stdout?.on("data", (d) => process.stdout.write(`[veil] ${d}`));
    app.process().stderr?.on("data", (d) => process.stdout.write(`[veil!] ${d}`));
  }
  const ui = await waitForPage(app, (u) => u.startsWith("veil://ui/"));
  await ui.waitForSelector(".tab");
  return { app, ui, profile, downloads };
}

/** @param {import("playwright").ElectronApplication} app @param {(url: string) => boolean} test */
export async function waitForPage(app, test, timeout = 15_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const p = app.windows().find((w) => test(w.url()));
    if (p) return p;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("page not found; open: " + app.windows().map((w) => w.url()).join(", "));
}

/** Load a URL in the active tab of the first window and return that tab's Page. */
export async function open(app, url, { expect } = {}) {
  await app.evaluate(async (_e, u) => {
    const tab = /** @type {any} */ (globalThis).veil.windows[0].active;
    tab.errorFor = "";
    // Resolves when the page has loaded (or failed; error pages are checked by the caller).
    await tab.wc.loadURL(u).catch(() => {});
  }, url);
  return activePage(app, expect || ((u) => u === url));
}

/** The Page of the active tab, once its URL satisfies `test`. */
export async function activePage(app, test = () => true, timeout = 15_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const id = await app.evaluate(() => /** @type {any} */ (globalThis).veil.windows[0].active.wc.id);
    const url = await app.evaluate(({ webContents }, i) => webContents.fromId(i)?.getURL() || "", id).catch(() => "");
    if (url && test(url)) {
      const page = app.windows().find((w) => w.url() === url);
      if (page) {
        await page.waitForLoadState("load").catch(() => {});
        return page;
      }
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  const cur = await app.evaluate(() => /** @type {any} */ (globalThis).veil.windows[0].active.url);
  throw new Error(`active tab never matched; it is at ${cur}; pages: ${app.windows().map((w) => w.url()).join(", ")}`);
}

/** State of the active tab, as the toolbar sees it. */
export function tabState(app) {
  return app.evaluate(() => /** @type {any} */ (globalThis).veil.windows[0].active.summary());
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function until(fn, timeout = 8000, what = "condition") {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try { last = await fn(); if (last) return last; } catch (e) { last = e; }
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${what} (last: ${last instanceof Error ? last.message : JSON.stringify(last)})`);
}

/** Run JavaScript in the active tab's page (no Playwright page tracking involved). */
export function evalTab(app, code, win = 0) {
  return app.evaluate((_e, [c, w]) => globalThis.veil.windows[w].active.wc.executeJavaScript(c), [code, win]);
}

/** Click an element in the active tab with a real (OS-level) mouse event. */
export async function clickTab(app, selector, win = 0) {
  const box = await evalTab(app, `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`, win);
  await app.evaluate((_e, [b, w]) => {
    const wc = globalThis.veil.windows[w].active.wc;
    wc.sendInputEvent({ type: "mouseDown", x: b.x, y: b.y, button: "left", clickCount: 1 });
    wc.sendInputEvent({ type: "mouseUp", x: b.x, y: b.y, button: "left", clickCount: 1 });
  }, [box, win]);
}

/** Load a URL in the active tab and wait for it, without needing a Playwright page. */
export async function load(app, url) {
  await app.evaluate(async (_e, u) => {
    const tab = globalThis.veil.windows[0].active;
    await tab.wc.loadURL(u).catch(() => {});
  }, url);
}
