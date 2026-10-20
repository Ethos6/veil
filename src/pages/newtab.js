"use strict";
(async () => {
  const { h, call, num, duration, ago, host, tile } = window.V;
  const $ = (id) => document.getElementById(id);

  $("search").addEventListener("submit", (e) => {
    e.preventDefault();
    const q = $("q").value.trim();
    if (q) call("search", q);
  });

  const s = await call("stats.get");
  $("s-blocked").textContent = num(s.blocked);
  $("s-upgraded").textContent = num(s.upgraded);
  $("s-time").textContent = duration(s.msSaved);
  $("q").placeholder = `Search with ${s.engine} or enter an address`;
  if (s.private) {
    $("private").hidden = false;
    document.body.classList.add("private");
    window.veil.on("theme", () => { document.documentElement.dataset.theme = "dark"; });
    document.documentElement.dataset.theme = "dark";
    document.title = "New Private Tab";
  }
  $("top").replaceChildren(...s.top.map((t) => h("a", { href: t.url, title: t.title || t.url }, tile(t.site), h("span", {}, t.title ? t.title.split(/[|–—:-]/)[0].trim() || host(t.url) : host(t.url)))));
  $("foot").textContent = s.lists.networkFilters
    ? `Shields: ${num(s.lists.networkFilters)} filters loaded${s.lists.updated ? `, updated ${ago(s.lists.updated)}` : ""} · counting since ${new Date(s.since).toLocaleDateString()}`
    : "Shields: downloading filter lists…";
})();
