// Runs in every frame of every tab, in an isolated world, before the page's own scripts.
// Web pages: applies Shields (cosmetic filtering, scriptlets, fingerprint randomisation,
// Global Privacy Control, third-party cookie blocking in frames).
// Veil's own pages (veil://): exposes a small API to talk to the browser.
"use strict";
const { ipcRenderer, contextBridge, webFrame } = require("electron");

if (location.protocol === "veil:") {
  exposePageApi();
} else if (/^https?:$/.test(location.protocol)) {
  protect();
}

function exposePageApi() {
  /** @type {Map<string, Set<Function>>} */
  const listeners = new Map();
  ipcRenderer.on("veil:page-event", (_e, name, data) => {
    for (const fn of listeners.get(name) || []) {
      try { fn(data); } catch (err) { console.error(err); }
    }
  });
  contextBridge.exposeInMainWorld("veil", {
    /** Call a browser method. The browser checks that the caller is a veil:// page. */
    call: (method, ...args) => ipcRenderer.invoke("veil:page", String(method), ...args),
    on: (name, fn) => {
      if (typeof fn !== "function") return;
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(fn);
    },
  });
}

function protect() {
  /** @type {{ shields: boolean, seed: string, farble: boolean, gpc: boolean, blockCookies: boolean, cosmetic: boolean, styles: string, scripts: string[] } | null} */
  let cfg = null;
  try {
    cfg = ipcRenderer.sendSync("veil:frame-init", location.href);
  } catch {
    cfg = null;
  }
  if (!cfg) return;

  if (cfg.gpc) run(installGpc);
  if (cfg.blockCookies) run(installCookieBlock);
  if (cfg.farble && cfg.seed) run(installFarbling, cfg.seed);

  if (!cfg.cosmetic) return;
  if (cfg.styles) webFrame.insertCSS(cfg.styles, { cssOrigin: "user" });
  for (const script of cfg.scripts || []) {
    // Scriptlets from the filter lists (uBlock Origin's resources). They must run before the page's code.
    try { webFrame.executeJavaScript(script).catch(() => {}); } catch { /* a broken scriptlet must not break the page */ }
  }
  observeDom();
}

/** Run a self-contained function in the page's own JavaScript world, synchronously. */
function run(func, ...args) {
  try {
    contextBridge.executeInMainWorld({ func, args });
  } catch (e) {
    // executeInMainWorld can fail on pages that are being torn down; nothing to protect then.
  }
}

/* ---------------- Cosmetic filtering: ask for rules matching what's in the DOM ---------------- */

function observeDom() {
  const seenClasses = new Set();
  const seenIds = new Set();
  const seenHrefs = new Set();
  let pending = { classes: [], ids: [], hrefs: [] };
  let timer = null;
  let firstAt = 0;

  const collect = (el) => {
    if (el.nodeType !== 1) return;
    const tag = el.tagName;
    if (tag === "SCRIPT" || tag === "STYLE" || tag === "LINK" || tag === "META" || tag === "BR") return;
    if (el.id && !seenIds.has(el.id)) { seenIds.add(el.id); pending.ids.push(el.id); }
    const cls = el.classList;
    if (cls) for (const c of cls) if (!seenClasses.has(c)) { seenClasses.add(c); pending.classes.push(c); }
    if (tag === "A") {
      const href = el.getAttribute("href");
      if (href && !seenHrefs.has(href) && seenHrefs.size < 5000) { seenHrefs.add(href); pending.hrefs.push(href); }
    }
  };
  const collectTree = (root) => {
    collect(root);
    if (root.querySelectorAll) for (const el of root.querySelectorAll("[id],[class],a[href]")) collect(el);
  };
  const send = () => {
    timer = null;
    firstAt = 0;
    const batch = pending;
    pending = { classes: [], ids: [], hrefs: [] };
    if (!batch.classes.length && !batch.ids.length && !batch.hrefs.length) return;
    ipcRenderer.invoke("veil:cosmetics", { url: location.href, ...batch }).then((styles) => {
      if (styles) webFrame.insertCSS(styles, { cssOrigin: "user" });
    }, () => {});
  };
  const schedule = () => {
    const now = Date.now();
    if (!firstAt) firstAt = now;
    clearTimeout(timer);
    // Batch changes, but never wait more than 300 ms after the first one.
    timer = setTimeout(send, now - firstAt > 300 ? 0 : 25);
  };

  const start = () => {
    if (!document.documentElement) return;
    collectTree(document.documentElement);
    send();
    new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (m.type === "attributes") collect(m.target);
        else for (const n of m.addedNodes) if (n.nodeType === 1) collectTree(n);
      }
      if (pending.classes.length || pending.ids.length || pending.hrefs.length) schedule();
    }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "id"] });
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
}

