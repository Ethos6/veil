# Changelog

## 1.0.0 – 2026-10-20

First release.

- **Shields**, on by default:
  - Ad and tracker blocking with EasyList, EasyPrivacy, uBlock filters, Peter Lowe's list and cookie-notice lists.
  - Cosmetic filtering and uBlock-style scriptlets and redirects.
  - Badware and tracker page blocking.
  - `$csp` rules.
- **Privacy:**
  - Cross-site cookies blocked inside Chromium, with Storage Access prompts.
  - Brave-style fingerprint randomisation of canvas, WebGL and audio.
  - HTTPS-only mode with a fallback warning.
  - Tracking-parameter removal and Global Privacy Control.
- **Prompts:** pop-ups and downloads a page starts without a click are held until you allow them.
- **No Google services or telemetry:**
  - Privacy Sandbox ad APIs disabled.
  - Plain Chrome user agent.
  - Internal pages can't be detected by websites.
- **Browser:**
  - Tabs, private windows with their own session each.
  - History, bookmarks with import/export, downloads.
  - Find, zoom, permissions.
  - Settings, session restore and clear-on-exit.
  - Light, dark and private themes.
- **Builds:** installers for Windows, macOS (Apple silicon and Intel) and Linux (AppImage, deb), with hardened Electron fuses.
