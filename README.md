# Cyber Rakshak command line

`cyberrakshak` signs in to your Cyber Rakshak console from the terminal, sets up error monitoring for your apps,
servers and scripts, and reads your company's laptops, security events and servers. It shows what the console shows
you, and nothing more; for security it only reads.

Node.js 18 or later. No dependencies.

```sh
npm install -g @cyberrakshak/cli
cyberrakshak login
```

## Signing in

```sh
cyberrakshak login                 # opens your browser; sign in as on the website, check the computer's name, press Allow
cyberrakshak login --no-browser    # SSH and servers: shows a code to enter at /cli/activate on any phone or computer
cyberrakshak login --read-only     # a sign-in that only reads: it cannot make app keys (CI and servers)
cyberrakshak whoami                # who you are signed in as, your organisation, and what your account has
cyberrakshak logout                # ends the sign-in in the console, then removes it from this computer
```

`login` signs in the way the website does (password, Google, Microsoft or Apple, and two-factor). If you signed in to
the website more than 10 minutes before, the console asks you to confirm it is you before Allow. The browser is sent
back only to this computer (`http://127.0.0.1:<port>/callback`), with a one-time code that works for a minute and
only with a secret this command keeps in memory (PKCE). With `--no-browser`, the code lasts 10 minutes; the page you
enter it on names the computer that asked, where it asked from and where your browser is, and says so when those are
different networks: check them before you press Allow.

The sign-in is kept for your user only: `%APPDATA%\cyberrakshak\credentials.json` on Windows,
`~/.config/cyberrakshak/credentials.json` on macOS and Linux (`$XDG_CONFIG_HOME` if set), mode 0600. It is a sign-in for
the command line only: it does not open the website, the apps or anything else. It ends when you run `logout`, when
you revoke it in the console (**Sign-in & two-factor → Command line**, which lists every computer it is signed in on),
after 30 days unused, or a year after it was made. It is not one of your plan's computers.

**Read-only.** `login --read-only` (with either flow) asks for a sign-in that reads everything a full one does (sites,
errors, laptops, alerts, servers) but cannot make or replace an app key; `keys create` with it says it needs a full
sign-in. Give CI and servers a read-only one.

**CI and servers.** `CYBERRAKSHAK_TOKEN`, when set, is used as the sign-in. To make one:
`cyberrakshak login --no-browser --read-only --print-token` prints a read-only token once without saving it; store it
as a secret. A job that only reports failures (`cyberrakshak run`) needs no sign-in at all, only the site's app key.

**Another console.** `--console <url>` or `CYBERRAKSHAK_CONSOLE` (default `https://app.cyberrakshak.ai`). Each console
keeps its own sign-in. Plain `http://` only for this computer (`127.0.0.1`, `localhost`).

## Error monitoring

```sh
cyberrakshak sites                        # your websites; with error monitoring, its state, app key and open problems
cyberrakshak keys create example.com      # the site's app key, shown once (--replace makes a new one in its place)
cyberrakshak init --site example.com      # in your project's folder: the library, the key in .env, how it starts
cyberrakshak test                         # sends a test problem with the app key and checks it arrived
cyberrakshak run -- ./backup.sh --target s3://bucket   # runs it; if it fails, reports it
cyberrakshak errors example.com           # the site's problems (--resolved, --platform server, --page 2)
```

**`init`** works out what the folder is (`package.json` for Node.js or React Native / Expo, `composer.json`,
`requirements.txt` or `pyproject.toml`, Android Gradle, `Package.swift` or an Xcode project; otherwise shell scripts)
and installs the library from its registry: `npm install @cyberrakshak/monitor` or `@cyberrakshak/react-native`,
`pip install cyberrakshak-monitor`, `composer require cyberrakshak/monitor`; for Android and iOS it prints the Gradle
(JitPack) or Swift Package Manager lines to add. If the package manager is not there or fails, or with
`--from download`, the file is downloaded from the console's `/sdk/` and checked against the SHA-256 its
`/sdk/index.json` lists before it is written; shell scripts always get the file (`cr-report.sh`).

The key: `--key`, or `CR_MONITOR_KEY`, or the one already in `.env`; with `--site` and none of those, a key is made for
the site (if it has one, `init` asks for it, or `--new-key` makes a new one, and the old one stops working at once).
It is written to `.env` as `CR_MONITOR_KEY` (`EXPO_PUBLIC_CR_MONITOR_KEY` for Expo), never into a file git tracks; you
are warned when `.env` is not in `.gitignore`. A mobile app carries its key in its build, so for Android, iOS and bare
React Native it says where the key goes instead. `--no-install` only says what to run; `--type` chooses the library;
`--dir` another folder; `--force` replaces a downloaded file you changed.