/* ---------------- Functions below run in the page's world. They must be self-contained. ---------------- */

function installGpc() {
  if ("globalPrivacyControl" in Navigator.prototype) return;
  Object.defineProperty(Navigator.prototype, "globalPrivacyControl", {
    get: new Proxy(function () { return true; }, {}),
    configurable: true,
    enumerable: true,
  });
}

function installCookieBlock() {
  // A third-party frame: its cookies are blocked, whether set by headers (handled by the
  // browser) or by script (handled here).
  const desc = Object.getOwnPropertyDescriptor(Document.prototype, "cookie");
  if (!desc) return;
  Object.defineProperty(Document.prototype, "cookie", {
    get: new Proxy(desc.get, { apply: () => "" }),
    set: new Proxy(desc.set, { apply: () => undefined }),
    configurable: true,
    enumerable: desc.enumerable,
  });
  if (typeof CookieStore !== "undefined") {
    for (const m of ["get", "getAll"]) {
      const orig = CookieStore.prototype[m];
      if (orig) CookieStore.prototype[m] = new Proxy(orig, { apply: () => Promise.resolve(m === "get" ? null : []) });
    }
    for (const m of ["set", "delete"]) {
      const orig = CookieStore.prototype[m];
      if (orig) CookieStore.prototype[m] = new Proxy(orig, { apply: () => Promise.resolve(undefined) });
    }
  }
}

/**
 * Brave-style fingerprint randomisation ("farbling"). Readouts that identify the
 * device (canvas pixels, WebGL renderer and pixels, audio samples, CPU core count)
 * get small changes derived from a per-site, per-session seed: stable for one site
 * during a session, different on every other site and after a restart, so they
 * can't be used to follow you across sites.
 * @param {string} seedHex
 */
