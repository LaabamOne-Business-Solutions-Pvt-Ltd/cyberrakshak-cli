// Apps & websites (console 2026-11-26): a workspace's own apps (a mobile app, an API, an MCP server, or a script or cron
// job) listed beside its websites, added with `apps add` or `init --app --kind`, named by their name wherever a website
// is named by its address; and an EU one's reports sent to the EU server, its address written beside the key.
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startFakeConsole } from './fake-console.mjs';
import { cli, scratch } from './helpers.mjs';

const NODE = process.execPath;
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

test('apps add: its key once, the console\'s refusals in its words, and sites and apps list it', async () => {
  let r = await run(['apps', 'add', 'Shop app', '--kind', 'mobile']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /Shop app \(Mobile app\) is added\./);
  assert.match(r.out, new RegExp(fake.state.madeKeys[0]));
  assert.match(r.out, /not kept and will not be shown again/);

  r = await run(['apps', 'add', 'SHOP APP', '--kind', 'api']);
  assert.equal(r.code, 1);
  assert.match(r.err, /Example Traders has SHOP APP already\. Give this one another name\./);
  r = await run(['apps', 'add', 'Till', '--kind', 'desktop']);
  assert.equal(r.code, 2);
  assert.match(r.err, /--kind mobile, api, mcp, script/);
  r = await run(['apps', 'add', '--kind', 'api']);
  assert.equal(r.code, 2);
  assert.match(r.err, /Say its name/);

  // Where its data is kept, once the console keeps data in the EU too: asked, never guessed.
  fake.state.euConfigured = true;
  r = await run(['apps', 'add', 'Orders API', '--kind', 'api']);
  assert.equal(r.code, 2);
  assert.match(r.err, /Say where its data is kept: --region india or --region eu\./);
  r = await run(['apps', 'add', 'Orders API', '--kind', 'api', '--region', 'eu', '--json']);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.json.app.kind, 'api');
  assert.equal(r.json.app.monitoring.region, 'eu');
  assert.match(r.json.key, /^crk_[A-Za-z0-9]{32}$/);

  r = await run(['sites']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^SITE\s+VERIFIED\s+SCORE/m);
  assert.match(r.out, /^APP\s+KIND\s+DATA IN\s+APP KEY\s+OPEN ERRORS/m);
  assert.match(r.out, /Shop app\s+Mobile app\s+India\s+crk_••••\S{4}\s+0/);
  assert.match(r.out, /Orders API\s+API\s+EU\s+crk_••••\S{4}\s+0/);
  r = await run(['apps', '--json']);
  assert.deepEqual(r.json.apps.map((a) => a.name), ['Shop app', 'Orders API']);
  // Without monitoring on the account, no apps.
  fake.state.monitoring = false;
  r = await run(['apps']);
  assert.equal(r.code, 4);
  assert.match(r.err, /Error monitoring is not available on your account yet\./);
});

test('keys create and errors take an app by its name, in quotes when it has spaces', async () => {
  assert.equal((await run(['apps', 'add', 'Shop app', '--kind', 'mobile'])).code, 0);
  let r = await run(['keys', 'create', 'shop app']);
  assert.equal(r.code, 1);
  assert.match(r.err, /Shop app already has an app key \(crk_••••\S{4}\)\. .*cyberrakshak keys create "Shop app" --replace/s);
  r = await run(['keys', 'create', 'Shop app', '--replace', '--json']);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.json.replaced, true);
  assert.deepEqual({ kind: r.json.site.kind, name: r.json.site.name, host: r.json.site.host }, { kind: 'mobile', name: 'Shop app', host: null });
  r = await run(['errors', 'Shop app']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^Shop app: 1 open problem/m);
  r = await run(['errors', 'Nobody']);
  assert.equal(r.code, 4);
  assert.match(r.err, /No website or app "Nobody" on your account\. Yours: example\.com, shop\.example\.org, Shop app\./);
});