**`test`** sends a warning named "Test from the Cyber Rakshak command line" with the app key, then reads the site's
Errors page through the console until it is there (up to 15 seconds). Repeated tests add to that one problem.

**`run`** runs the command as it is: its output passes through and `cyberrakshak` ends with the command's exit code.
If it fails, it is reported with the app key (`--key`, `CR_MONITOR_KEY` or `.env`): the command's name (never its
arguments), its exit code and the last 20 lines of its standard error, scrubbed of email addresses, tokens and keys,
`password=` values, query strings and card numbers, by the same rules as every Cyber Rakshak library. Ctrl+C is not
reported. `--route` names it; `CR_MONITOR_ENVIRONMENT` and `CR_MONITOR_RELEASE` are sent when set.

## Security (read-only)

```sh
cyberrakshak laptops            # your company's laptops and their status (--status online|offline|critical|warning|secure|unknown|stale, --search)
cyberrakshak alerts             # security events not reviewed yet (--all for every one)
cyberrakshak servers            # your servers and what they saw in 24 hours
cyberrakshak servers alerts     # the newest alerts (--period 24h|7d|30d, --serious)
```

Laptops and security events are for whoever manages the company in the console (its owner and admins); a company that
asks its managers for two-factor sign-in shows them nothing without it, here as on the website. Servers are for the
accounts that see Servers in the console, and each person on a server team sees the servers their role sees. Nothing
here quarantines, blocks or changes a setting: that is done in the console.

## For scripts

Every command takes `--json`: one JSON document on standard output (an error is `{"error": {"code", "message"}}`),
notes and progress on standard error.

| Exit code | Meaning |
|---|---|
| 0 | Done |
| 1 | It ran and did not succeed (a test that did not arrive, a download that did not match, a key that is already there) |
| 2 | The command or its options were wrong |
| 3 | Not signed in, or the sign-in has ended (signed out, revoked, unused for 30 days, a year old) |
| 4 | Not available on your account, or not found on it |
| 5 | The console could not be reached, did not answer in 15 seconds, or had a problem answering |

`run` ends with the command's own exit code. No request waits longer than 15 seconds; `login` waits at most 5 minutes
for Allow, `login --no-browser` until its code expires (10 minutes).

## Development

```sh
npm test                       # against test/fake-console.mjs (127.0.0.1 only: never a real Cyber Rakshak host)
node scripts/check-pack.mjs    # exactly what npm would publish, with each file's SHA-256
```

`lib/scrub.mjs` holds the scrubbing rules every Cyber Rakshak monitoring library shares; `test/scrub-vectors.json` is
their shared set of cases, copied from the console's `tests/sdk/`. The registries `init` installs from are in
`lib/sdk.mjs`: should a package ever be withdrawn, set its `published` to false there and `init` downloads the
console's file instead.

## For maintainers

**Versions.** `version` in `package.json` and `VERSION` in `lib/version.mjs` are the same (`check-pack.mjs` fails
otherwise). A release: set both, add a `CHANGELOG.md` entry, commit, tag `vX.Y.Z` and push the tag.

**Publishing is by tag, through npm's trusted publishing** (`.github/workflows/publish.yml`): GitHub's OIDC token is
exchanged for a short-lived npm token, so no npm token is stored in this repository or its secrets, and every version
gets a provenance statement linking it to the commit and workflow run that built it. A version already on npm is
skipped.

**1.0.0 is published once by hand**, because npm lets a trusted publisher be set only on a package that exists:

1. As the npm account that owns the `cyberrakshak` organisation (two-factor on), in a clean checkout at the `v1.0.0`
   commit: `npm login`, `npm test`, `node scripts/check-pack.mjs`, `npm publish --access public`.
2. On npmjs.com, `@cyberrakshak/cli` → Settings → Trusted publishing → GitHub Actions: organisation
   `LaabamOne-Business-Solutions-Pvt-Ltd`, repository `cyberrakshak-cli`, workflow `publish.yml`, environment `npm`.
3. Settings → Publishing access: "Require two-factor authentication and disallow tokens".
4. Push the tag `v1.0.0`: the workflow runs every check and skips the version npm has.
5. In the console, `CLI_PUBLISHED=true` in production's `.env` shows the install line (the "Command line" tab on a
   site's "Apps, servers and scripts" card, and Sign-in & two-factor), with a What's new entry.

## Licence

MIT. Copyright (c) 2026 Laabam One Business Solutions (OPC) Private Limited. See [LICENSE](LICENSE).
