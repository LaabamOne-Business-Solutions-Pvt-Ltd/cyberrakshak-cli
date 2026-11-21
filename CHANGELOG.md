# Changelog

## [1.0.0] - 2026-11-21

- The first release of `@cyberrakshak/cli`: `login` (through the browser, with PKCE; `--no-browser` with a code, for
  SSH and servers; `--read-only` for a sign-in that cannot make app keys, for CI), `whoami`, `logout`; error monitoring: `sites`, `keys create`, `init` (the library from its registry,
  or the console's file checked by SHA-256; the app key in `.env`), `test`, `run`, `errors`; security, read-only:
  `laptops`, `alerts`, `servers`. `--json` everywhere. Node.js 18 or later; no dependencies.
