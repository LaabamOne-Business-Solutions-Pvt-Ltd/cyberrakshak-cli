// The command line: read the command and its options, run it, and end with an exit code (README: "Exit codes").
import { loginWithBrowser, loginWithCode, logout, whoami } from './auth.mjs';
import { consoleUrl } from './config.mjs';
import { CliError, EXIT, usage } from './errors.mjs';
import { init } from './init.mjs';
import { addApp, APP_KINDS, apps, createKey, errors, REGIONS, sites, testKey } from './monitoring.mjs';
import { note, printJson } from './output.mjs';
import { runCommand } from './run.mjs';
import { alerts, laptops, serverAlerts, servers } from './security.mjs';
import { TYPES } from './sdk.mjs';
import { VERSION } from './version.mjs';

const BOOLEAN = new Set(['json', 'help', 'version', 'no-browser', 'print-token', 'read-only', 'replace', 'resolved', 'serious', 'all', 'no-install', 'force', 'new-key']);
const VALUE = new Set(['console', 'key', 'site', 'app', 'kind', 'region', 'type', 'from', 'dir', 'platform', 'page', 'status', 'search', 'period', 'route']);

export function parse(argv) {
  const positional = [];
  const flags = {};
  let rest = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      rest = argv.slice(i + 1);
      break;
    }
    if (a === '-h') {
      flags.help = true;
      continue;
    }
    if (a === '-v') {
      flags.version = true;
      continue;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = eq === -1 ? a.slice(2) : a.slice(2, eq);
      if (BOOLEAN.has(name)) {
        if (eq !== -1) throw usage(`--${name} takes no value.`);
        flags[name] = true;
      } else if (VALUE.has(name)) {
        const value = eq !== -1 ? a.slice(eq + 1) : argv[++i];
        if (value === undefined || (eq === -1 && value.startsWith('--'))) throw usage(`--${name} needs a value.`);
        flags[name] = value;
      } else {
        throw usage(`Unknown option --${name}. See: cyberrakshak --help`);
      }
      continue;
    }
    positional.push(a);
  }
  return { positional, flags, rest };
}

