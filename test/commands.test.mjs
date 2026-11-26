// Every command against the fake console: what it prints, its --json, its exit code, and each way it can fail
// (not signed in, no access, not found, the console slow or not there).
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { KEY, startFakeConsole } from './fake-console.mjs';
import { cli, scratch } from './helpers.mjs';

let fake;
let dir;
let work;
before(async () => {
  fake = await startFakeConsole();
});
after(async () => {
  await fake.close();
});
beforeEach(async () => {
  fake.reset();
  dir = scratch();
  work = scratch('cr-cli-work-');
  const r = await cli(['login', '--no-browser'], { fake, configDir: dir });
  assert.equal(r.code, 0, r.err);
});

const run = (args, extra = {}) => cli(args, { fake, configDir: dir, cwd: work, ...extra });

test('sites: a table with monitoring, and --json as the console gave it', async () => {
  let r = await run(['sites']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^SITE\s+VERIFIED\s+SCORE\s+MONITORING\s+APP KEY\s+OPEN ERRORS/m);
  assert.match(r.out, /example\.com\s+yes\s+92\s+on\s+crk_••••C3d4\s+2/);
  assert.match(r.out, /shop\.example\.org\s+no\s+-\s+off\s+none\s+0/);
  r = await run(['sites', '--json']);
  assert.equal(r.json.monitoring, true);
  assert.equal(r.json.sites.length, 2);
  // Without monitoring on the account: the sites, as the Websites list shows them.
  fake.state.monitoring = false;
  r = await run(['sites']);
  assert.match(r.out, /^SITE\s+VERIFIED\s+SCORE\s+LAST SCAN/m);
  assert.doesNotMatch(r.out, /APP KEY/);
});

test('keys create: shown once; one already there needs --replace; not available and not found are said plainly', async () => {
  let r = await run(['keys', 'create', 'shop.example.org']);
  assert.equal(r.code, 0, r.err);
  const made = fake.state.madeKeys[0];
  assert.match(r.out, new RegExp(made));
  assert.match(r.out, /it is not kept and will not be shown again/);
  r = await run(['keys', 'create', 'https://www.example.com/path']);
  assert.equal(r.code, 1);
  assert.match(r.err, /example\.com already has an app key \(crk_••••C3d4\).*--replace/s);
  r = await run(['keys', 'create', 'example.com', '--replace', '--json']);
  assert.equal(r.code, 0);
  assert.equal(r.json.replaced, true);
  assert.match(r.json.key, /^crk_[A-Za-z0-9]{32}$/);
  r = await run(['keys', 'create', 'nowhere.example']);
  assert.equal(r.code, 4);
  assert.match(r.err, /No website or app "nowhere\.example" on your account\. Yours: example\.com, shop\.example\.org\./);
  fake.state.monitoring = false;
  r = await run(['keys', 'create', 'example.com']);
  assert.equal(r.code, 4);
  assert.match(r.err, /Error monitoring is not available on your account yet/);
  r = await run(['keys', 'create']);
  assert.equal(r.code, 2);
});

test('keys create with a read-only sign-in says it needs a full one', async () => {
  const r0 = await cli(['login', '--no-browser', '--read-only'], { fake, configDir: dir });
  assert.equal(r0.code, 0, r0.err);
  const r = await run(['keys', 'create', 'shop.example.org']);
  assert.equal(r.code, 4);
  assert.match(r.err, /This sign-in is read-only: making an app key needs a full sign-in\. Run cyberrakshak login \(without --read-only\)\./);
  assert.equal(fake.state.madeKeys.length, 0);
});

