// The browser's toolbar: tab strip, address bar, Shields, menus. Talks to the main process via window.veilUI.
"use strict";
(() => {
  const api = window.veilUI;
  const I = window.ICONS;
  const $ = (id) => document.getElementById(id);
  const isMac = api.platform === "darwin";
  const mod = isMac ? "⌘" : "Ctrl+";

  /** Build an element. Text children are always text nodes, never HTML. */
  function h(tag, props = {}, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === "class") el.className = v;
      else if (k === "html") el.innerHTML = v; // only ever our own icon strings
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else if (k === "dataset") Object.assign(el.dataset, v);
      else el.setAttribute(k, v === true ? "" : String(v));
    }
    for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) el.append(kid instanceof Node ? kid : String(kid));
    return el;
  }

  /** @type {any} */
  let state = { tabs: [], activeId: null, private: false, shields: null, downloads: { active: 0, recent: [] } };
  let editing = false;
  let openPanel = null;
  let update = null;

  const params = new URLSearchParams(location.search);
  if (params.get("private") === "1") {
    document.body.classList.add("private");
    $("private-badge").hidden = false;
  }

  // Static icons
  for (const [id, icon] of [["back", "back"], ["forward", "forward"], ["reload", "reload"], ["newtab", "plus"], ["menu", "menu"], ["downloads", "download"], ["find-prev", "up"], ["find-next", "down"], ["find-close", "close"], ["star", "star"]]) {
    $(id).innerHTML = I[icon];
  }
  $("shields").insertAdjacentHTML("afterbegin", I.shield);
  $("back").title = `Back (${isMac ? "⌘[" : "Alt+Left"})`;
  $("forward").title = `Forward (${isMac ? "⌘]" : "Alt+Right"})`;
  $("reload").title = `Reload (${mod}R)`;
  $("newtab").title = `New tab (${mod}T)`;

  const active = () => state.tabs.find((t) => t.id === state.activeId) || null;
  const call = (method, ...args) => api.call(method, ...args).catch((e) => console.error(method, e));

  /* --------------------------------------------------------------- tabs */

  const tabEls = new Map();
  function renderTabs() {
    const box = $("tabs");
    const ids = new Set(state.tabs.map((t) => t.id));
    for (const [id, el] of tabEls) if (!ids.has(id)) { el.remove(); tabEls.delete(id); }
    const avail = Math.max(200, document.body.clientWidth - 140);
    const narrow = avail / Math.max(1, state.tabs.length) < 76;
    state.tabs.forEach((t, i) => {
      let el = tabEls.get(t.id);
      if (!el) {
        el = makeTab(t.id);
        tabEls.set(t.id, el);
      }
      if (box.children[i] !== el) box.insertBefore(el, box.children[i] || null);
      updateTab(el, t, narrow);
    });
  }

  function makeTab(id) {
    const el = h("div", { class: "tab", role: "tab", draggable: "true", dataset: { id } },
      h("span", { class: "fav" }),
      h("span", { class: "title" }),
      h("button", { class: "audio", tabindex: "-1", hidden: true, onclick: (e) => { e.stopPropagation(); call("muteTab", id); } }),
      h("button", { class: "x", tabindex: "-1", title: `Close tab (${mod}W)`, "aria-label": "Close tab", html: I.close, onclick: (e) => { e.stopPropagation(); call("closeTab", id); } }));
    el.addEventListener("mousedown", (e) => { if (e.button === 0) call("activate", id); });
    el.addEventListener("auxclick", (e) => { if (e.button === 1) { e.preventDefault(); call("closeTab", id); } });
    el.addEventListener("mousedown", (e) => { if (e.button === 1) e.preventDefault(); });
    el.addEventListener("contextmenu", (e) => { e.preventDefault(); call("tabMenu", id); });
    el.addEventListener("dragstart", (e) => { e.dataTransfer.setData("text/veil-tab", String(id)); e.dataTransfer.effectAllowed = "move"; });
    el.addEventListener("dragover", (e) => { if (e.dataTransfer.types.includes("text/veil-tab")) { e.preventDefault(); el.classList.add("drag-over"); } });
    el.addEventListener("dragleave", () => el.classList.remove("drag-over"));
    el.addEventListener("drop", (e) => {
      el.classList.remove("drag-over");
      const from = Number(e.dataTransfer.getData("text/veil-tab"));
      if (!from) return;
      e.preventDefault();
      const to = state.tabs.findIndex((t) => t.id === id);
      call("moveTab", from, to);
    });
    return el;
  }

  function updateTab(el, t, narrow) {
    el.classList.toggle("active", t.id === state.activeId);
    el.classList.toggle("narrow", narrow);
    el.setAttribute("aria-selected", String(t.id === state.activeId));
    el.title = t.url ? `${t.title}\n${t.url}` : t.title;
    const fav = el.querySelector(".fav");
    const favKey = t.loading ? "loading" : t.crashed ? "crashed" : t.favicon || (t.url.startsWith("veil:") || !t.url ? "veil" : "globe");
    if (fav.dataset.key !== favKey) {
      fav.dataset.key = favKey;
      fav.replaceChildren();
      if (favKey === "loading") fav.append(h("span", { class: "spinner" }));
      else if (favKey === "veil") fav.innerHTML = I.veil;
      else if (favKey === "globe") fav.innerHTML = I.globe;
      else if (favKey === "crashed") fav.innerHTML = I.warn;
      else fav.append(h("img", { src: t.favicon, alt: "" }));
    }
    el.querySelector(".title").textContent = t.title || "New Tab";
    const audio = el.querySelector(".audio");
    audio.hidden = !(t.audible || t.muted);
    if (!audio.hidden) {
      audio.innerHTML = t.muted ? I.muted : I.speaker;
      audio.title = t.muted ? "Unmute tab" : "Mute tab";
    }
  }

  $("newtab").addEventListener("click", () => call("newTab"));
  document.querySelector(".strip-fill").addEventListener("dblclick", () => call("newTab"));

  /* ------------------------------------------------------------ toolbar */

  function prettyUrl(url) {
    if (!url) return "";
    if (url.startsWith("https://")) {
      const rest = url.slice(8);
      return rest.endsWith("/") && rest.indexOf("/") === rest.length - 1 ? rest.slice(0, -1) : rest;
    }
    return url;
  }

  function renderToolbar() {
    const t = active();
    $("back").disabled = !t?.canBack;
    $("forward").disabled = !t?.canForward;
    $("reload").innerHTML = t?.loading ? I.stop : I.reload;
    $("reload").title = t?.loading ? "Stop loading" : `Reload (${mod}R)`;
    const addr = $("address");
    if (!editing) addr.value = document.activeElement === addr ? (t?.url || "") : prettyUrl(t?.url || "");
    const sec = $("security");
    sec.className = t?.secure || "";
    if (t?.secure === "secure") { sec.innerHTML = I.lock; sec.title = "Connection is secure (HTTPS)"; }
    else if (t?.secure === "insecure") { sec.innerHTML = I.warn; sec.append(" Not secure"); sec.title = "This page is not using HTTPS. Anyone on the network can read or change it."; }
    else if (t?.secure === "internal" && t.url) { sec.innerHTML = I.veil; sec.title = "Veil page"; }
    else if (!t?.url) { sec.innerHTML = I.search; sec.title = ""; }
    else { sec.innerHTML = I.info; sec.title = ""; }
    const star = $("star");
    const canStar = !!t?.url && /^(https?|file):/.test(t.url);
    star.hidden = !canStar;
    star.classList.toggle("on", !!state.bookmarked);
    star.innerHTML = state.bookmarked ? I.starOn : I.star;
    star.title = state.bookmarked ? "Remove bookmark" : `Bookmark this page (${mod}D)`;
    // Shields
    const sh = state.shields;
    const btn = $("shields");
    btn.disabled = !sh?.applicable;
    btn.classList.toggle("off", !!sh?.applicable && !sh.on);
    btn.querySelector("svg").outerHTML = sh?.applicable && !sh.on ? I.shieldOff : I.shield;
    $("shield-count").textContent = sh?.applicable && sh.on && sh.blocked ? (sh.blocked > 999 ? "999+" : String(sh.blocked)) : "";
    btn.title = !sh?.applicable ? "Shields protect web pages" : sh.on ? `Shields are up: ${sh.blocked} blocked on this page` : "Shields are down for this site";
    // Downloads
    const dl = state.downloads || { active: 0, recent: [] };
    const dbtn = $("downloads");
    dbtn.hidden = !dl.recent.length && dbtn.hidden;
    if (dl.recent.length) dbtn.hidden = false;
    let ring = dbtn.querySelector(".ring");
    if (dl.active && dl.progress !== null) {
      if (!ring) { ring = h("span", { class: "ring" }); dbtn.append(ring); }
      const deg = Math.round(dl.progress * 360);
      ring.style.background = `conic-gradient(var(--accent) ${deg}deg, transparent ${deg}deg)`;
      ring.style.mask = "radial-gradient(circle, transparent 11px, #000 11.5px)";
      ring.style.webkitMask = ring.style.mask;
    } else ring?.remove();
    dbtn.title = dl.active ? `${dl.active} download${dl.active > 1 ? "s" : ""} in progress` : `Downloads (${isMac ? "⌘⇧J" : "Ctrl+J"})`;
    $("menu").classList.toggle("update", !!update);
  }

  $("back").addEventListener("click", () => call("action", "back"));
  $("forward").addEventListener("click", () => call("action", "forward"));
  $("reload").addEventListener("click", (e) => call("action", active()?.loading ? "stop" : e.shiftKey ? "hardReload" : "reload"));
  $("star").addEventListener("click", () => call("action", "bookmark"));

  /* ----------------------------------------------------------- omnibox */

  const addr = $("address");
  let sugg = { items: [], sel: 0, token: 0 };

  addr.addEventListener("focus", () => {
    $("omnibox").classList.add("focused");
    const t = active();
    if (!editing && t?.url) addr.value = t.url;
    setTimeout(() => addr.select(), 0);
  });
  addr.addEventListener("blur", () => {
    $("omnibox").classList.remove("focused");
    setTimeout(() => {
      if (document.activeElement === addr) return;
      editing = false;
      if (openPanel === "suggestions") closePanels();
      renderToolbar();
    }, 120);
  });
  addr.addEventListener("input", () => {
    editing = true;
    requestSuggestions();
  });
  addr.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (openPanel !== "suggestions") return;
      e.preventDefault();
      const n = sugg.items.length;
      sugg.sel = (sugg.sel + (e.key === "ArrowDown" ? 1 : n - 1)) % n;
      renderSuggestions();
      const it = sugg.items[sugg.sel];
      if (it && it.kind !== "input") addr.value = it.url;
    } else if (e.key === "Enter") {
      e.preventDefault();
      const it = openPanel === "suggestions" ? sugg.items[sugg.sel] : null;
      go(it && it.kind !== "input" ? it.url : addr.value, e.altKey || (isMac ? e.metaKey : e.ctrlKey && e.shiftKey));
    } else if (e.key === "Escape") {
      e.preventDefault();
      if (openPanel === "suggestions") { closePanels(); addr.value = active()?.url || ""; addr.select(); }
      else { editing = false; addr.value = prettyUrl(active()?.url || ""); call("focusPage"); }
    } else if (e.key === "Delete" && e.shiftKey && openPanel === "suggestions") {
      // Shift+Delete removes a history suggestion, as in other browsers.
    }
  });

  function go(text, newTab) {
    const v = String(text || "").trim();
    if (!v) return;
    editing = false;
    closePanels();
    if (newTab) call("newTab", v);
    else call("navigate", v);
    addr.blur();
  }

  let suggTimer = 0;
  function requestSuggestions() {
    clearTimeout(suggTimer);
    const text = addr.value;
    if (!text.trim()) { if (openPanel === "suggestions") closePanels(); return; }
    suggTimer = setTimeout(async () => {
      const token = ++sugg.token;
      const r = await api.call("suggest", text).catch(() => null);
      if (!r || token !== sugg.token || document.activeElement !== addr) return;
      const first = r.input.kind === "search"
        ? { kind: "input", icon: "search", title: text, sub: `— Search with ${r.engine}`, url: r.input.url }
        : { kind: "input", icon: "globe", title: r.input.url, sub: "", url: r.input.url };
      sugg.items = [first, ...r.items.filter((x) => x.url !== r.input.url).map((x) => ({ kind: x.bookmark ? "bookmark" : "history", icon: x.bookmark ? "star" : "clock", title: x.title || x.url, sub: x.url, url: x.url }))];
      sugg.sel = 0;
      await showPanel("suggestions");
      renderSuggestions();
    }, 40);
  }

  function renderSuggestions() {
    const p = $("suggestions");
    const box = $("omnibox").getBoundingClientRect();
    p.style.left = `${box.left}px`;
    p.style.top = `${box.bottom + 6}px`;
    p.style.width = `${box.width}px`;
    p.replaceChildren(...sugg.items.map((it, i) => h("div", {
      class: `row${i === sugg.sel ? " sel" : ""}`, role: "option", "aria-selected": String(i === sugg.sel),
      onmousedown: (e) => { e.preventDefault(); go(it.kind === "input" ? addr.value : it.url, e.button === 1); },
    }, h("span", { class: "ico", html: I[it.icon] }), h("span", { class: "main" }, h("span", { class: "t" }, it.title), it.sub ? h("span", { class: "u" }, it.sub) : null))));
  }

  /* ------------------------------------------------------------ panels */

  async function showPanel(name) {
    if (openPanel === name) return;
    for (const p of ["suggestions", "shields-panel", "menu-panel", "downloads-panel"]) $(p).hidden = true;
    openPanel = name;
    $("backdrop").hidden = false;
    await call("setOverlay", true);
    const el = $(name === "suggestions" ? "suggestions" : `${name}-panel`);
    el.hidden = false;
  }

  function closePanels() {
    if (!openPanel) return;
    openPanel = null;
    const f = document.activeElement;
    if (f && f.classList?.contains("icon-btn")) f.blur();
    for (const p of ["suggestions", "shields-panel", "menu-panel", "downloads-panel"]) $(p).hidden = true;
    $("backdrop").hidden = true;
    call("setOverlay", false);
  }

  $("backdrop").addEventListener("mousedown", () => {
    const wasSugg = openPanel === "suggestions";
    closePanels();
    if (wasSugg) { addr.blur(); call("focusPage"); }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && openPanel && openPanel !== "suggestions") { closePanels(); call("focusPage"); }
  });

  function anchor(panel, btn, align = "right") {
    const r = btn.getBoundingClientRect();
    panel.style.top = `${r.bottom + 6}px`;
    if (align === "right") { panel.style.right = `${Math.max(8, document.body.clientWidth - r.right)}px`; panel.style.left = "auto"; }
    else { panel.style.left = `${Math.max(8, r.left)}px`; panel.style.right = "auto"; }
  }

  function toggle(name, render) {
    if (openPanel === name) return closePanels();
    showPanel(name).then(render);
  }

  /* Shields */
  function renderShields() {
    const p = $("shields-panel");
    anchor(p, $("shields"));
    const sh = state.shields;
    if (!sh?.applicable) { p.replaceChildren(h("div", { class: "empty" }, "Shields protect web pages.")); return; }
    const head = h("div", { class: "sh-head" },
      h("div", { class: "site" }, h("b", {}, sh.site), h("span", {}, sh.on ? "Shields are UP" : "Shields are DOWN")),
      h("button", { class: `switch${sh.on ? " on" : ""}`, role: "switch", "aria-checked": String(sh.on), "aria-label": `Shields for ${sh.site}`, onclick: () => call("toggleShields") }));
    const kids = [head];
    if (sh.on) {
      kids.push(h("div", { class: "sh-stats" },
        h("div", {}, h("b", {}, fmt(sh.blocked)), h("span", {}, "Ads & trackers blocked")),
        h("div", {}, h("b", {}, fmt(sh.upgraded)), h("span", {}, "Upgraded to HTTPS")),
        h("div", {}, h("b", {}, fmt(sh.stripped)), h("span", {}, "Tracking links cleaned"))));
      if (sh.hosts.length) {
        kids.push(h("details", {}, h("summary", {}, `Blocked from ${sh.hosts.length} ${sh.hosts.length === 1 ? "domain" : "domains"}`),
          h("div", { class: "sh-list" }, sh.hosts.map(([host, n]) => h("div", { class: "row" }, h("span", { class: "t" }, host), h("span", { class: "n" }, n))))));
      }
      kids.push(h("div", { class: "sh-opt" },
        h("div", { class: "l" }, "Block scripts", h("small", {}, "Stops all JavaScript on this site. Many sites will break.")),
        h("button", { class: `switch${sh.scripts ? " on" : ""}`, role: "switch", "aria-checked": String(sh.scripts), "aria-label": "Block scripts", onclick: () => call("setScripts", !sh.scripts) })));
      kids.push(h("div", { class: "sh-opt" },
        h("div", { class: "l" }, "Fingerprinting protection", h("small", {}, sh.fingerprinting ? "On: canvas, WebGL and audio readouts are randomised per site" : "Off (change in Settings)"))));
    } else {
      kids.push(h("div", { class: "sh-off" }, "Ads, trackers, fingerprinting protection and HTTPS upgrades are off for this site. Turn Shields back on if the site works without them."));
    }
    kids.push(h("div", { class: "sh-foot" },
      h("span", {}, "Settings apply to every page on this site"),
      h("button", { class: "linkish", onclick: () => { closePanels(); call("action", "settings"); } }, "Global settings")));
    p.replaceChildren(...kids);
  }
  $("shields").addEventListener("click", () => toggle("shields", renderShields));

  /* Menu */
  function renderMenu() {
    const p = $("menu-panel");
    anchor(p, $("menu"));
    const t = active();
    const item = (label, action, kbd) => h("div", { class: "row", tabindex: "0", onclick: () => { closePanels(); call("action", action); }, onkeydown: (e) => { if (e.key === "Enter") { closePanels(); call("action", action); } } },
      h("span", { class: "main" }, h("span", { class: "t" }, label)), kbd ? h("span", { class: "kbd" }, kbd) : null);
    const zoom = Math.round((t?.zoom || 1) * 100);
    const kids = [
      item("New tab", "newTab", `${mod}T`),
      item("New window", "newWindow", `${mod}N`),
      item("New private window", "privateWindow", isMac ? "⌘⇧N" : "Ctrl+Shift+N"),
      h("div", { class: "sep" }),
      item("History", "history", isMac ? "⌘Y" : "Ctrl+H"),
      item("Bookmarks", "bookmarks", isMac ? "⌥⌘B" : "Ctrl+Shift+O"),
      item("Downloads", "downloads", isMac ? "⌘⇧J" : "Ctrl+J"),
      h("div", { class: "sep" }),
      h("div", { class: "zoomrow" }, h("span", { class: "label" }, "Zoom"),
        h("button", { class: "icon-btn small", "aria-label": "Zoom out", onclick: () => call("action", "zoomOut").then(() => setTimeout(renderMenu, 60)) }, "−"),
        h("span", { class: "val" }, `${zoom}%`),
        h("button", { class: "icon-btn small", "aria-label": "Zoom in", onclick: () => call("action", "zoomIn").then(() => setTimeout(renderMenu, 60)) }, "+"),
        h("button", { class: "icon-btn small", "aria-label": "Full screen", title: "Full screen", html: I.expand, onclick: () => { closePanels(); call("action", "fullscreen"); } })),
      item("Find…", "find", `${mod}F`),
      item("Print…", "print", `${mod}P`),
      h("div", { class: "sep" }),
      item("Settings", "settings", isMac ? "⌘," : ""),
      item("About Veil", "about"),
    ];
    if (update) kids.push(h("div", { class: "row", onclick: () => { closePanels(); call("newTab", update.url); } }, h("span", { class: "main" }, h("span", { class: "t" }, `Veil ${update.version} is available`)), h("span", { class: "kbd" }, "Download")));
    if (!isMac) kids.push(h("div", { class: "sep" }), item("Quit", "quit", "Ctrl+Shift+Q"));
    p.replaceChildren(...kids);
  }
  $("menu").addEventListener("click", () => toggle("menu", renderMenu));

  /* Downloads */
  function renderDownloads() {
    const p = $("downloads-panel");
    anchor(p, $("downloads"));
    const list = state.downloads?.recent || [];
    const kids = list.length ? list.map((d) => {
      const done = d.state === "completed";
      const sub = done ? `${size(d.total || d.received)} · Done`
        : d.state === "progressing" ? `${size(d.received)} of ${d.total ? size(d.total) : "?"}`
        : d.state === "paused" ? "Paused" : d.state === "cancelled" ? "Cancelled" : "Failed";
      return h("div", { class: "dl" },
        h("span", { class: "ico", html: I.file }),
        h("div", { class: "meta" }, h("div", { class: "name", title: d.filename }, d.filename),
          d.state === "progressing" || d.state === "paused" ? h("progress", { max: String(d.total || 1), value: String(d.received) }) : null,
          h("div", { class: "sub" }, sub)),
        done ? h("button", { class: "icon-btn small", title: "Show in folder", "aria-label": "Show in folder", html: I.folder, onclick: () => call("downloadAction", d.id, "show") }) : null,
        d.state === "progressing" ? h("button", { class: "icon-btn small", title: "Cancel", "aria-label": "Cancel download", html: I.close, onclick: () => call("downloadAction", d.id, "cancel") }) : null);
    }) : [h("div", { class: "empty" }, "No downloads yet")];
    kids.push(h("div", { class: "sep" }), h("div", { class: "row", onclick: () => { closePanels(); call("action", "downloads"); } }, h("span", { class: "main" }, h("span", { class: "t" }, "All downloads"))));
    p.replaceChildren(...kids);
  }
  $("downloads").addEventListener("click", () => toggle("downloads", renderDownloads));

  /* --------------------------------------------------------- find bar */

  const findInput = $("find-input");
  function openFind() {
    $("findbar").hidden = false;
    findInput.focus();
    findInput.select();
  }
  function renderFind() {
    const f = active()?.find;
    if (!f && !$("findbar").hidden && document.activeElement !== findInput) $("findbar").hidden = true;
    if (f) {
      $("findbar").hidden = false;
      $("find-count").textContent = f.text ? `${f.active}/${f.matches}` : "";
      findInput.classList.toggle("none", !!f.text && f.matches === 0);
      if (document.activeElement !== findInput && findInput.value !== f.text) findInput.value = f.text;
    }
  }
  findInput.addEventListener("input", () => call("find", findInput.value, true));
  findInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); if (findInput.value) call("find", findInput.value, !e.shiftKey); }
    if (e.key === "Escape") { e.preventDefault(); closeFind(); }
  });
  function closeFind() {
    $("findbar").hidden = true;
    $("find-count").textContent = "";
    call("findStop");
  }
  $("find-next").addEventListener("click", () => findInput.value && call("find", findInput.value, true));
  $("find-prev").addEventListener("click", () => findInput.value && call("find", findInput.value, false));
  $("find-close").addEventListener("click", closeFind);

  /* ---------------------------------------------------------- infobars */

  function renderInfobars() {
    const t = active();
    const bars = t?.infobars || [];
    $("infobars").replaceChildren(...bars.map((b) => h("div", { class: "infobar", role: "alert" },
      h("span", { class: "ico", html: b.kind === "permission" || b.kind === "external" ? I.info : I.shield }),
      h("span", { class: "msg", title: b.text }, b.text),
      b.actions.map((a) => h("button", { class: `btn${a.primary ? " primary" : ""}`, onclick: () => call("infobar", t.id, b.id, a.id) }, a.label)),
      h("button", { class: "icon-btn small", title: "Dismiss", "aria-label": "Dismiss", html: I.close, onclick: () => call("infobar", t.id, b.id, "dismiss") }))));
  }

  /* --------------------------------------------------------------- misc */

  function fmt(n) { return n >= 10000 ? `${Math.round(n / 1000)}k` : String(n || 0); }
  function size(b) {
    if (!b) return "0 B";
    const u = ["B", "KB", "MB", "GB"];
    let i = 0; let v = b;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return `${v < 10 && i ? v.toFixed(1) : Math.round(v)} ${u[i]}`;
  }
  let toastTimer = 0;
  function toast(text) {
    const el = $("toast");
    el.textContent = text;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 2500);
  }

  // Tell the main process how tall the toolbar area is (it grows with the find bar and infobars).
  new ResizeObserver(() => call("setChromeHeight", $("chrome").offsetHeight)).observe($("chrome"));
  window.addEventListener("resize", () => renderTabs());

  /* ------------------------------------------------------------ events */

  let lastActive = null;
  api.on("state", (s) => {
    state = s;
    if (s.theme && document.documentElement.dataset.theme !== s.theme) document.documentElement.dataset.theme = s.theme;
    if (state.activeId !== lastActive) {
      lastActive = state.activeId;
      editing = false;
      if (openPanel === "suggestions") closePanels();
      if (!active()?.find && !$("findbar").hidden) $("findbar").hidden = true;
    }
    renderTabs();
    renderToolbar();
    renderFind();
    renderInfobars();
    if (openPanel === "shields") renderShields();
    if (openPanel === "downloads") renderDownloads();
    document.title = active()?.title || "Veil";
  });
  api.on("focus-address", () => {
    closePanels();
    addr.focus();
    addr.select();
  });
  api.on("find-open", () => openFind());
  api.on("update", (u) => { update = u; renderToolbar(); });
  api.on("download-started", (d) => {
    $("downloads").hidden = false;
    toast(`Downloading ${d.filename}`);
  });
  call("update").then((u) => { if (u) { update = u; renderToolbar(); } });
})();
