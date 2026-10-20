# Contributing to Veil

Thanks for helping make Veil better. Bug reports, site-breakage reports and pull requests are all welcome.

## Reporting a site that breaks

If a site doesn't work in Veil, try turning Shields off for it (the shield button in the toolbar). If it works with Shields down, open an issue with the **Site breakage** template and say which site and what fails. If a specific filter list rule is at fault, the list's own maintainers fix it fastest; we'll pass it on.

## Development

```bash
npm ci
npm run lists      # compile the filter lists (needs network)
npm start          # run from source
npm test           # unit tests
npm run typecheck
npm run test:e2e   # end-to-end tests; on Linux run under xvfb-run
```

The code is plain JavaScript (ES modules) with JSDoc types checked by TypeScript:

| Folder | What lives there |
| --- | --- |
| `src/main/` | Main process: windows and tabs, the request pipeline (`network.js`), the filter engine wrapper (`blocker.js`), privacy helpers, settings and storage. |
| `src/preload/` | `content.cjs` runs in every frame of web pages (cosmetic filters, fingerprint protection); `ui.cjs` serves the toolbar. |
| `src/ui/` | The toolbar, tab strip and panels. |
| `src/pages/` | Veil's own pages: new tab, settings, history, bookmarks, downloads, errors, about. |
| `test/` | Unit tests, end-to-end tests and the local test sites they use. |

## Pull requests

- Keep changes focused, and add or update a test that fails without your change.
- Security rules that must hold:
  - Web pages run sandboxed with context isolation.
  - Untrusted text reaches the DOM only as text, never as HTML.
  - Every IPC handler checks who's calling.
  - New network connections Veil makes on its own must be listed in the README and be possible to switch off.
- Run `npm test`, `npm run typecheck` and the end-to-end tests before opening the PR. CI runs them too.
- Write in plain words: user-facing text should make sense to someone who doesn't know what a "tracker" is.

By contributing you agree that your contribution is licensed under the MIT licence.