test('errors: the site\'s problems; --json; filters reach the console', async () => {
  let r = await run(['errors', 'example.com']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /example\.com: 1 open problem/);
  assert.match(r.out, /error\s+Server\s+12\s+3\s+just now\s+TypeError: cannot read properties of undefined/);
  r = await run(['errors', 'example.com', '--platform', 'server', '--resolved', '--json']);
  assert.equal(r.code, 0);
  const call = fake.state.calls.filter((c) => c.path.endsWith('/errors')).pop();
  assert.deepEqual(call.query, { status: 'resolved', platform: 'server' });
  assert.equal(r.json.status, 'resolved');
  r = await run(['errors', 'example.com', '--platform', 'phone']);
  assert.equal(r.code, 2);
  r = await run(['errors']);
  assert.equal(r.code, 2);
});

test('test: sends a test with the key from .env, finds it on the Errors page, and says so', async () => {
  writeFileSync(join(work, '.env'), `APP_NAME=x\nCR_MONITOR_KEY=${KEY}\n`);
  let r = await run(['test']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /Sent a test with the app key crk_••••C3d4 \(from \.env\) and found it on example\.com's Errors page/);
  const sent = fake.state.reports[0];
  assert.equal(sent.headers.authorization, 'Bearer ' + KEY);
  assert.equal(sent.body.sdk.name, 'cyberrakshak-cli');
  assert.equal(sent.body.platform, 'script');
  assert.equal(sent.body.errors[0].message, 'Test from the Cyber Rakshak command line');
  assert.equal(sent.body.errors[0].level, 'warning');
  assert.ok(!JSON.stringify(sent.body).includes(KEY), 'the key is never in the body');
  // Again: the same problem, seen twice.
  r = await run(['test', '--json']);
  assert.equal(r.code, 0);
  assert.equal(r.json.arrived, true);
  assert.equal(r.json.problem.occurrences, 2);
  assert.equal(r.json.key, 'crk_••••C3d4');
});

test('test: a key no site has, a refused key, and a report that never shows up', async () => {
  let r = await run(['test', '--key', 'crk_' + 'Z'.repeat(32)]);
  assert.equal(r.code, 2);
  assert.match(r.err, /None of your websites or apps has the app key crk_••••ZZZZ/);
  r = await run(['test', '--key', 'not-a-key']);
  assert.equal(r.code, 2);
  r = await run(['test']);
  assert.equal(r.code, 2);
  assert.match(r.err, /No app key found/);
  fake.state.reportStatus = 401;
  r = await run(['test', 'example.com', '--key', KEY]);
  assert.equal(r.code, 4);
  assert.match(r.err, /does not know this app key/);
  fake.state.reportStatus = 403;
  r = await run(['test', 'example.com', '--key', KEY]);
  assert.equal(r.code, 4);
  assert.match(r.err, /not verified yet, or its error monitoring is off/);
  fake.state.reportStatus = 204;
  fake.state.dropReports = true;
  r = await run(['test', 'example.com', '--key', KEY], { testWaitMs: 300 });
  assert.equal(r.code, 1);
  assert.match(r.err, /the console took it, but it is not on example\.com's Errors page after 0 seconds/);
});

test('laptops: the console\'s list, in its own words; no company and two-factor rules come through', async () => {
  let r = await run(['laptops']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /Front desk \(LAPTOP-01\)\s+Ravi\s+online\s+Critical\s+1\s+2 · A threat was found\s+just now\s+0\.3\.37 \(update available\)/);
  assert.match(r.out, /LAPTOP-02\s+-\s+offline\s+Secure\s+0\s+-/);
  assert.match(r.err, /2 laptops: 1 Critical, 1 Secure\./);
  await run(['laptops', '--status', 'online', '--search', 'front']);
  assert.deepEqual(fake.state.calls.filter((c) => c.path === '/api/v1/cli/laptops').pop().query, { status: 'online', q: 'front' });
  r = await run(['laptops', '--json']);
  assert.equal(r.json.devices.length, 2);
  fake.state.laptops = { status: 404, json: { message: 'Not Found' } };
  r = await run(['laptops']);
  assert.equal(r.code, 4);
  assert.match(r.err, /does not manage a company in the console/);
  fake.state.laptops = { status: 403, json: { message: 'Laabam One asks everyone who manages its console to use two-factor sign-in. Turn it on in Settings → Sign-in & two-factor, then open the console again.', two_factor_required: true } };
  r = await run(['laptops', '--json']);
  assert.equal(r.code, 4);
  assert.equal(r.json.error.code, 'no_access');
  assert.match(r.json.error.message, /two-factor sign-in/);
});

test('alerts: open security events; --all asks for reviewed ones too', async () => {
  let r = await run(['alerts']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /High\s+just now\s+2\s+Ravi · Front desk\s+Threat found \(EICAR-Test-File\)/);
  assert.match(r.err, /1 open event\./);
  assert.deepEqual(fake.state.calls.filter((c) => c.path === '/api/v1/cli/alerts').pop().query, { view: 'security', review: 'unreviewed', per: '100' });
  await run(['alerts', '--all']);
  assert.equal(fake.state.calls.filter((c) => c.path === '/api/v1/cli/alerts').pop().query.review, 'all');
  fake.state.alerts = { status: 200, json: { filters: {}, feed: { rows: [], pagination: { page: 1, pages: 1, rows: 0, per: 100 } } } };
  r = await run(['alerts']);
  assert.match(r.out, /No open security events/);
});

test('servers: not available on most accounts; listed where the console shows them', async () => {
  let r = await run(['servers']);
  assert.equal(r.code, 4);
  assert.equal(r.err.trim(), 'Servers are not available on your account.');
  r = await run(['servers', 'alerts', '--json']);
  assert.equal(r.code, 4);
  assert.equal(r.json.error.message, 'Servers are not available on your account.');
  fake.state.servers = { status: 200, json: { servers: [{ id: 's1', name: 'web-1', status: 'active', enrolled: true, last_seen_at: new Date().toISOString(), alerts: 5, serious: 1, attackers: 2, blocked: 0 }], totals: { alerts: 5, serious: 1, attackers: 2, blocked: 0 } } };
  fake.state.serverAlerts = { status: 200, json: { period: '7d', total: 1, alerts: [{ id: 1, server: 'web-1', level: 'high', title: 'SQL injection attempt', source_ip: '198.51.100.7', country: 'DE', occurred_at: new Date().toISOString() }] } };
  r = await run(['servers']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /web-1\s+active\s+just now\s+5\s+1\s+2\s+0/);
  r = await run(['servers', 'alerts', '--period', '7d', '--serious']);
  assert.equal(r.code, 0);
  assert.match(r.out, /high\s+just now\s+web-1\s+198\.51\.100\.7 \(DE\)\s+SQL injection attempt/);
  assert.deepEqual(fake.state.calls.filter((c) => c.path === '/api/v1/cli/servers/alerts').pop().query, { period: '7d', level: 'high' });
  r = await run(['servers', 'alerts', '--period', '1y']);
  assert.equal(r.code, 2);
});

test('a console that is slow, not there, or failing: each ends with exit code 5 and says what to do', async () => {
  fake.state.delayMs = 400;
  let r = await run(['sites'], { timeoutMs: 100 });
  assert.equal(r.code, 5);
  assert.match(r.err, /Could not reach the Cyber Rakshak console at http:\/\/127\.0\.0\.1:\d+: no answer in 0 seconds\. Check your internet connection/);
  fake.state.delayMs = 0;
  r = await run(['whoami', '--json'], { env: { CYBERRAKSHAK_CONSOLE: 'http://127.0.0.1:9' }, configDir: dir });
  assert.equal(r.code, 3, 'no sign-in for that console');
  const offline = scratch();
  writeFileSync(join(offline, 'credentials.json'), JSON.stringify({ consoles: { 'http://127.0.0.1:9': { token: '1|x' } } }));
  r = await cli(['whoami', '--json'], { configDir: offline, env: { CYBERRAKSHAK_CONSOLE: 'http://127.0.0.1:9' } });
  assert.equal(r.code, 5);
  assert.equal(r.json.error.code, 'offline');
  assert.match(r.json.error.message, /connection was refused/);
  fake.state.refuse = { status: 500, json: { message: 'Server Error' } };
  r = await run(['sites']);
  assert.equal(r.code, 5);
  assert.match(r.err, /had a problem answering \(HTTP 500\)/);
  fake.state.refuse = { status: 429, json: { message: 'Too Many Attempts.' }, headers: { 'Retry-After': '42' } };
  r = await run(['sites']);
  assert.equal(r.code, 1);
  assert.match(r.err, /slow down\. Try again in 42 seconds/);
});

test('the console address: https, or http only for this computer', async () => {
  for (const bad of ['http://app.example.com', 'ftp://x', 'not a url', 'https://user:pw@example.com']) {
    const r = await cli(['whoami', '--console', bad], { configDir: dir });
    assert.equal(r.code, 2, bad);
  }
});

test('help for every command, and wrong commands and options', async () => {
  for (const cmd of ['login', 'logout', 'whoami', 'sites', 'keys', 'init', 'test', 'run', 'errors', 'laptops', 'alerts', 'servers']) {
    const r = await run([cmd, '--help']);
    assert.equal(r.code, 0, cmd);
    assert.match(r.out, new RegExp('Usage: cyberrakshak ' + cmd), cmd);
  }
  let r = await run(['--help']);
  assert.equal(r.code, 0);
  assert.match(r.out, /Signing in[\s\S]*Error monitoring[\s\S]*Security \(read-only\)/);
  r = await run([]);
  assert.equal(r.code, 2);
  r = await run(['--version']);
  assert.equal(r.out.trim(), 'cyberrakshak 1.1.0');
  r = await run(['frobnicate']);
  assert.equal(r.code, 2);
  assert.match(r.err, /Unknown command "frobnicate"/);
  r = await run(['sites', '--colour']);
  assert.equal(r.code, 2);
  assert.match(r.err, /Unknown option --colour/);
  r = await run(['sites', 'extra']);
  assert.equal(r.code, 2);
  r = await run(['errors', 'example.com', '--page', 'two']);
  assert.equal(r.code, 2);
  r = await run(['sites', '--json', '--console']);
  assert.equal(r.code, 2);
  assert.equal(r.json.error.code, 'usage');
});

test('no request the command line makes carries an Origin header (the console refuses any that does)', async () => {
  writeFileSync(join(work, '.env'), `CR_MONITOR_KEY=${KEY}\n`);
  for (const args of [['whoami'], ['sites'], ['keys', 'create', 'shop.example.org'], ['errors', 'example.com'], ['test'], ['laptops'], ['alerts'], ['servers'], ['logout']]) {
    await run(args);
  }
  await run(['run', '--', process.execPath, '-e', 'process.exit(2)'], { env: { CR_MONITOR_KEY: KEY } });
  const seen = [...fake.state.calls.map((c) => c.headers), ...fake.state.reports.map((r) => r.headers)];
  assert.ok(seen.length > 15);
  assert.deepEqual(seen.filter((h) => 'origin' in h), []);
  assert.ok(fake.state.reports.length >= 2, 'the test and the failed run were sent');
});

test('nothing the command line prints carries the sign-in token', async () => {
  const token = JSON.parse(await import('node:fs').then((fs) => fs.readFileSync(join(dir, 'credentials.json'), 'utf8'))).consoles[fake.url].token;
  mkdirSync(join(work, 'sub'), { recursive: true });
  let all = '';
  for (const args of [['whoami'], ['whoami', '--json'], ['sites', '--json'], ['laptops', '--json'], ['alerts'], ['errors', 'example.com', '--json'], ['servers']]) {
    const r = await run(args);
    all += r.out + r.err;
  }
  assert.ok(!all.includes(token));
  assert.ok(!all.includes(token.split('|')[1]));
});