function installFarbling(seedHex) {
  const seed = (parseInt(seedHex.slice(0, 8), 16) >>> 0) || 1;
  const seed2 = (parseInt(seedHex.slice(8, 16), 16) >>> 0) || 7;
  /** A deterministic 32-bit hash of (seed, n). */
  const h = (n) => {
    let x = (seed ^ Math.imul(n + 0x9e3779b9, 0x85ebca6b)) >>> 0;
    x ^= x >>> 16; x = Math.imul(x, 0x7feb352d) >>> 0;
    x ^= x >>> 15; x = Math.imul(x, 0x846ca68b) >>> 0;
    x ^= x >>> 16;
    return x >>> 0;
  };
  const STEP = 31 + (seed2 % 23);

  /** Change the lowest bit of one channel in a sparse, seed-chosen set of visible pixels. */
  const farblePixels = (data) => {
    if (!data || !data.length) return;
    const pixels = Math.floor(data.length / 4);
    for (let p = seed2 % STEP; p < pixels; p += STEP) {
      const i = p * 4;
      if (data[i + 3] === 0) continue; // fully transparent pixels stay as they are
      const r = h(p);
      data[i + (r % 3)] ^= 1;
    }
  };
  const audioDone = new WeakSet();
  const farbleAudio = (arr) => {
    if (!arr || !arr.length) return;
    for (let i = seed2 % 7; i < arr.length; i += 7) {
      if (arr[i] === 0) continue;
      arr[i] = arr[i] * (1 + ((h(i) % 1000) - 500) * 2e-8);
    }
  };
  const farbleAudioBytes = (arr) => {
    if (!arr || !arr.length) return;
    for (let i = seed2 % 11; i < arr.length; i += 11) if (arr[i] > 0 && arr[i] < 255 && h(i) & 1) arr[i] += (h(i) & 2) ? 1 : -1;
  };

  // Replacements keep the original property's flags, so they look like the built-ins they replace.
  const wrap = (proto, name, makeApply) => {
    if (!proto) return;
    const d = Object.getOwnPropertyDescriptor(proto, name);
    if (!d || typeof d.value !== "function") return;
    try {
      Object.defineProperty(proto, name, { ...d, value: new Proxy(d.value, { apply: makeApply(d.value) }) });
    } catch { /* not configurable */ }
  };
  const wrapGetter = (proto, name, makeGet) => {
    if (!proto) return;
    const d = Object.getOwnPropertyDescriptor(proto, name);
    if (!d || !d.get) return;
    Object.defineProperty(proto, name, { ...d, get: new Proxy(d.get, { apply: makeGet(d.get) }) });
  };

  const patched = new WeakSet();
  const install = (win) => {
    if (!win || patched.has(win)) return;
    patched.add(win);
    let W;
    try { W = win; void W.document; } catch { return; } // cross-origin: has its own protection

    // ---- Canvas 2D readouts
    const getImageData = W.CanvasRenderingContext2D?.prototype.getImageData;
    wrap(W.CanvasRenderingContext2D?.prototype, "getImageData", (orig) => (target, self, args) => {
      const img = Reflect.apply(orig, self, args);
      farblePixels(img.data);
      return img;
    });
    wrap(W.OffscreenCanvasRenderingContext2D?.prototype, "getImageData", (orig) => (target, self, args) => {
      const img = Reflect.apply(orig, self, args);
      farblePixels(img.data);
      return img;
    });

    /** Copy a canvas, farble the copy, and return it (or null if it can't be read). */
    const farbledCopy = (canvas) => {
      const w = canvas.width, hgt = canvas.height;
      if (!w || !hgt || w * hgt > 16_000_000) return null;
      const copy = W.document.createElement("canvas");
      copy.width = w; copy.height = hgt;
      const ctx = copy.getContext("2d");
      if (!ctx || !getImageData) return null;
      try {
        ctx.drawImage(canvas, 0, 0);
        const img = Reflect.apply(getImageData, ctx, [0, 0, w, hgt]);
        farblePixels(img.data);
        ctx.putImageData(img, 0, 0);
        return copy;
      } catch {
        return null; // tainted canvas: the original call will throw as it should
      }
    };
    const HCE = W.HTMLCanvasElement?.prototype;
    wrap(HCE, "toDataURL", (orig) => (target, self, args) => {
      const copy = farbledCopy(self);
      return Reflect.apply(orig, copy || self, args);
    });
    wrap(HCE, "toBlob", (orig) => (target, self, args) => {
      const copy = farbledCopy(self);
      return Reflect.apply(orig, copy || self, args);
    });
    const OC = W.OffscreenCanvas?.prototype;
    wrap(OC, "convertToBlob", (orig) => (target, self, args) => {
      try {
        const w = self.width, hgt = self.height;
        if (w && hgt && w * hgt <= 16_000_000 && getImageData) {
          const copy = new W.OffscreenCanvas(w, hgt);
          const ctx = copy.getContext("2d");
          ctx.drawImage(self.transferToImageBitmap ? self : self, 0, 0);
          const img = Reflect.apply(getImageData, ctx, [0, 0, w, hgt]);
          farblePixels(img.data);
          ctx.putImageData(img, 0, 0);
          return Reflect.apply(orig, copy, args);
        }
      } catch { /* fall back to the original */ }
      return Reflect.apply(orig, self, args);
    });

    // ---- WebGL: hide the GPU model and farble pixel readouts
    for (const C of [W.WebGLRenderingContext, W.WebGL2RenderingContext]) {
      if (!C) continue;
      wrap(C.prototype, "getParameter", (orig) => (target, self, args) => {
        const p = args[0];
        if (p === 0x9245) return Reflect.apply(orig, self, [0x1f00]); // UNMASKED_VENDOR_WEBGL -> VENDOR
        if (p === 0x9246) return Reflect.apply(orig, self, [0x1f01]); // UNMASKED_RENDERER_WEBGL -> RENDERER
        return Reflect.apply(orig, self, args);
      });
      wrap(C.prototype, "readPixels", (orig) => (target, self, args) => {
        const r = Reflect.apply(orig, self, args);
        const out = args[6];
        if (out && ArrayBuffer.isView(out) && out.BYTES_PER_ELEMENT === 1) farblePixels(out);
        return r;
      });
    }
    // WebGPU adapter details
    wrapGetter(W.GPUAdapter?.prototype, "info", (get) => (target, self, args) => {
      const info = Reflect.apply(get, self, args);
      try {
        return Object.freeze({ __proto__: Object.getPrototypeOf(info), vendor: "", architecture: "", device: "", description: "" });
      } catch { return info; }
    });

    // ---- Audio
    wrap(W.AudioBuffer?.prototype, "getChannelData", (orig) => (target, self, args) => {
      const data = Reflect.apply(orig, self, args);
      if (!audioDone.has(data)) { audioDone.add(data); farbleAudio(data); }
      return data;
    });
    wrap(W.AudioBuffer?.prototype, "copyFromChannel", (orig) => (target, self, args) => {
      const r = Reflect.apply(orig, self, args);
      farbleAudio(args[0]);
      return r;
    });
    for (const m of ["getFloatFrequencyData", "getFloatTimeDomainData"]) {
      wrap(W.AnalyserNode?.prototype, m, (orig) => (target, self, args) => {
        const r = Reflect.apply(orig, self, args);
        farbleAudio(args[0]);
        return r;
      });
    }
    for (const m of ["getByteFrequencyData", "getByteTimeDomainData"]) {
      wrap(W.AnalyserNode?.prototype, m, (orig) => (target, self, args) => {
        const r = Reflect.apply(orig, self, args);
        farbleAudioBytes(args[0]);
        return r;
      });
    }

    // ---- Hardware. (CPU core count is left alone: workers would still see the real value,
    // and a mismatch between the two would itself identify Veil.)
    try { delete W.Navigator.prototype.getBattery; } catch { /* ignore */ }

    // ---- Same-origin frames created by script (about:blank) don't get a preload of
    // their own. Protect them as soon as they enter the document, before the page can
    // reach them through contentWindow, frames[i] or window[i].
    const FRAME_SEL = "iframe,frame,object,embed";
    const protectFrame = (el) => {
      try { const w = el.contentWindow; if (w) install(w); } catch { /* cross-origin */ }
    };
    const protectIn = (node) => {
      if (!node || node.nodeType !== 1 && node.nodeType !== 11 && node.nodeType !== 9) return;
      if (node.nodeType === 1 && node.matches(FRAME_SEL)) protectFrame(node);
      if (node.querySelector && node.querySelector(FRAME_SEL)) for (const f of node.querySelectorAll(FRAME_SEL)) protectFrame(f);
    };
    for (const [proto, prop] of [[W.HTMLIFrameElement?.prototype, "contentWindow"], [W.HTMLIFrameElement?.prototype, "contentDocument"], [W.HTMLFrameElement?.prototype, "contentWindow"], [W.HTMLObjectElement?.prototype, "contentWindow"]]) {
      wrapGetter(proto, prop, (get) => (target, self, args) => {
        const v = Reflect.apply(get, self, args);
        try {
          const win = prop === "contentDocument" ? v && v.defaultView : v;
          if (win) install(win);
        } catch { /* cross-origin */ }
        return v;
      });
    }
    // Insertion by script: check what was inserted, right after it lands.
    const afterInsert = (proto, names, pick) => {
      for (const name of names) {
        wrap(proto, name, (orig) => (target, self, args) => {
          const r = Reflect.apply(orig, self, args);
          try { for (const n of pick(self, args)) protectIn(n); } catch { /* ignore */ }
          return r;
        });
      }
    };
    afterInsert(W.Node?.prototype, ["appendChild", "insertBefore", "replaceChild"], (self, args) => [args[0]]);
    afterInsert(W.Element?.prototype, ["append", "prepend", "after", "before", "replaceWith"], (self, args) => args.filter((a) => typeof a === "object"));
    afterInsert(W.Element?.prototype, ["insertAdjacentElement"], (self, args) => [args[1]]);
    afterInsert(W.Element?.prototype, ["insertAdjacentHTML"], (self) => [self.parentNode || self]);
    afterInsert(W.Document?.prototype, ["write", "writeln"], (self) => [self]);
    for (const prop of ["innerHTML", "outerHTML"]) {
      const d = W.Element && Object.getOwnPropertyDescriptor(W.Element.prototype, prop);
      if (!d || !d.set) continue;
      Object.defineProperty(W.Element.prototype, prop, { ...d, set: new Proxy(d.set, { apply: (target, self, args) => {
        const parent = self.parentNode;
        const r = Reflect.apply(target, self, args);
        try { protectIn(prop === "outerHTML" ? parent : self); } catch { /* ignore */ }
        return r;
      } }) });
    }
    // Frames written by the HTML parser.
    try {
      new W.MutationObserver((muts) => {
        for (const m of muts) for (const n of m.addedNodes) protectIn(n);
      }).observe(W.document, { childList: true, subtree: true });
    } catch { /* ignore */ }
    wrap(W, "open", (orig) => (target, self, args) => {
      const win = Reflect.apply(orig, self, args);
      try { if (win) install(win); } catch { /* cross-origin */ }
      return win;
    });
  };
  install(window);
}
