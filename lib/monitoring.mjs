// Error monitoring: your websites, their app keys, their errors, and a test that a key works end to end.
// What each shows is what the console's Websites pages show the same account; while error monitoring is in its first
// phase, the console says which accounts have it (`can.monitoring` in `whoami`).
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

/** The test problem's message: always the same, so repeated tests count as one problem rather than many. */
export const TEST_MESSAGE = 'Test from the Cyber Rakshak command line';

export const masked = (key) => 'crk_••••' + String(key).slice(-4);

/** The account's sites, as `sites` lists them. */
export async function listSites(ctx) {
  const res = await call(ctx, 'GET', '/api/v1/cli/sites', { what: 'Websites' });
  return res.json || { monitoring: false, sites: [] };
}

/** A site by its address (example.com, https://www.example.com/…) or its id. */
export async function findSite(ctx, wanted) {
  if (!wanted) throw usage('Say which site: its address (example.com) or its id. `cyberrakshak sites` lists them.');
  const data = await listSites(ctx);
  const sites = data.sites || [];
  const host = String(wanted).trim().toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/[/?#].*$/, '').replace(/:\d+$/, '');
  const found = sites.find((s) => s.id === wanted)
    || sites.find((s) => String(s.host).toLowerCase() === host)
    || sites.find((s) => String(s.host).toLowerCase().replace(/^www\./, '') === host.replace(/^www\./, ''));
  if (!found) {
    const names = sites.map((s) => s.host).join(', ');
    throw new CliError('not_found', `No site "${wanted}" on your account.${names ? ' Your sites: ' + names + '.' : ' Add it in the console first: Websites → Add a website.'}`, EXIT.NO_ACCESS);
  }
  return { site: found, monitoring: !!data.monitoring };
}

function needMonitoring(monitoring) {
  if (!monitoring) throw new CliError('no_access', 'Error monitoring is not available on your account yet.', EXIT.NO_ACCESS);
}

export async function sites(ctx) {
  const data = await listSites(ctx);
  if (ctx.json) {
    printJson(ctx, data);
    return;
  }
  const list = data.sites || [];
  if (list.length === 0) {
    line(ctx, 'No websites on your account yet. Add one in the console: Websites → Add a website.');
    return;
  }
  if (data.monitoring) {
    table(ctx, ['SITE', 'VERIFIED', 'SCORE', 'MONITORING', 'APP KEY', 'OPEN ERRORS'], list.map((s) => [
      s.host,
      s.verified ? 'yes' : 'no',
      s.score ?? '-',
      s.monitoring ? (s.monitoring.on ? 'on' : 'off') : '-',
      s.monitoring && s.monitoring.app_key && s.monitoring.app_key.on ? s.monitoring.app_key.masked : 'none',
      s.monitoring ? s.monitoring.open : '-',
    ]));
  } else {
    table(ctx, ['SITE', 'VERIFIED', 'SCORE', 'LAST SCAN'], list.map((s) => [s.host, s.verified ? 'yes' : 'no', s.score ?? '-', ago(s.last_scanned_at)]));
  }
}

/** Make the site's app key (or a new one in its place, with --replace). The key is shown once. */
export async function createKey(ctx, wanted, { replace = false } = {}) {
  const { site, monitoring } = await findSite(ctx, wanted);
  needMonitoring(monitoring);
  const res = await call(ctx, 'POST', `/api/v1/cli/sites/${encodeURIComponent(site.id)}/app-key`, { body: { replace }, allow: [409], what: `Monitoring for ${site.host}` });
  if (res.status === 409) {
    const had = res.json && res.json.masked ? res.json.masked : 'an app key';
    throw new CliError('failed', `${site.host} already has an app key (${had}). A new one stops that one at once, for every app, server and script that uses it. To make one anyway: cyberrakshak keys create ${site.host} --replace`, EXIT.FAILED);
  }
  const made = res.json || {};
  if (ctx.json) {
    printJson(ctx, { site: { id: site.id, host: site.host }, key: made.key, masked: made.masked, replaced: !!made.replaced, made_at: made.made_at });
    return made;
  }
  line(ctx, `${made.replaced ? 'A new app key for' : 'The app key for'} ${site.host}${made.replaced ? ' (the old one no longer works)' : ''}. Copy it now: it is not kept and will not be shown again.`);
  line(ctx, '');
  line(ctx, '  ' + made.key);
  line(ctx, '');
  line(ctx, 'It is a secret: keep it out of public code and repositories. Put it in your app\'s environment as CR_MONITOR_KEY.');
  return made;
}

/** The app key to use: --key, else CR_MONITOR_KEY, else .env in the folder. Null when there is none. */
export function findKey(ctx, flag, dir = ctx.cwd || process.cwd()) {
  const from = (value, where) => {
    const v = String(value || '').trim().replace(/^["']|["']$/g, '');
    if (!KEY_RE.test(v)) throw usage(`The app key in ${where} is not one (it is crk_ and 32 letters and digits).`);
    return { key: v, where };
  };
  if (flag) return from(flag, '--key');
  for (const name of KEY_NAMES) if (ctx.env[name]) return from(ctx.env[name], name);
  const file = join(dir, '.env');
  if (existsSync(file)) {
    for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = raw.match(/^\s*(?:export\s+)?([A-Z_]+)\s*=\s*(.*)$/);
      if (m && KEY_NAMES.includes(m[1]) && m[2].trim() !== '') return from(m[2], '.env');
    }
  }
  return null;
}

export async function errors(ctx, wanted, { resolved = false, platform = null, page = 1 } = {}) {
  const { site, monitoring } = await findSite(ctx, wanted);
  needMonitoring(monitoring);
  const res = await call(ctx, 'GET', `/api/v1/cli/sites/${encodeURIComponent(site.id)}/errors`, {
    query: { status: resolved ? 'resolved' : 'open', platform, page: page > 1 ? String(page) : null },
    what: `Monitoring for ${site.host}`,
  });
  const data = res.json || {};
  if (ctx.json) {
    printJson(ctx, data);
    return;
  }
  const stats = data.stats || {};
  const list = data.problems || [];
  line(ctx, `${site.host}: ${plural(stats.open ?? 0, 'open problem')} · ${stats.resolved ?? 0} resolved · ${plural(stats.day ?? 0, 'occurrence')} in the last 24 hours${stats.new ? ` · ${stats.new} new` : ''}.`);
  if (data.site && !data.site.monitoring) line(ctx, 'Error monitoring is off for this site: new reports are refused until it is on again.');
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

export function reportEndpoint(ctx) {
  return ctx.env.CR_MONITOR_ENDPOINT || ctx.console + '/api/v1/app-reports';
}

/** Why a report was refused, in words. */
export function reportRefusal(status, site) {
  switch (status) {
    case 401:
      return `The console does not know this app key: it was replaced or turned off. Make a new one: cyberrakshak keys create ${site || '<site>'}`;
    case 403:
      return 'The console refused the report: the site is not verified yet, or its error monitoring is off. Both are on its Security scan tab in the console.';
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
 * Send a test problem with the site's key, then read it back through the console to show it arrived. The problem is a
 * warning named TEST_MESSAGE on the site's Errors page (one problem however many tests are run).
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
    const matches = (data.sites || []).filter((s) => s.monitoring && s.monitoring.app_key && s.monitoring.app_key.on && s.monitoring.app_key.hint === key.slice(-4));
    if (matches.length !== 1) {
      throw usage(matches.length === 0
        ? `None of your sites has the app key ${masked(key)} (from ${where}). Say which site: cyberrakshak test <site>`
        : `More than one of your sites has a key ending in ${key.slice(-4)}. Say which: cyberrakshak test <site>`);
    }
    site = matches[0];
  }
  const before = await testProblem(ctx, site);
  const check = randomBytes(4).toString('hex');
  const sentAt = new Date().toISOString();
  let res;
  try {
    res = await sendReport(reportEndpoint(ctx), key, envelope({
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
  if (res.status !== 204) throw new CliError('failed', reportRefusal(res.status, site.host), res.status === 401 || res.status === 403 ? EXIT.NO_ACCESS : EXIT.FAILED);

  // The console records a report as it takes it; a moment is allowed for a busy one, then it is said plainly.
  const deadline = Date.now() + waitMs;
  let after = null;
  for (;;) {
    after = await testProblem(ctx, site);
    if (after && (!before || after.occurrences > before.occurrences || after.last_seen_at !== before.last_seen_at)) break;
    if (Date.now() > deadline) {
      throw new CliError('failed', `The test was sent with ${masked(key)} and the console took it, but it is not on ${site.host}'s Errors page after ${Math.round(waitMs / 1000)} seconds. Look again in a minute: cyberrakshak errors ${site.host}`, EXIT.FAILED);
    }
    await pause(1000);
  }
  if (ctx.json) {
    printJson(ctx, { arrived: true, site: { id: site.id, host: site.host }, key: masked(key), key_from: where, problem: after });
    return;
  }
  line(ctx, `Sent a test with the app key ${masked(key)} (from ${where}) and found it on ${site.host}'s Errors page: "${TEST_MESSAGE}", a warning, seen ${plural(after.occurrences, 'time')}.`);
  line(ctx, 'Your key works. Mark the test resolved on the Errors page when you like; another test brings it back.');
}

/** The test problem on the site's Errors page, open or resolved; null when there is none yet. */
async function testProblem(ctx, site) {
  for (const status of ['open', 'resolved']) {
    const res = await call(ctx, 'GET', `/api/v1/cli/sites/${encodeURIComponent(site.id)}/errors`, { query: { status, platform: 'script' }, what: `Monitoring for ${site.host}` });
    const hit = ((res.json && res.json.problems) || []).find((p) => p.title === TEST_MESSAGE);
    if (hit) return hit;
  }
  return null;
}

