// Preload for the browser's own toolbar and tab strip (veil://ui). Only that view gets it.
"use strict";
const { ipcRenderer, contextBridge } = require("electron");

/** @type {Map<string, Set<Function>>} */
const listeners = new Map();
ipcRenderer.on("veil:ui-event", (_e, name, data) => {
  for (const fn of listeners.get(name) || []) {
    try { fn(data); } catch (err) { console.error(err); }
  }
});

contextBridge.exposeInMainWorld("veilUI", {
  call: (method, ...args) => ipcRenderer.invoke("veil:ui", String(method), ...args),
  on: (name, fn) => {
    if (typeof fn !== "function") return;
    if (!listeners.has(name)) listeners.set(name, new Set());
    listeners.get(name).add(fn);
  },
  platform: process.platform,
});
