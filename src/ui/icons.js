// Toolbar icons: 24×24, 1.8 px strokes, drawn for Veil.
"use strict";
(() => {
  const s = (body, extra = "") => `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ${extra}>${body}</svg>`;
  window.ICONS = {
    back: s('<path d="M19 12H5"/><path d="M11 6l-6 6 6 6"/>'),
    forward: s('<path d="M5 12h14"/><path d="M13 6l6 6-6 6"/>'),
    reload: s('<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>'),
    stop: s('<path d="M6 6l12 12M18 6L6 18"/>'),
    plus: s('<path d="M12 5v14M5 12h14"/>'),
    close: s('<path d="M7 7l10 10M17 7L7 17"/>', 'width="14" height="14"'),
    menu: s('<path d="M4 7h16M4 12h16M4 17h16"/>'),
    star: s('<path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8L3.5 9.7l5.9-.9z"/>', 'width="16" height="16"'),
    starOn: s('<path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8L3.5 9.7l5.9-.9z" fill="currentColor"/>', 'width="16" height="16"'),
    lock: s('<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>', 'width="14" height="14"'),
    warn: s('<path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17.5v.01"/>', 'width="14" height="14"'),
    info: s('<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.01"/>', 'width="14" height="14"'),
    veil: s('<path d="M5 6l7 13 7-13"/><path d="M4 6c3 2 13 2 16 0" opacity=".55"/>', 'width="14" height="14"'),
    search: s('<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/>', 'width="16" height="16"'),
    globe: s('<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.5 3.5 5.5 3.5 9s-1 6.5-3.5 9c-2.5-2.5-3.5-5.5-3.5-9s1-6.5 3.5-9z"/>', 'width="16" height="16"'),
    clock: s('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>', 'width="16" height="16"'),
    shield: s('<path d="M12 3l7.5 3v5.5c0 4.6-3.2 8.4-7.5 9.5-4.3-1.1-7.5-4.9-7.5-9.5V6z"/><path d="M8.8 12l2.2 2.2 4.3-4.4"/>'),
    shieldOff: s('<path d="M12 3l7.5 3v5.5c0 4.6-3.2 8.4-7.5 9.5-4.3-1.1-7.5-4.9-7.5-9.5V6z"/><path d="M4 4l16 16"/>'),
    download: s('<path d="M12 4v11"/><path d="M7 10l5 5 5-5"/><path d="M5 20h14"/>'),
    up: s('<path d="M6 15l6-6 6 6"/>', 'width="16" height="16"'),
    down: s('<path d="M6 9l6 6 6-6"/>', 'width="16" height="16"'),
    speaker: s('<path d="M4 10v4h4l5 4V6L8 10z"/><path d="M16.5 9a4 4 0 0 1 0 6"/>', 'width="14" height="14"'),
    muted: s('<path d="M4 10v4h4l5 4V6L8 10z"/><path d="M17 10l4 4M21 10l-4 4"/>', 'width="14" height="14"'),
    folder: s('<path d="M3.5 7.5A1.5 1.5 0 0 1 5 6h4l2 2h8a1.5 1.5 0 0 1 1.5 1.5v8A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5z"/>', 'width="16" height="16"'),
    file: s('<path d="M7 3h7l5 5v12a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><path d="M14 3v5h5"/>', 'width="16" height="16"'),
    expand: s('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>', 'width="16" height="16"'),
  };
})();
