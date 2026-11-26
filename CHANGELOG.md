# Changelog

## [1.1.0] - 2026-11-26

- Apps as items of their own, as the console's Apps & websites has them since 2026-11-26: a mobile app, an API, an
  MCP server, or a script or cron job, each with its own key and Errors page. `sites` lists them after the websites;
  `apps` lists them; `apps add <name> --kind mobile|api|mcp|script [--region india|eu]` adds one and shows its key
  once. `keys create`, `errors` and `test` take an app by its name (a website still by its address); `init --app
  <name>` sets one up, and with `--kind` adds it first when there is none.
- Data kept in the EU: `init` writes a website's or an app's EU address beside its key, as `CR_MONITOR_ENDPOINT`
  (`EXPO_PUBLIC_CR_MONITOR_ENDPOINT` for Expo), and the start lines pass it to the library. `test` and `run` send to
  `CR_MONITOR_ENDPOINT` from the environment or `.env`; `test` otherwise sends to the address the console gives, and
  says when it is not set. A report refused for going to the wrong region says the address to set.

## [1.0.0] - 2026-11-21

- The first release of `@cyberrakshak/cli`: `login` (through the browser, with PKCE; `--no-browser` with a code, for
  SSH and servers; `--read-only` for a sign-in that cannot make app keys, for CI), `whoami`, `logout`; error monitoring: `sites`, `keys create`, `init` (the library from its registry,
  or the console's file checked by SHA-256; the app key in `.env`), `test`, `run`, `errors`; security, read-only:
  `laptops`, `alerts`, `servers`. `--json` everywhere. Node.js 18 or later; no dependencies.
