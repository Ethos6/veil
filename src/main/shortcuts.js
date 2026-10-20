// Keyboard shortcuts. On Windows and Linux they are matched from key events; on macOS
// they live in the application menu, where the system expects them.

/**
 * Every browser action with a shortcut. `mac` is an Electron accelerator for the menu;
 * `keys` are matched on Windows and Linux ("mod" is Ctrl).
 * @type {{ id: string, label: string, mac?: string, keys?: string[], arg?: any }[]}
 */
export const ACTIONS = [
  { id: "newTab", label: "New Tab", mac: "Cmd+T", keys: ["mod+t"] },
  { id: "newWindow", label: "New Window", mac: "Cmd+N", keys: ["mod+n"] },
  { id: "privateWindow", label: "New Private Window", mac: "Cmd+Shift+N", keys: ["mod+shift+n"] },
  { id: "reopenTab", label: "Reopen Closed Tab", mac: "Cmd+Shift+T", keys: ["mod+shift+t"] },
  { id: "closeTab", label: "Close Tab", mac: "Cmd+W", keys: ["mod+w", "mod+f4"] },
  { id: "closeWindow", label: "Close Window", mac: "Cmd+Shift+W", keys: ["mod+shift+w"] },
  { id: "focusAddress", label: "Open Location…", mac: "Cmd+L", keys: ["mod+l", "alt+d", "f6"] },
  { id: "reload", label: "Reload", mac: "Cmd+R", keys: ["mod+r", "f5"] },
  { id: "hardReload", label: "Reload Without Cache", mac: "Cmd+Shift+R", keys: ["mod+shift+r", "mod+f5", "shift+f5"] },
  { id: "back", label: "Back", mac: "Cmd+[", keys: ["alt+left", "browserback"] },
  { id: "forward", label: "Forward", mac: "Cmd+]", keys: ["alt+right", "browserforward"] },
  { id: "home", label: "Home", mac: "Cmd+Shift+H", keys: ["alt+home"] },
  { id: "nextTab", label: "Next Tab", mac: "Ctrl+Tab", keys: ["mod+tab", "mod+pagedown"] },
  { id: "prevTab", label: "Previous Tab", mac: "Ctrl+Shift+Tab", keys: ["mod+shift+tab", "mod+pageup"] },
  ...[1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({ id: "selectTab", arg: n - 1, label: `Tab ${n}`, mac: `Cmd+${n}`, keys: [`mod+${n}`, `alt+${n}`] })),
  { id: "lastTab", label: "Last Tab", mac: "Cmd+9", keys: ["mod+9", "alt+9"] },
  { id: "find", label: "Find…", mac: "Cmd+F", keys: ["mod+f", "f3"] },
  { id: "findNext", label: "Find Next", mac: "Cmd+G", keys: ["mod+g"] },
  { id: "findPrev", label: "Find Previous", mac: "Cmd+Shift+G", keys: ["mod+shift+g", "shift+f3"] },
  { id: "zoomIn", label: "Zoom In", mac: "Cmd+Plus", keys: ["mod+=", "mod+plus", "mod+shift+=", "mod+numadd"] },
  { id: "zoomOut", label: "Zoom Out", mac: "Cmd+-", keys: ["mod+-", "mod+numsub"] },
  { id: "zoomReset", label: "Actual Size", mac: "Cmd+0", keys: ["mod+0", "mod+num0"] },
  { id: "bookmark", label: "Bookmark This Page", mac: "Cmd+D", keys: ["mod+d"] },
  { id: "history", label: "History", mac: "Cmd+Y", keys: ["mod+h"] },
  { id: "bookmarks", label: "Bookmarks", mac: "Cmd+Alt+B", keys: ["mod+shift+o"] },
  { id: "downloads", label: "Downloads", mac: "Cmd+Shift+J", keys: ["mod+j"] },
  { id: "settings", label: "Settings…", mac: "Cmd+,", keys: [] },
  { id: "print", label: "Print…", mac: "Cmd+P", keys: ["mod+p"] },
  { id: "viewSource", label: "View Page Source", mac: "Cmd+Alt+U", keys: ["mod+u"] },
  { id: "devtools", label: "Developer Tools", mac: "Cmd+Alt+I", keys: ["f12", "mod+shift+i", "mod+shift+j"] },
  { id: "fullscreen", label: "Toggle Full Screen", mac: "Ctrl+Cmd+F", keys: ["f11"] },
  { id: "stop", label: "Stop", mac: "", keys: [] },
  { id: "quit", label: "Quit Veil", mac: "", keys: ["mod+shift+q"] },
];

const KEY_NAMES = {
  arrowleft: "left", arrowright: "right", arrowup: "up", arrowdown: "down", "+": "plus",
  browserback: "browserback", browserforward: "browserforward",
};

/**
 * Turn an Electron input event into a normalized chord such as "mod+shift+t".
 * @param {{ key: string, code?: string, control?: boolean, shift?: boolean, alt?: boolean, meta?: boolean }} input
 */
export function chordOf(input) {
  let key = String(input.key || "").toLowerCase();
  // Digits and letters by physical key, so Shift and keyboard layouts don't change them.
  const code = input.code || "";
  if (/^Digit\d$/.test(code)) key = code.slice(5);
  else if (/^Key[A-Z]$/.test(code)) key = code.slice(3).toLowerCase();
  else if (/^Numpad(\d)$/.test(code)) key = "num" + code.slice(6);
  else if (code === "NumpadAdd") key = "numadd";
  else if (code === "NumpadSubtract") key = "numsub";
  else if (code === "Equal") key = "=";
  else if (code === "Minus") key = "-";
  key = KEY_NAMES[/** @type {keyof typeof KEY_NAMES} */ (key)] || key;
  const parts = [];
  if (input.control || input.meta) parts.push("mod");
  if (input.alt) parts.push("alt");
  if (input.shift) parts.push("shift");
  parts.push(key);
  return parts.join("+");
}

/** @type {Map<string, { id: string, arg?: any }>} */
const BY_CHORD = new Map();
for (const a of ACTIONS) for (const k of a.keys || []) BY_CHORD.set(k, { id: a.id, arg: a.arg });

/**
 * The action for a key press on Windows/Linux, or null.
 * @param {{ type: string, key: string, code?: string, control?: boolean, shift?: boolean, alt?: boolean, meta?: boolean, isAutoRepeat?: boolean }} input
 */
export function matchShortcut(input) {
  if (input.type !== "keyDown" && input.type !== "rawKeyDown") return null;
  return BY_CHORD.get(chordOf(input)) || null;
}