test('init --app --kind adds the app, and an EU one\'s address goes beside its key and into how it starts', async () => {
  fake.state.euConfigured = true;
  writeFileSync(join(work, 'package.json'), JSON.stringify({ name: 'support-tools', type: 'module' }));
  let r = await run(['init', '--app', 'Support tools', '--kind', 'mcp', '--region', 'eu', '--no-install']);
  assert.equal(r.code, 0, r.err);
  assert.equal(fake.state.apps.length, 1);
  assert.equal(fake.state.apps[0].kind, 'mcp');
  const env = readFileSync(join(work, '.env'), 'utf8');
  assert.match(env, new RegExp(`^CR_MONITOR_KEY=${fake.state.madeKeys[0]}$`, 'm'));
  assert.match(env, new RegExp(`^CR_MONITOR_ENDPOINT=${fake.url.replace(/[.]/g, '\\.')}/eu/api/v1/app-reports$`, 'm'));
  assert.match(r.out, /Its data is kept in the EU, so it reports to .*\/eu\/api\/v1\/app-reports: that is in \.env as CR_MONITOR_ENDPOINT\./);
  assert.match(r.out, /monitor\.init\(\{ key: process\.env\.CR_MONITOR_KEY, endpoint: process\.env\.CR_MONITOR_ENDPOINT,/);
  assert.match(r.out, /Then check it end to end: cyberrakshak test "Support tools"/);

  // Again: the key in .env is that app's, so it is kept, and nothing new is added.
  r = await run(['init', '--app', 'Support tools', '--kind', 'mcp', '--no-install', '--json']);
  assert.equal(r.code, 0, r.err);
  assert.equal(fake.state.apps.length, 1);
  assert.equal(r.json.key.from, '.env');
  assert.equal(r.json.endpoint.variable, 'CR_MONITOR_ENDPOINT');

  // Without --kind, an app it does not know is not guessed at; --kind without --app, and both --site and --app, are asked again.
  r = await run(['init', '--app', 'Nobody', '--no-install']);
  assert.equal(r.code, 4);
  assert.match(r.err, /No website or app "Nobody"/);
  r = await run(['init', '--kind', 'api', '--no-install']);
  assert.equal(r.code, 2);
  r = await run(['init', '--site', 'example.com', '--app', 'Support tools', '--no-install']);
  assert.equal(r.code, 2);
  assert.match(r.err, /One at a time/);
});

test('test and run send an EU app\'s reports to its address, and say when it is not set', async () => {
  fake.state.euConfigured = true;
  const made = (await run(['apps', 'add', 'Orders API', '--kind', 'api', '--region', 'eu', '--json'])).json;
  writeFileSync(join(work, '.env'), `CR_MONITOR_KEY=${made.key}\n`);

  // The key is the app's: found by its last four, sent to its address, and the missing setting said.
  let r = await run(['test']);
  assert.equal(r.code, 0, r.err);
  assert.equal(fake.state.reports.at(-1).eu, true);
  assert.match(r.out, /found it on Orders API's Errors page/);
  assert.match(r.err, /Its data is kept in the EU, so it was sent to .*\/eu\/api\/v1\/app-reports\. Set CR_MONITOR_ENDPOINT/);

  writeFileSync(join(work, '.env'), `CR_MONITOR_KEY=${made.key}\nCR_MONITOR_ENDPOINT=${made.app.monitoring.endpoint}\n`);
  r = await run(['test', 'Orders API', '--json']);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.json.endpoint, made.app.monitoring.endpoint);
  assert.doesNotMatch(r.err, /Set CR_MONITOR_ENDPOINT/);

  // run needs no sign-in: the key and the address come from .env.
  r = await run(['run', '--', NODE, '-e', 'process.exit(3)']);
  assert.equal(r.code, 3);
  assert.equal(fake.state.reports.at(-1).eu, true);
  assert.equal(fake.state.reports.at(-1).headers.authorization, 'Bearer ' + made.key);

  // An address that is not one is said plainly.
  writeFileSync(join(work, '.env'), `CR_MONITOR_KEY=${made.key}\nCR_MONITOR_ENDPOINT=eu-reports\n`);
  r = await run(['test', 'Orders API']);
  assert.equal(r.code, 2);
  assert.match(r.err, /The address in \.env is not one/);
});
