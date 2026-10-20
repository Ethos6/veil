"use strict";
(() => {
  const { h, call, host, tile } = window.V;
  const $ = (id) => document.getElementById(id);
  let items = [];

  async function load() {
    items = await call("bookmarks.list");
    render();
  }

  function render() {
    const q = $("q").value.toLowerCase();
    const shown = q ? items.filter((b) => b.url.toLowerCase().includes(q) || b.title.toLowerCase().includes(q)) : items;
    if (!shown.length) {
      $("list").replaceChildren(h("div", { class: "empty" }, q ? "No matching bookmarks" : "Press the star in the address bar to bookmark a page. You can also import bookmarks exported from another browser."));
      return;
    }
    $("list").replaceChildren(...shown.map((b) => {
      const row = h("div", { class: "entry" });
      const view = () => row.replaceChildren(
        tile(host(b.url)),
        h("span", { class: "txt" }, h("a", { href: b.url, title: b.url }, b.title || b.url), h("span", { class: "u" }, host(b.url))),
        h("button", { class: "x act", title: "Edit", "aria-label": "Edit bookmark", onclick: edit }, "✎"),
        h("button", { class: "x act", title: "Delete", "aria-label": "Delete bookmark", onclick: async () => { await call("bookmarks.remove", b.id); load(); } }, "×"));
      const edit = () => {
        const title = h("input", { type: "text", value: b.title, "aria-label": "Title" });
        const url = h("input", { type: "url", value: b.url, "aria-label": "Address" });
        const save = async () => { await call("bookmarks.update", b.id, { title: title.value, url: url.value }); load(); };
        row.replaceChildren(h("div", { class: "edit" }, title, url), h("button", { class: "btn primary", onclick: save }, "Save"), h("button", { class: "btn", onclick: view }, "Cancel"));
        title.focus();
      };
      view();
      return row;
    }));
  }

  $("q").addEventListener("input", render);
  $("import").addEventListener("click", async () => {
    const n = await call("bookmarks.import");
    if (n) alert(`Imported ${n} bookmark${n === 1 ? "" : "s"}.`);
    load();
  });
  $("export").addEventListener("click", () => call("bookmarks.export"));
  window.veil.on("bookmarks", load);
  load();
})();
