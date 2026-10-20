"use strict";
(() => {
  const { h, call, host, tile } = window.V;
  const $ = (id) => document.getElementById(id);
  let offset = 0;
  let items = [];

  async function load(reset) {
    if (reset) { offset = 0; items = []; }
    const r = await call("history.list", $("q").value, offset);
    items = items.concat(r.items);
    offset = items.length;
    $("more").hidden = items.length >= r.total;
    render();
  }

  function render() {
    const list = $("list");
    if (!items.length) {
      list.replaceChildren(h("div", { class: "empty" }, $("q").value ? "No matching pages" : "Pages you visit will show up here. Private windows are never recorded."));
      return;
    }
    const out = [];
    let day = "";
    const fmtDay = new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" });
    const fmtTime = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });
    for (const e of items) {
      const d = fmtDay.format(new Date(e.last));
      if (d !== day) { day = d; out.push(h("div", { class: "day" }, d)); }
      out.push(h("div", { class: "entry" },
        h("span", { class: "time" }, fmtTime.format(new Date(e.last))),
        tile(host(e.url)),
        h("span", { class: "txt" }, h("a", { href: e.url, title: e.url }, e.title || e.url), h("span", { class: "u" }, host(e.url))),
        h("button", { class: "x act", title: "Remove from history", "aria-label": "Remove from history", onclick: async () => {
          await call("history.delete", e.url);
          items = items.filter((x) => x !== e);
          render();
        } }, "×")));
    }
    list.replaceChildren(...out);
  }

  let t = 0;
  $("q").addEventListener("input", () => { clearTimeout(t); t = setTimeout(() => load(true), 150); });
  $("more").addEventListener("click", () => load(false));
  $("clear").addEventListener("click", () => { location.href = "veil://settings/#privacy"; });
  window.veil.on("history", () => load(true));
  load(true);
})();
