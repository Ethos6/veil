"use strict";
(async () => {
  const { h, call, on, switchEl, ago, num } = window.V;
  const content = document.getElementById("content");
  let data = await call("settings.get");
  const set = async (key, value) => { data.settings = await call("settings.set", key, value); };

  const toggle = (key, label, help) => h("div", { class: "item" },
    h("div", { class: "l" }, label, help ? h("small", {}, help) : null),
    switchEl(data.settings[key], (v) => set(key, v), label));

  const select = (key, label, help, options) => {
    const sel = h("select", { "aria-label": label, onchange: (e) => set(key, e.target.value).catch((err) => alert(err.message)) },
      options.map(([v, text]) => h("option", { value: v, selected: data.settings[key] === v }, text)));
    return h("div", { class: "item" }, h("div", { class: "l" }, label, help ? h("small", {}, help) : null), sel);
  };

  function section(id, title, ...kids) {
    return h("section", { id }, h("div", { class: "card" }, h("h2", {}, title), ...kids));
  }

  /* -------- Shields */
  const shields = section("shields", "Shields",
    toggle("blockAds", "Block ads and trackers", "Uses the filter lists below: blocks ad and tracking requests, hides leftover ad frames and cookie banners, and runs uBlock-style fixes on sites that fight blockers."),
    toggle("fingerprinting", "Fingerprinting protection", "Gives each site slightly different canvas, WebGL, audio and CPU readouts, so they can't be combined into an ID that follows you. Changes every session."),
    toggle("httpsOnly", "Upgrade connections to HTTPS", "Opens every site over HTTPS. If a site doesn't support it, Veil warns you before using plain HTTP."),
    toggle("stripTrackingParams", "Remove tracking parameters from links", "Strips fbclid, gclid, utm_* and 40 other tracking tags before a page loads."),
    select("cookies", "Cookies", "Cross-site cookies let companies follow you between websites. A change here applies after you restart Veil.", [["cross-site", "Block cross-site cookies (recommended)"], ["all", "Block all cookies (many logins will break)"], ["none", "Allow all cookies"]]),
    toggle("gpc", "Send Global Privacy Control", "Tells sites not to sell or share your data. In California and some other places, sites are legally required to honour it."),
    toggle("blockPopups", "Block pop-ups", "Pop-ups a page opens without you clicking anything. You can allow them per site."),
  );

  /* -------- Filter lists */
  const listsBody = h("div");
  const listsCard = section("lists", "Filter lists", listsBody);
  function renderLists(info) {
    const groups = { ads: "Ads", privacy: "Privacy", security: "Security", annoyances: "Annoyances" };
    const status = h("div", { class: "item" },
      h("div", { class: "l" },
        info.networkFilters ? `${num(info.networkFilters)} network and ${num(info.cosmeticFilters)} cosmetic filters` : "No filters loaded yet",
        h("small", {}, info.updating ? "Updating…" : `Updated ${ago(info.updated)}${info.resources ? " · scriptlets loaded" : ""}`)),
      h("button", { class: "btn", disabled: info.updating, onclick: async (e) => {
        e.target.disabled = true; e.target.textContent = "Updating…";
        const r = await call("lists.update").catch((err) => ({ ok: false, error: err.message }));
        if (!r.ok) alert("Couldn't download the filter lists. Veil keeps using the ones it has.");
        renderLists(r.lists ? r : await call("settings.get").then((d) => d.lists));
      } }, "Update now"));
    const rows = [];
    for (const [g, label] of Object.entries(groups)) {
      rows.push(h("div", { class: "group-label" }, label));
      for (const l of info.lists.filter((x) => x.group === g)) {
        const r = l.result;
        rows.push(h("div", { class: "item list-row" },
          h("div", { class: "l" }, h("b", {}, l.name), h("small", {},
            r ? (r.ok ? `${num(r.rules)} rules from ${r.source}` : "Download failed; using the last good copy") : l.on ? "Included in the next update" : "Off",
            " · ", h("a", { href: l.home, target: "_blank", rel: "noreferrer" }, "source"))),
          switchEl(l.on, async (v) => { await call("lists.set", l.id, v); }, l.name)));
      }
    }
    rows.push(h("div", { class: "item" }, h("div", { class: "l" }, h("small", {}, "List changes take effect after the next update. Lists are maintained by their authors: EasyList, uBlock Origin's uAssets, Peter Lowe. Thank you."))));
    listsBody.replaceChildren(status, ...rows);
  }
  renderLists(data.lists);
  on("lists", (info) => renderLists(info));

  /* -------- Search */
  const search = section("search", "Search",
    select("searchEngine", "Search engine", "Used in the address bar and the new tab page. Veil doesn't send what you type to it until you press Enter.", data.engines.map((e) => [e.id, e.name])));

  /* -------- Privacy */
  const clearBoxes = { history: true, cookies: false, cache: true, downloads: false };
  const range = h("select", { "aria-label": "Time range" }, [["3600000", "Last hour"], ["86400000", "Last 24 hours"], ["604800000", "Last 7 days"], ["0", "All time"]].map(([v, t]) => h("option", { value: v, selected: v === "0" }, t)));
  const privacy = section("privacy", "Privacy and data",
    h("div", { class: "item" }, h("div", { class: "l" }, "Clear browsing data", h("small", {}, "Cookies and cache are always cleared for all time.")), range,
      h("button", { class: "btn danger", onclick: async (e) => {
        if (!Object.values(clearBoxes).some(Boolean)) return;
        e.target.disabled = true;
        const ms = Number(range.value);
        await call("data.clear", { ...clearBoxes, since: ms ? Date.now() - ms : 0 });
        e.target.textContent = "Cleared"; setTimeout(() => { e.target.textContent = "Clear"; e.target.disabled = false; }, 1500);
      } }, "Clear")),
    h("div", { class: "checks" }, Object.entries({ history: "History", cookies: "Cookies and site data (signs you out)", cache: "Cached files", downloads: "Download list" }).map(([k, label]) =>
      h("label", {}, h("input", { type: "checkbox", checked: clearBoxes[k], onchange: (e) => { clearBoxes[k] = e.target.checked; } }), label))),
    toggle("clearOnExit", "Clear history, cookies and cache when Veil closes"),
    select("webrtc", "WebRTC IP handling", "Video calls use WebRTC, which can reveal your IP address even behind some VPNs.", [
      ["default_public_interface_only", "Hide local IP addresses (recommended)"],
      ["disable_non_proxied_udp", "Only use the proxy or VPN (calls may fail)"],
      ["default_public_and_private_interfaces", "Allow local addresses"],
      ["default", "Chromium default"],
    ]),
  );

  /* -------- Sites */
  const sitesBody = h("div");
  const sites = section("sites", "Site settings", sitesBody);
  const PERMS = { camera: "Camera", microphone: "Microphone", notifications: "Notifications", "clipboard-read": "Clipboard", midi: "MIDI", midiSysex: "MIDI control", "idle-detection": "Idle detection", "storage-access": "Embedded cookies", fileSystem: "File editing" };
  async function renderSites() {
    const s = await call("sites.list");
    const keys = [...new Set([...Object.keys(s.sites), ...Object.keys(s.perms)])].sort();
    if (!keys.length) {
      sitesBody.replaceChildren(h("div", { class: "item" }, h("div", { class: "l muted" }, "No site has its own settings yet. Changes you make in the Shields panel or permission prompts appear here.")));
      return;
    }
    sitesBody.replaceChildren(...keys.map((k) => {
      const st = s.sites[k] || {};
      const chips = [];
      if (st.shields === false) chips.push(h("span", { class: "chip warn" }, "Shields down"));
      if (st.scripts === "block") chips.push(h("span", { class: "chip" }, "Scripts blocked"));
      if (st.popups) chips.push(h("span", { class: "chip" }, "Pop-ups allowed"));
      const perms = Object.entries(s.perms[k] || {}).map(([name, v]) => h("label", { class: "perm" }, PERMS[name] || name,
        h("select", { onchange: async (e) => { await call("perm.set", k, name, e.target.value); renderSites(); } },
          [["allow", "Allow"], ["block", "Block"], ["ask", "Ask"]].map(([val, t]) => h("option", { value: val, selected: v === val }, t)))));
      return h("div", { class: "item" }, h("div", { class: "l" }, h("div", { class: "site-row" }, h("b", {}, k), chips, perms)),
        h("button", { class: "btn", onclick: async () => { await call("sites.reset", k); renderSites(); } }, "Reset"));
    }));
  }
  renderSites();

  /* -------- Appearance */
  const appearance = section("appearance", "Appearance and startup",
    select("theme", "Theme", "", [["system", "Match the system"], ["light", "Light"], ["dark", "Dark"]]),
    toggle("restoreSession", "Continue where you left off", "Reopen the tabs from your last session (private windows are never restored)."));

  /* -------- Downloads */
  const dirLabel = h("small", {}, data.downloadDir);
  const downloads = section("downloads", "Downloads",
    h("div", { class: "item" }, h("div", { class: "l" }, "Save files to", dirLabel),
      h("button", { class: "btn", onclick: async () => { const d = await call("chooseDownloadDir"); if (d) dirLabel.textContent = d; } }, "Change")),
    toggle("askWhereToSave", "Ask where to save each file"));

  /* -------- Network */
  const network = section("network", "Connections Veil makes",
    h("div", { class: "item" }, h("div", { class: "l" }, h("small", {}, "Veil has no telemetry, no crash reporting, no account and no sync. Other than the sites you visit, these are the only connections it makes on its own. Each can be turned off."))),
    toggle("autoUpdateLists", "Update filter lists daily", "Downloads the lists above from their publishers (or a GitHub mirror if a publisher is unreachable)."),
    toggle("checkForUpdates", "Check for new Veil versions", "Asks GitHub once a day for the latest release number. Nothing is downloaded or installed without you."),
    h("div", { class: "item" }, h("div", { class: "l" }, "Website icons", h("small", {}, "Fetched from the site you're on, with Shields applied and without cookies."))));

  /* -------- About */
  const v = data.versions;
  const upd = h("span", { class: "status" });
  const about = section("about", "About Veil",
    h("div", { class: "item" }, h("div", { class: "l" }, `Veil ${v.veil}`, h("small", {}, `Chromium ${v.chromium} · Electron ${v.electron} · ${v.platform}`)),
      upd, h("button", { class: "btn", onclick: async () => {
        upd.textContent = "Checking…";
        const r = await call("checkForUpdates");
        upd.textContent = !r?.ok ? "Couldn't reach GitHub" : r.newer ? `Veil ${r.latest} is available` : "Veil is up to date";
        if (r?.newer) upd.append(" · ", h("a", { href: "https://github.com/Ethos6/veil/releases/latest", target: "_blank" }, "Download"));
      } }, "Check for updates")),
    h("div", { class: "item" }, h("div", { class: "l" }, "User agent", h("small", {}, h("code", {}, v.userAgent)))),
    h("div", { class: "item" }, h("div", { class: "l" }, "Profile folder", h("small", {}, h("code", {}, v.profile)))),
    h("div", { class: "item" }, h("div", { class: "l" }, h("a", { href: "veil://about/" }, "Credits and licences"), " · ", h("a", { href: "https://github.com/Ethos6/veil", target: "_blank" }, "Source code"), " · ", h("a", { href: "https://github.com/Ethos6/veil/issues", target: "_blank" }, "Report a problem"))));

  content.replaceChildren(shields, listsCard, search, privacy, sites, appearance, downloads, network, about);
  if (location.hash) document.querySelector(location.hash)?.scrollIntoView();
})();
