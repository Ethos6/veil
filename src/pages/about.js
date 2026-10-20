"use strict";
(async () => {
  const { h, call, num, ago } = window.V;
  const r = await call("about");
  const v = r.versions;
  document.getElementById("ver").textContent = `Version ${v.veil} · Chromium ${v.chromium}`;
  const row = (k, val) => h("div", { class: "item" }, h("div", { class: "l" }, k, h("small", {}, val)));
  document.getElementById("details").replaceChildren(
    row("Electron", v.electron),
    row("V8", v.v8),
    row("Platform", v.platform),
    row("Filters", `${num(r.lists.networkFilters)} network, ${num(r.lists.cosmeticFilters)} cosmetic · updated ${ago(r.lists.updated)}`),
    row("User agent", v.userAgent),
    row("Profile", v.profile));
})();
