"use strict";
(() => {
  const { h, call, on, size, host } = window.V;
  const $ = (id) => document.getElementById(id);
  let items = [];

  function render() {
    const q = $("q").value.toLowerCase();
    const shown = q ? items.filter((d) => d.filename.toLowerCase().includes(q) || d.url.toLowerCase().includes(q)) : items;
    if (!shown.length) {
      $("list").replaceChildren(h("div", { class: "empty" }, q ? "No matching downloads" : "Files you download will show up here."));
      return;
    }
    $("list").replaceChildren(...shown.map((d) => {
      const act = (a) => () => call("downloads.action", d.id, a);
      const busy = d.state === "progressing" || d.state === "paused";
      const status = d.state === "completed" ? (d.exists === false ? "Deleted" : size(d.total || d.received))
        : d.state === "progressing" ? `${size(d.received)} of ${d.total ? size(d.total) : "unknown size"}`
        : d.state === "paused" ? `Paused · ${size(d.received)}` : d.state === "cancelled" ? "Cancelled" : "Failed";
      const buttons = [];
      if (d.state === "completed" && d.exists !== false) buttons.push(h("button", { class: "btn", onclick: act("open") }, "Open"), h("button", { class: "btn", onclick: act("show") }, "Show in folder"));
      if (d.state === "progressing") buttons.push(h("button", { class: "btn", onclick: act("pause") }, "Pause"));
      if (d.resumable) buttons.push(h("button", { class: "btn", onclick: act("resume") }, "Resume"));
      if (busy) buttons.push(h("button", { class: "btn danger", onclick: act("cancel") }, "Cancel"));
      else buttons.push(h("button", { class: "x", title: "Remove from list", "aria-label": "Remove from list", onclick: act("remove") }, "×"));
      return h("div", { class: "card", style: "padding: 12px 16px; display: flex; gap: 14px; align-items: center" },
        h("div", { style: "flex: 1; min-width: 0" },
          h("div", { style: "overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500" }, d.filename),
          busy && d.total ? h("div", { class: "prog" }, h("i", { style: `width: ${Math.round((d.received / d.total) * 100)}%` })) : null,
          h("div", { class: "muted", style: "font-size: 12.5px" }, `${status} · ${host(d.url)} · ${new Date(d.started).toLocaleString()}`)),
        buttons);
    }));
  }

  async function load() { items = await call("downloads.list"); render(); }
  $("q").addEventListener("input", render);
  $("clear").addEventListener("click", async () => { await call("downloads.clear"); load(); });
  on("downloads", (list) => { items = list; render(); });
  load();
})();
