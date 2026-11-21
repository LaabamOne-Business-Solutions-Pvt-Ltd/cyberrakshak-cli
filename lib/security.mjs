// Security, read-only: the company's laptops and open security events (the console's Devices and Security events, for
// whoever manages the company), and servers (only for the accounts and teams that see Servers in the console). The
// console answers each from the same place its own pages do, with the same rules; nothing here changes anything.
import { call } from './api.mjs';
import { CliError, EXIT } from './errors.mjs';
import { ago, line, note, plural, printJson, table } from './output.mjs';

// The console's own words (resources/js/fleet.js).
const RISK = { critical: 'Critical', warning: 'Needs attention', secure: 'Secure', unknown: 'No report yet', stale: 'No report for 7+ days' };
const SEVERITY = { critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low', info: 'Info' };

const NO_COMPANY = 'Your account does not manage a company in the console, so there are no laptops to show. (Company laptops are on Devices in the console, for its owner and admins.)';

async function companyCall(ctx, path, query) {
  try {
    return (await call(ctx, 'GET', path, { query, what: 'The company console' })).json || {};
  } catch (e) {
    if (e instanceof CliError && e.code === 'not_found') throw new CliError('no_access', NO_COMPANY, EXIT.NO_ACCESS);
    throw e;
  }
}

export async function laptops(ctx, { status = null, search = null } = {}) {
  const data = await companyCall(ctx, '/api/v1/cli/laptops', { status, q: search });
  const list = data.devices || [];
  if (ctx.json) {
    printJson(ctx, data);
    return;
  }
  if (list.length === 0) {
    line(ctx, status || search ? 'No laptops match.' : 'No laptops have joined the company yet.');
    return;
  }
  table(ctx, ['LAPTOP', 'PERSON', 'STATUS', 'RISK', 'OPEN THREATS', 'TO FIX', 'LAST SEEN', 'VERSION'], list.map((d) => [
    d.display_name ? `${d.display_name} (${d.hostname})` : d.hostname,
    d.person ? d.person.name : null,
    d.online ? 'online' : 'offline',
    RISK[d.risk] || d.risk,
    d.open_threats ?? '-',
    d.top_issue ? `${d.issue_count} · ${d.top_issue}` : d.issue_count || '-',
    ago(d.last_seen_at),
    d.app_version ? d.app_version + (d.update_available ? ' (update available)' : '') : '-',
  ]));
  const counts = list.reduce((c, d) => ((c[d.risk] = (c[d.risk] || 0) + 1), c), {});
  note(ctx, '');
  note(ctx, `${plural(list.length, 'laptop')}: ${Object.entries(counts).map(([k, n]) => `${n} ${RISK[k] || k}`).join(', ')}.`);
}

export async function alerts(ctx, { all = false } = {}) {
  // Open = not reviewed yet: the console's Security events as it opens (security events, unreviewed).
  const data = await companyCall(ctx, '/api/v1/cli/alerts', { view: 'security', review: all ? 'all' : 'unreviewed', per: '100' });
  const feed = data.feed || {};
  const rows = feed.rows || [];
  if (ctx.json) {
    printJson(ctx, data);
    return;
  }
  if (rows.length === 0) {
    line(ctx, all ? 'No security events.' : 'No open security events: everything has been reviewed.');
    return;
  }
  table(ctx, ['SEVERITY', 'LAST', 'TIMES', 'LAPTOP', 'EVENT'], rows.map((r) => [
    r.severity ? SEVERITY[r.severity] || r.severity : '-',
    ago(r.last_at),
    r.count ?? 1,
    r.device ? (r.device.person ? `${r.device.person} · ` : '') + (r.device.display_name || r.device.hostname) : null,
    r.title + (r.name && r.name !== r.title ? ` (${r.name})` : ''),
  ]), 70);
  const pg = feed.pagination || {};
  note(ctx, '');
  note(ctx, `${plural(pg.rows ?? rows.length, all ? 'event' : 'open event')}${pg.pages > 1 ? `, the first ${rows.length} shown` : ''}. Review them in the console: Security events.`);
}

const NO_SERVERS = 'Servers are not available on your account.';

export async function servers(ctx) {
  let data;
  try {
    data = (await call(ctx, 'GET', '/api/v1/cli/servers', { what: 'Servers' })).json || {};
  } catch (e) {
    if (e instanceof CliError && (e.code === 'not_found' || e.code === 'no_access')) throw new CliError('no_access', NO_SERVERS, EXIT.NO_ACCESS);
    throw e;
  }
  if (ctx.json) {
    printJson(ctx, data);
    return;
  }
  const list = data.servers || [];
  if (list.length === 0) {
    line(ctx, 'No servers you can see yet.');
    return;
  }
  table(ctx, ['SERVER', 'STATUS', 'LAST SEEN', 'ALERTS 24 H', 'SERIOUS', 'ADDRESSES', 'BLOCKED'], list.map((s) => [
    s.name,
    s.enrolled ? s.status : 'agent not installed',
    ago(s.last_seen_at),
    s.alerts ?? 0,
    s.serious ?? 0,
    s.attackers ?? 0,
    s.blocked ?? 0,
  ]));
  const t = data.totals || {};
  note(ctx, '');
  note(ctx, `Last 24 hours: ${plural(t.alerts ?? 0, 'alert')}, ${t.serious ?? 0} serious, ${plural(t.attackers ?? 0, 'attacking address', 'attacking addresses')}, ${t.blocked ?? 0} blocked now. The newest: cyberrakshak servers alerts`);
}

export async function serverAlerts(ctx, { period = '24h', serious = false } = {}) {
  let data;
  try {
    data = (await call(ctx, 'GET', '/api/v1/cli/servers/alerts', { query: { period, level: serious ? 'high' : null }, what: 'Servers' })).json || {};
  } catch (e) {
    if (e instanceof CliError && (e.code === 'not_found' || e.code === 'no_access')) throw new CliError('no_access', NO_SERVERS, EXIT.NO_ACCESS);
    throw e;
  }
  if (ctx.json) {
    printJson(ctx, data);
    return;
  }
  const list = data.alerts || [];
  if (list.length === 0) {
    line(ctx, `No ${serious ? 'serious ' : ''}alerts in the last ${period}.`);
    return;
  }
  table(ctx, ['LEVEL', 'WHEN', 'SERVER', 'FROM', 'ALERT'], list.map((a) => [
    a.level,
    ago(a.occurred_at),
    a.server,
    a.source_ip ? a.source_ip + (a.country ? ` (${a.country})` : '') : null,
    a.title,
  ]), 80);
  note(ctx, '');
  note(ctx, `${plural(data.total ?? list.length, 'alert')} in the last ${data.period || period}${(data.total ?? 0) > list.length ? `, the newest ${list.length} shown` : ''}.`);
}