const HELP = {
  main: `Cyber Rakshak command line ${VERSION}

Usage: cyberrakshak <command> [options]

Signing in
  login                 Sign in through your browser
  login --no-browser    Sign in with a code, from any phone or computer (SSH, servers)
  login --read-only     A sign-in that only reads (it cannot make app keys): for CI and servers
  whoami                Who you are signed in as, and what your account has
  logout                Sign out: the sign-in stops working, and is removed from this computer

Error monitoring
  sites                 Your websites, and your apps
  apps                  Your apps: mobile apps, APIs, MCP servers, scripts
  apps add <name>       Add an app, with its key (shown once): --kind mobile|api|mcp|script
  keys create <name>    Make a website's or an app's key (shown once)
  init                  Set up error monitoring in this project
  test [name]           Send a test problem with the app key and check it arrived
  run -- <command>      Run a command; if it fails, report it with the app key
  errors <name>         A website's or an app's recent problems

A website is named by its address (example.com), an app by its name ("Shop app"), either by its id.

Security (read-only)
  laptops               Your company's laptops and their status
  alerts                Open security events on your company's laptops
  servers               Your servers, and what they saw in 24 hours
  servers alerts        The newest alerts on your servers

Options for every command
  --json                One JSON document on standard output, for scripts
  --console <url>       Another console (default https://app.cyberrakshak.ai, or CYBERRAKSHAK_CONSOLE)
  --help                Help for a command, e.g. cyberrakshak init --help
  --version             The version

CYBERRAKSHAK_TOKEN, when set, is used as the sign-in (CI and servers: see login --help).`,
  login: `Usage: cyberrakshak login [--no-browser] [--read-only] [--print-token]

Signs this computer in to Cyber Rakshak. Your browser opens the console; sign in there as on the website (password,
Google, Microsoft or Apple, and two-factor), check the computer's name, and press Allow. The terminal is then signed in.

  --no-browser    For SSH and servers: shows a short code to enter at the console's /cli/activate page on any phone
                  or computer. The code expires in 10 minutes.
  --read-only     A sign-in that reads everything a full one does but cannot make or replace an app key. Use it for
                  CI and servers: cyberrakshak login --no-browser --read-only --print-token
  --print-token   For CI: prints the token once instead of saving it. Store it as the secret CYBERRAKSHAK_TOKEN.

The sign-in is saved for your user only (Windows %APPDATA%\\cyberrakshak, macOS and Linux ~/.config/cyberrakshak). It
can see your websites' errors and make their app keys (not with --read-only), and read your company's laptops,
security events and servers where your account has them. It cannot change security settings, quarantine files or block addresses. It ends when
you run logout, when you revoke it in the console (Sign-in & two-factor → Command line), after 30 days unused, or a
year after sign-in.`,
  logout: 'Usage: cyberrakshak logout\n\nEnds the sign-in in the console, then removes it from this computer.',
  whoami: 'Usage: cyberrakshak whoami\n\nWho you are signed in as, your organisation, and which commands your account has.',
  sites: 'Usage: cyberrakshak sites\n\nYour websites: verified or not, the security score and, with error monitoring, its state, the app key and open problems.\nThen your apps (see: cyberrakshak apps --help).',
  apps: `Usage: cyberrakshak apps
       cyberrakshak apps add <name> --kind mobile|api|mcp|script [--region india|eu]

Your own apps, each an item of its own beside your websites, as the console's Apps & websites lists them: a mobile
app, an API, an MCP server, or a script or cron job, each with its own key and Errors page. Nothing to verify: its
secret key is what says a report is its.

apps add adds one, as Add in the console, and shows its key once. --region says where its data is kept, once the
console keeps data in the EU as well as India (it asks when it does). It cannot be moved later. To add one and set it
up in a project at once: cyberrakshak init --app <name> --kind <kind>`,
  keys: `Usage: cyberrakshak keys create <name> [--replace]

Makes the key of a website (by its address) or an app (by its name), and shows it once (only its last four characters
are kept in the console). If it has one already, --replace makes a new one in its place: the old one stops working at
once, for everything that uses it.`,
  init: `Usage: cyberrakshak init [--site <site> | --app <name> [--kind <kind>] [--region india|eu]] [--key <crk_…>] [--type <type>]
                         [--from registry|download] [--no-install] [--force] [--new-key] [--dir <folder>]

Sets error monitoring up in this project:
  1. Works out what it is (package.json, composer.json, requirements.txt or pyproject.toml, Gradle, Swift or Xcode;
     otherwise shell scripts), or --type: ${TYPES.join(', ')}.
  2. Installs the library from its registry: npm, pip or composer (Android and iOS: prints the Gradle or Swift
     Package Manager lines to add). If the package manager is not there or fails, or with --from download, the file
     is downloaded from the console and checked against the SHA-256 it lists. Shell scripts get the file.
  3. Writes the app key to .env (never into a file git tracks; warns when .env is not ignored), or says where it goes
     in a mobile app. The key: --key, or CR_MONITOR_KEY, or the one in .env; with --site (a website, by its address)
     or --app (an app, by its name) and none of those, a key is made for it (--new-key makes one even if it has one:
     the old one stops working). With --app and --kind, an app of that name is added first if there is none.
     A website or app whose data is kept in the EU reports to the EU server: its address goes in .env beside the key,
     as CR_MONITOR_ENDPOINT (EXPO_PUBLIC_CR_MONITOR_ENDPOINT for Expo).
  4. Prints how the library starts.`,
  test: `Usage: cyberrakshak test [<site or app>] [--key <crk_…>]

Sends a test problem with the app key (--key, CR_MONITOR_KEY or .env), to CR_MONITOR_ENDPOINT if it is set (else to the
address the console gives the website or app), then reads its Errors page through the console until it is there (up to
15 seconds). It shows as the warning "Test from the Cyber Rakshak command line"; repeated tests add to that one problem.`,
  run: `Usage: cyberrakshak run [--route <name>] [--key <crk_…>] -- <command> [arguments…]

Runs the command as it is: its output passes through and this ends with its exit code. If it fails, it is reported
with the app key (--key, CR_MONITOR_KEY or .env) to CR_MONITOR_ENDPOINT (or .env's): the command's name (never its arguments),
its exit code and the last 20 lines of its standard error, scrubbed of email addresses, tokens, keys, passwords and
card numbers. Ctrl+C is not reported. CR_MONITOR_ENVIRONMENT and CR_MONITOR_RELEASE are sent when set.`,
  errors: 'Usage: cyberrakshak errors <site or app> [--resolved] [--platform browser|mobile|server|script|desktop|other] [--page <n>]\n\nIts problems, newest first (25 a page), as its Errors page lists them. Read-only.',
  laptops: 'Usage: cyberrakshak laptops [--status online|offline|critical|warning|secure|unknown|stale] [--search <text>]\n\nYour company\'s laptops as the console\'s Devices page shows them, for its owner and admins. Read-only.',
  alerts: 'Usage: cyberrakshak alerts [--all]\n\nSecurity events not reviewed yet, as the console\'s Security events page opens; --all includes reviewed ones. Read-only.',
  servers: 'Usage: cyberrakshak servers\n       cyberrakshak servers alerts [--period 24h|7d|30d] [--serious]\n\nYour servers and their alerts, for the accounts that see Servers in the console, as it shows them. Read-only.',
};

