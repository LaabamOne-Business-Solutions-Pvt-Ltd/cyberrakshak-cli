// Error monitoring: your websites and apps, their app keys, their errors, and a test that a key works end to end.
// What each shows is what the console's Apps & websites pages show the same account; while error monitoring is in its
// first phase, the console says which accounts have it (`can.monitoring` in `whoami`). Since 1.1.0 a workspace's own
// apps (a mobile app, an API, an MCP server, or a script or cron job) are items of their own beside its websites, each
// with its own key and Errors page: a website is named by its address, an app by its name.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { call, offline } from './api.mjs';
import { CliError, EXIT, usage } from './errors.mjs';
import { Offline, request } from './http.mjs';
import { ago, line, note, plural, printJson, table } from './output.mjs';
import { VERSION } from './version.mjs';

export const KEY_RE = /^crk_[A-Za-z0-9]{32}$/;
export const KEY_NAMES = ['CR_MONITOR_KEY', 'EXPO_PUBLIC_CR_MONITOR_KEY'];
/** Where reports go, when it is not the console's own address (an EU website's or app's: the EU server's). */
export const ENDPOINT_NAMES = ['CR_MONITOR_ENDPOINT', 'EXPO_PUBLIC_CR_MONITOR_ENDPOINT'];

/** What `apps add` and `init --app --kind` can add, as the console's Add offers them. */
export const APP_KINDS = ['mobile', 'api', 'mcp', 'script'];
export const REGIONS = ['india', 'eu'];

/** The test problem's message: always the same, so repeated tests count as one problem rather than many. */
export const TEST_MESSAGE = 'Test from the Cyber Rakshak command line';

export const masked = (key) => 'crk_••••' + String(key).slice(-4);

