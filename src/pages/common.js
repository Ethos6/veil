// Helpers shared by Veil's own pages.
"use strict";
window.V = (() => {
  /** Build an element; text children are text nodes, never HTML. */
  function h(tag, props = {}, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === "class") el.className = v;
      else if (k === "html") el.innerHTML = v; // only our own static markup
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else if (k === "value") el.value = v;
      else el.setAttribute(k, v === true ? "" : String(v));
    }
    for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) el.append(kid instanceof Node ? kid : String(kid));
    return el;
  }
  const call = (method, ...args) => window.veil.call(method, ...args);
  // Follow Veil's theme setting (which can differ from the system's).
  const applyTheme = (t) => { if (t === "dark" || t === "light") document.documentElement.dataset.theme = t; };
  window.veil.call("theme").then(applyTheme, () => {});
  window.veil.on("theme", applyTheme);
  const on = (name, fn) => window.veil.on(name, fn);

  function switchEl(on, onChange, label) {
    const el = h("button", { class: `switch${on ? " on" : ""}`, role: "switch", "aria-checked": String(!!on), "aria-label": label || "" });
    el.addEventListener("click", async () => {
      const next = !el.classList.contains("on");
      el.classList.toggle("on", next);
      el.setAttribute("aria-checked", String(next));
      try { await onChange(next); } catch (e) {
        el.classList.toggle("on", !next);
        el.setAttribute("aria-checked", String(!next));
        alert(e.message || String(e));
      }
    });
    return el;
  }

  function ago(ts) {
    if (!ts) return "never";
    const s = Math.round((Date.now() - ts) / 1000);
    if (s < 60) return "just now";
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    if (s < 86400) return `${Math.round(s / 3600)} h ago`;
    return `${Math.round(s / 86400)} days ago`;
  }
  function num(n) { return new Intl.NumberFormat().format(n || 0); }
  function size(b) {
    if (!b) return "0 B";
    const u = ["B", "KB", "MB", "GB", "TB"];
    let i = 0; let v = b;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return `${v < 10 && i ? v.toFixed(1) : Math.round(v)} ${u[i]}`;
  }
  function duration(ms) {
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.round(s / 60)}m`;
    if (s < 86400) return `${(s / 3600).toFixed(s < 36000 ? 1 : 0)}h`;
    return `${(s / 86400).toFixed(1)}d`;
  }
  function host(url) {
    try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; }
  }
  /** A letter tile for a site (Veil doesn't fetch remote icons for its own pages). */
  function tile(name) {
    const letter = (name || "?").replace(/^www\./, "")[0]?.toUpperCase() || "?";
    let hash = 0;
    for (const c of name || "") hash = (hash * 31 + c.charCodeAt(0)) >>> 0;
    const hue = hash % 360;
    return h("span", { class: "tile", style: `background: hsl(${hue} 55% 46%)` }, letter);
  }
  return { h, call, on, switchEl, ago, num, size, duration, host, tile };
})();