function help(ctx, topic) {
  ctx.out.write((HELP[topic] || HELP.main) + '\n');
}

const page = (v) => {
  if (v === undefined) return 1;
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n) || n < 1 || String(n) !== String(v)) throw usage('--page is a page number (1, 2, …).');
  return n;
};

export async function main(argv, io = {}) {
  const ctx = {
    out: io.out || process.stdout,
    err: io.err || process.stderr,
    env: io.env || process.env,
    // Known before the rest is read, so even a wrong option is answered in JSON.
    json: argv.includes('--json'),
    console: null,
    timeoutMs: io.timeoutMs,
    // Tests: a stand-in for the browser, and the folder a command works in.
    openBrowser: io.openBrowser,
    cwd: io.cwd || process.cwd(),
  };
  let parsed;
  try {
    parsed = parse(argv);
  } catch (e) {
    return fail(ctx, e);
  }
  const { positional, flags, rest } = parsed;
  ctx.json = !!flags.json;
  const [command, sub, ...extra] = positional;
  if (flags.version) {
    ctx.out.write(ctx.json ? JSON.stringify({ version: VERSION }) + '\n' : `cyberrakshak ${VERSION}\n`);
    return EXIT.OK;
  }
  if (!command || command === 'help') {
    help(ctx, sub);
    return command || flags.help ? EXIT.OK : EXIT.USAGE;
  }
  if (flags.help) {
    help(ctx, command);
    return EXIT.OK;
  }
  try {
    ctx.console = consoleUrl(flags.console, ctx.env);
    const none = (n) => {
      if (positional.length > n) throw usage(`Too many words for ${command}. See: cyberrakshak ${command} --help`);
    };
    switch (command) {
      case 'login':
        none(1);
        if (flags['no-browser']) await loginWithCode(ctx, { printToken: !!flags['print-token'], sleepFn: io.sleep, readOnly: !!flags['read-only'] });
        else await loginWithBrowser(ctx, { printToken: !!flags['print-token'], waitMs: io.loginWaitMs, readOnly: !!flags['read-only'] });
        return EXIT.OK;
      case 'logout':
        none(1);
        await logout(ctx);
        return EXIT.OK;
      case 'whoami':
        none(1);
        await whoami(ctx);
        return EXIT.OK;
      case 'sites':
        none(1);
        await sites(ctx);
        return EXIT.OK;
      case 'apps':
        if (sub === undefined) {
          await apps(ctx);
          return EXIT.OK;
        }
        if (sub !== 'add') throw usage('Usage: cyberrakshak apps, or cyberrakshak apps add <name> --kind mobile|api|mcp|script');
        if (extra.length !== 1) throw usage('Say its name, in quotes if it has spaces: cyberrakshak apps add "Shop app" --kind mobile');
        if (!APP_KINDS.includes(flags.kind)) throw usage(`Say what it is: --kind ${APP_KINDS.join(', ')}.`);
        if (flags.region !== undefined && !REGIONS.includes(flags.region)) throw usage('--region is india or eu.');
        await addApp(ctx, extra[0], { kind: flags.kind, region: flags.region || null });
        return EXIT.OK;
      case 'keys':
        if (sub !== 'create') throw usage('Usage: cyberrakshak keys create <site or app> [--replace]');
        if (!extra[0]) throw usage('Say which: cyberrakshak keys create example.com, or keys create "Shop app"');
        if (extra.length > 1) throw usage('One at a time, an app\'s name in quotes if it has spaces: cyberrakshak keys create "Shop app"');
        await createKey(ctx, extra[0], { replace: !!flags.replace });
        return EXIT.OK;
      case 'init':
        none(1);
        if (flags.from && !['registry', 'download'].includes(flags.from)) throw usage('--from is registry or download.');
        if (flags.kind !== undefined && !APP_KINDS.includes(flags.kind)) throw usage(`--kind is ${APP_KINDS.join(', ')}.`);
        if (flags.region !== undefined && !REGIONS.includes(flags.region)) throw usage('--region is india or eu.');
        await init(ctx, { site: flags.site, app: flags.app, kind: flags.kind, region: flags.region, key: flags.key, type: flags.type, from: flags.from, noInstall: !!flags['no-install'], force: !!flags.force, newKey: !!flags['new-key'], dir: flags.dir });
        return EXIT.OK;
      case 'test':
        none(2);
        await testKey(ctx, sub, { key: flags.key, waitMs: io.testWaitMs });
        return EXIT.OK;
      case 'run': {
        if (!rest || rest.length === 0) throw usage('Usage: cyberrakshak run [--route <name>] -- <command> [arguments…]');
        none(1);
        return await runCommand(ctx, rest, { key: flags.key, route: flags.route });
      }
      case 'errors':
        none(2);
        if (flags.platform && !['browser', 'mobile', 'server', 'script', 'desktop', 'other'].includes(flags.platform)) throw usage('--platform is browser, mobile, server, script, desktop or other.');
        await errors(ctx, sub, { resolved: !!flags.resolved, platform: flags.platform || null, page: page(flags.page) });
        return EXIT.OK;
      case 'laptops':
        none(1);
        await laptops(ctx, { status: flags.status || null, search: flags.search || null });
        return EXIT.OK;
      case 'alerts':
        none(1);
        await alerts(ctx, { all: !!flags.all });
        return EXIT.OK;
      case 'servers':
        if (sub === undefined) {
          await servers(ctx);
          return EXIT.OK;
        }
        if (sub !== 'alerts' || extra.length) throw usage('Usage: cyberrakshak servers, or cyberrakshak servers alerts');
        if (flags.period && !['24h', '7d', '30d'].includes(flags.period)) throw usage('--period is 24h, 7d or 30d.');
        await serverAlerts(ctx, { period: flags.period || '24h', serious: !!flags.serious });
        return EXIT.OK;
      default:
        throw usage(`Unknown command "${command}". See: cyberrakshak --help`);
    }
  } catch (e) {
    return fail(ctx, e);
  }
}

function fail(ctx, e) {
  const err = e instanceof CliError ? e : new CliError('failed', `Something went wrong: ${e && e.message ? e.message : e}`, EXIT.FAILED);
  if (ctx.json) printJson(ctx, { error: { code: err.code, message: err.message } });
  else note(ctx, err.message);
  return err.exit;
}