/** A name as a command takes it back: example.com as it is, "Shop app" in quotes. */
export const asArg = (name) => (/^[A-Za-z0-9._:/-]+$/.test(String(name)) ? String(name) : '"' + String(name).replace(/(["\\$`])/g, '\\$1') + '"');

/** The account's websites (`sites`) and, where error monitoring is open, its apps (`apps`, from console 2026-11-26). */
export async function listSites(ctx) {
  const res = await call(ctx, 'GET', '/api/v1/cli/sites', { what: 'Websites' });
  const data = res.json || { monitoring: false, sites: [] };
  return { ...data, sites: data.sites || [], apps: data.apps || [] };
}

/** One of them as the commands use it: `label` is how it is named (a website's address, an app's name), `app` which. */
export const target = (item, app) => ({ ...item, label: app ? item.name : item.host, app });

/** A website by its address (example.com, https://www.example.com/…), an app by its name, or either by its id. */
export async function findSite(ctx, wanted) {
  if (!wanted) throw usage('Say which one: a website\'s address (example.com), an app\'s name, or its id. `cyberrakshak sites` lists them.');
  const data = await listSites(ctx);
  const { sites, apps } = data;
  const host = String(wanted).trim().toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/[/?#].*$/, '').replace(/:\d+$/, '');
  const name = String(wanted).trim().replace(/\s+/g, ' ').toLowerCase();
  const site = sites.find((s) => s.id === wanted)
    || sites.find((s) => String(s.host).toLowerCase() === host)
    || sites.find((s) => String(s.host).toLowerCase().replace(/^www\./, '') === host.replace(/^www\./, ''));
  const app = site ? null : (apps.find((a) => a.id === wanted) || apps.find((a) => String(a.name).toLowerCase() === name));
  if (!site && !app) {
    const names = [...sites.map((s) => s.host), ...apps.map((a) => a.name)].join(', ');
    throw new CliError('not_found', `No website or app "${wanted}" on your account.${names ? ' Yours: ' + names + '.' : ' Add one in the console: Apps & websites → Add.'}`, EXIT.NO_ACCESS);
  }
  return { site: site ? target(site, false) : target(app, true), monitoring: !!data.monitoring };
}

function needMonitoring(monitoring) {
  if (!monitoring) throw new CliError('no_access', 'Error monitoring is not available on your account yet.', EXIT.NO_ACCESS);
}

const keyCell = (m) => (m && m.app_key && m.app_key.on ? m.app_key.masked : 'none');
const regionCell = (m) => (m && m.region === 'eu' ? 'EU' : m && m.region ? 'India' : '-');

function appTable(ctx, apps) {
  table(ctx, ['APP', 'KIND', 'DATA IN', 'APP KEY', 'OPEN ERRORS'], apps.map((a) => [
    a.name,
    a.kind_label || a.kind,
    regionCell(a.monitoring),
    keyCell(a.monitoring),
    a.monitoring ? a.monitoring.open : '-',
  ]));
}

export async function sites(ctx) {
  const data = await listSites(ctx);
  if (ctx.json) {
    printJson(ctx, data);
    return;
  }
  const list = data.sites;
  const apps = data.apps;
  if (list.length === 0 && apps.length === 0) {
    line(ctx, data.monitoring
      ? 'Nothing on your account yet. Add a website or an app in the console (Apps & websites → Add), or an app here: cyberrakshak apps add --help'
      : 'No websites on your account yet. Add one in the console: Apps & websites → Add.');
    return;
  }
  if (list.length && data.monitoring) {
    table(ctx, ['SITE', 'VERIFIED', 'SCORE', 'MONITORING', 'APP KEY', 'OPEN ERRORS'], list.map((s) => [
      s.host,
      s.verified ? 'yes' : 'no',
      s.score ?? '-',
      s.monitoring ? (s.monitoring.on ? 'on' : 'off') : '-',
      keyCell(s.monitoring),
      s.monitoring ? s.monitoring.open : '-',
    ]));
  } else if (list.length) {
    table(ctx, ['SITE', 'VERIFIED', 'SCORE', 'LAST SCAN'], list.map((s) => [s.host, s.verified ? 'yes' : 'no', s.score ?? '-', ago(s.last_scanned_at)]));
  }
  if (apps.length) {
    if (list.length) line(ctx, '');
    appTable(ctx, apps);
  }
}

/** `apps`: the workspace's own apps, each with its kind, where its data is kept, its key and its open problems. */
export async function apps(ctx) {
  const data = await listSites(ctx);
  needMonitoring(data.monitoring);
  if (ctx.json) {
    printJson(ctx, { apps: data.apps });
    return;
  }
  if (data.apps.length === 0) {
    line(ctx, 'No apps on your account yet. Add one: cyberrakshak apps add "Shop app" --kind mobile');
    return;
  }
  appTable(ctx, data.apps);
}

/**
 * `apps add <name> --kind …`: one of the workspace's own apps, as Add in the console's Apps & websites, with its key,
 * shown once. Where its data is kept (--region) is asked once the console keeps data in the EU too.
 */
export async function addApp(ctx, name, { kind, region = null } = {}) {
  if (!name || !String(name).trim()) throw usage('Say its name: cyberrakshak apps add "Shop app" --kind mobile');
  if (!APP_KINDS.includes(kind)) throw usage(`Say what it is: --kind ${APP_KINDS.join(', ')}.`);
  if (region !== null && !REGIONS.includes(region)) throw usage('--region is india or eu.');
  const res = await call(ctx, 'POST', '/api/v1/cli/apps', { body: { kind, name, ...(region ? { region } : {}) }, allow: [422], what: 'Adding an app' });
  if (res.status === 422) {
    const errors = (res.json && res.json.errors) || {};
    if (errors.region) throw new CliError('failed', 'Say where its data is kept: --region india or --region eu.', EXIT.USAGE);
    const message = (errors.name && errors.name[0]) || (errors.kind && errors.kind[0]) || (res.json && res.json.message) || 'The console could not add it.';
    throw new CliError('failed', message, EXIT.FAILED);
  }
  const made = res.json || {};
  const app = made.app || {};
  if (ctx.json) {
    printJson(ctx, made);
    return made;
  }
  line(ctx, `${app.name} (${app.kind_label || app.kind}) is added. Its app key: copy it now, it is not kept and will not be shown again.`);
  line(ctx, '');
  line(ctx, '  ' + made.key);
  line(ctx, '');
  line(ctx, 'It is a secret: keep it out of public code and repositories. Put it in its environment as CR_MONITOR_KEY.');
  if (app.monitoring && app.monitoring.region === 'eu') line(ctx, `Its data is kept in the EU, so it reports to ${app.monitoring.endpoint}: set CR_MONITOR_ENDPOINT to that too.`);
  return made;
}

/** Make the key of a website or an app (or a new one in its place, with --replace). The key is shown once. */
export async function createKey(ctx, wanted, { replace = false } = {}) {
  const { site, monitoring } = await findSite(ctx, wanted);
  needMonitoring(monitoring);
  const res = await call(ctx, 'POST', `/api/v1/cli/sites/${encodeURIComponent(site.id)}/app-key`, { body: { replace }, allow: [409], what: `Monitoring for ${site.label}` });
  if (res.status === 409) {
    const had = res.json && res.json.masked ? res.json.masked : 'an app key';
    throw new CliError('failed', `${site.label} already has an app key (${had}). A new one stops that one at once, for ${site.app ? 'whatever reports with it' : 'every app, server and script that uses it'}. To make one anyway: cyberrakshak keys create ${asArg(site.label)} --replace`, EXIT.FAILED);
  }
  const made = res.json || {};
  if (ctx.json) {
    printJson(ctx, { site: { id: site.id, host: site.host ?? null, name: site.name ?? null, kind: site.app ? site.kind : 'website' }, key: made.key, masked: made.masked, replaced: !!made.replaced, made_at: made.made_at });
    return made;
  }
  line(ctx, `${made.replaced ? 'A new app key for' : 'The app key for'} ${site.label}${made.replaced ? ' (the old one no longer works)' : ''}. Copy it now: it is not kept and will not be shown again.`);
  line(ctx, '');
  line(ctx, '  ' + made.key);
  line(ctx, '');
  line(ctx, 'It is a secret: keep it out of public code and repositories. Put it in your app\'s environment as CR_MONITOR_KEY.');
  return made;
}

/** A setting from the environment, else from .env in the folder: { value, where }, or null. */
function findSetting(ctx, names, dir) {
  for (const name of names) if (ctx.env[name]) return { value: String(ctx.env[name]).trim(), where: name };
  const file = join(dir, '.env');
  if (existsSync(file)) {
    for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = raw.match(/^\s*(?:export\s+)?([A-Z_]+)\s*=\s*(.*)$/);
      if (m && names.includes(m[1]) && m[2].trim() !== '') return { value: m[2].trim().replace(/^["']|["']$/g, ''), where: '.env' };
    }
  }
  return null;
}

/** The app key to use: --key, else CR_MONITOR_KEY, else .env in the folder. Null when there is none. */
export function findKey(ctx, flag, dir = ctx.cwd || process.cwd()) {
  const from = (value, where) => {
    const v = String(value || '').trim().replace(/^["']|["']$/g, '');
    if (!KEY_RE.test(v)) throw usage(`The app key in ${where} is not one (it is crk_ and 32 letters and digits).`);
    return { key: v, where };
  };
  if (flag) return from(flag, '--key');
  const found = findSetting(ctx, KEY_NAMES, dir);
  return found ? from(found.value, found.where) : null;
}

export async function errors(ctx, wanted, { resolved = false, platform = null, page = 1 } = {}) {
  const { site, monitoring } = await findSite(ctx, wanted);
  needMonitoring(monitoring);
  const res = await call(ctx, 'GET', `/api/v1/cli/sites/${encodeURIComponent(site.id)}/errors`, {
    query: { status: resolved ? 'resolved' : 'open', platform, page: page > 1 ? String(page) : null },
    what: `Monitoring for ${site.label}`,
  });
  const data = res.json || {};
  if (ctx.json) {
    printJson(ctx, data);
    return;
  }
  const stats = data.stats || {};
  const list = data.problems || [];
  line(ctx, `${site.label}: ${plural(stats.open ?? 0, 'open problem')} · ${stats.resolved ?? 0} resolved · ${plural(stats.day ?? 0, 'occurrence')} in the last 24 hours${stats.new ? ` · ${stats.new} new` : ''}.`);
  if (data.site && !data.site.monitoring) {
    line(ctx, site.app
      ? `${site.label} has no key: new reports are refused until one is made: cyberrakshak keys create ${asArg(site.label)}`
      : 'Error monitoring is off for this site: new reports are refused until it is on again.');
  }
  if (list.length === 0) {
    line(ctx, resolved ? 'No resolved problems.' : 'No open problems.');
    return;
  }
  line(ctx, '');
  table(ctx, ['LEVEL', 'FROM', 'TIMES', '24 H', 'LAST SEEN', 'PROBLEM'], list.map((p) => [
    p.level,
    p.platform,
    p.occurrences,
    p.day_count,
    ago(p.last_seen_at),
    (p.reopened ? '(back) ' : '') + p.title,
  ]), 90);
  const pg = data.pagination || {};
  if (pg.pages > 1) note(ctx, `Page ${pg.page} of ${pg.pages}: --page ${Math.min(pg.pages, (pg.page || 1) + 1)} for more.`);
}

/** What `test` and `run` send, in the libraries' contract. */
export function envelope(problem, { environment = null, release = null } = {}) {
  return {
    sdk: { name: 'cyberrakshak-cli', version: VERSION },
    platform: 'script',
    runtime: `node ${process.versions.node}`,
    ...(release ? { release } : {}),
    ...(environment ? { environment } : {}),
    errors: [problem],
  };
}

/** POST to /api/v1/app-reports with the key. Resolves to the status; rejects with Offline. At most 5 s, as the libraries. */
export async function sendReport(endpoint, key, body) {
  const res = await request(endpoint, { method: 'POST', headers: { Authorization: 'Bearer ' + key }, body, timeoutMs: 5000 });
  return res;
}

/** The console's own address for reports: where they go unless a website's or an app's data is kept in the EU. */
export const defaultEndpoint = (ctx) => ctx.console + '/api/v1/app-reports';

/**
 * Where reports go: CR_MONITOR_ENDPOINT (from the environment, else .env, as an app reads it); else, when it is known,
 * the address the console gives the website or app (an EU one's is the EU server's); else the console's own.
 */
export function reportEndpoint(ctx, site = null, dir = ctx.cwd || process.cwd()) {
  const set = findSetting(ctx, ENDPOINT_NAMES, dir);
  if (set) {
    if (!/^https?:\/\/[^\s/]+/.test(set.value)) throw usage(`The address in ${set.where} is not one (it starts with https://).`);
    return set.value;
  }
  return (site && site.monitoring && site.monitoring.endpoint) || defaultEndpoint(ctx);
}

/** Why a report was refused, in words; `res` for what the console said (an address in another region). */
export function reportRefusal(status, label = null, res = null) {
  const said = res && res.json ? res.json : null;
  switch (status) {
    case 401:
      return `The console does not know this app key: it was replaced or turned off. Make a new one: cyberrakshak keys create ${label ? asArg(label) : '<site or app>'}`;
    case 403:
      if (said && typeof said.endpoint === 'string') {
        return `${said.message || 'Its data is kept in another region.'} Set CR_MONITOR_ENDPOINT=${said.endpoint} where it runs (cyberrakshak init writes it to .env).`;
      }
      return 'The console refused the report: the website is not verified yet, or its error monitoring is off. Both are on its Security scan tab in the console.';
    case 413:
      return 'The report was too large.';
    case 422:
      return 'The console could not read the report.';
    case 429:
      return 'The console asked to slow down: too many reports for this key just now. Try again in a minute.';
    default:
      return `The console answered HTTP ${status}.`;
  }
}

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Send a test problem with the key, then read it back through the console to show it arrived. The problem is a warning
 * named TEST_MESSAGE on the website's or app's Errors page (one problem however many tests are run).
 */
export async function testKey(ctx, wanted, { key: keyFlag, waitMs = 15000 } = {}) {
  const found = findKey(ctx, keyFlag);
  if (!found) throw usage('No app key found. Give it with --key, set CR_MONITOR_KEY, or run cyberrakshak init to write it to .env.');
  const { key, where } = found;
  const data = await listSites(ctx);
  needMonitoring(data.monitoring);
  let site;
  if (wanted) {
    site = (await findSite(ctx, wanted)).site;
  } else {
    const all = [...data.sites.map((s) => target(s, false)), ...data.apps.map((a) => target(a, true))];
    const matches = all.filter((s) => s.monitoring && s.monitoring.app_key && s.monitoring.app_key.on && s.monitoring.app_key.hint === key.slice(-4));
    if (matches.length !== 1) {
      throw usage(matches.length === 0
        ? `None of your websites or apps has the app key ${masked(key)} (from ${where}). Say which: cyberrakshak test <site or app>`
        : `More than one of your websites and apps has a key ending in ${key.slice(-4)}. Say which: cyberrakshak test <site or app>`);
    }
    site = matches[0];
  }
  const endpoint = reportEndpoint(ctx, site);
  const before = await testProblem(ctx, site);
  const check = randomBytes(4).toString('hex');
  const sentAt = new Date().toISOString();
  let res;
  try {
    res = await sendReport(endpoint, key, envelope({
      kind: 'log',
      level: 'warning',
      message: TEST_MESSAGE,
      route: 'cyberrakshak test',
      count: 1,
      at: sentAt,
      context: { check },
    }, { environment: 'test' }));
  } catch (e) {
    if (e instanceof Offline) throw offline(ctx, e);
    throw e;
  }
  if (res.status !== 204) throw new CliError('failed', reportRefusal(res.status, site.label, res), res.status === 401 || res.status === 403 ? EXIT.NO_ACCESS : EXIT.FAILED);

  // The console records a report as it takes it; a moment is allowed for a busy one, then it is said plainly.
  const deadline = Date.now() + waitMs;
  let after = null;
  for (;;) {
    after = await testProblem(ctx, site);
    if (after && (!before || after.occurrences > before.occurrences || after.last_seen_at !== before.last_seen_at)) break;
    if (Date.now() > deadline) {
      throw new CliError('failed', `The test was sent with ${masked(key)} and the console took it, but it is not on ${site.label}'s Errors page after ${Math.round(waitMs / 1000)} seconds. Look again in a minute: cyberrakshak errors ${asArg(site.label)}`, EXIT.FAILED);
    }
    await pause(1000);
  }
  // Sent to the website's or app's own address because nothing set one: whatever reports must be told it too.
  const unset = endpoint !== defaultEndpoint(ctx) && !findSetting(ctx, ENDPOINT_NAMES, ctx.cwd || process.cwd());
  if (ctx.json) {
    printJson(ctx, { arrived: true, site: { id: site.id, host: site.host ?? null, name: site.name ?? null, kind: site.app ? site.kind : 'website' }, key: masked(key), key_from: where, endpoint, problem: after });
    return;
  }
  line(ctx, `Sent a test with the app key ${masked(key)} (from ${where}) and found it on ${site.label}'s Errors page: "${TEST_MESSAGE}", a warning, seen ${plural(after.occurrences, 'time')}.`);
  line(ctx, 'Your key works. Mark the test resolved on the Errors page when you like; another test brings it back.');
  if (unset) note(ctx, `Its data is kept in the EU, so it was sent to ${endpoint}. Set CR_MONITOR_ENDPOINT to that where it runs, or its reports are refused (cyberrakshak init writes it to .env).`);
}

/** The test problem on the Errors page, open or resolved; null when there is none yet. */
async function testProblem(ctx, site) {
  for (const status of ['open', 'resolved']) {
    const res = await call(ctx, 'GET', `/api/v1/cli/sites/${encodeURIComponent(site.id)}/errors`, { query: { status, platform: 'script' }, what: `Monitoring for ${site.label}` });
    const hit = ((res.json && res.json.problems) || []).find((p) => p.title === TEST_MESSAGE);
    if (hit) return hit;
  }
  return null;
}
