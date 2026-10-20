# Security policy

Veil is a web browser, so security bugs matter. Thank you for helping.

## Reporting a vulnerability

Please report privately through **GitHub → Security → [Report a vulnerability](https://github.com/Ethos6/veil/security/advisories/new)**. Don't open a public issue for security problems.

Include what you can: Veil version (veil://about), operating system, steps or a test page that reproduces the problem, and what an attacker gains. We aim to reply within 3 days and to ship a fix for confirmed high-severity issues within 14 days, crediting you unless you'd rather not be named.

## In scope

- A web page reaching Veil's privileged APIs or pages (`veil://`), reading local files, or escaping the renderer sandbox through Veil's code.
- Bypasses of Shields that Veil claims to provide: cross-site cookie blocking, HTTPS-only mode, pop-up and download prompts, permission prompts, fingerprinting protection in pages and frames.
- Private-window data reaching disk or normal windows.
- Anything that makes Veil users easier to identify than a stock Chrome user.
- Problems in the build and release pipeline.

## Out of scope

- Vulnerabilities in Chromium itself: report them to the [Chromium project](https://www.chromium.org/Home/chromium-security/reporting-security-bugs/). Veil picks up fixes through Electron releases.
- A filter list missing a particular ad: report it to the list's maintainers.
- Limits listed in the README (no protection inside Web Workers, unsigned installers).

## Supported versions

Only the latest release gets security fixes. Veil tells you when a newer version is available.
