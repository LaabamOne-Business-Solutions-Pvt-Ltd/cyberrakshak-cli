// `run` (a real command, its failure reported as the shell library reports it) and `init` (a real folder: what it
// is, the library from its registry or the console's checked file, the key in .env and never in a tracked file).
// No real package manager or registry is ever used: a stand-in npm/composer is put first on PATH.
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { KEY, SDK_FILES, startFakeConsole } from './fake-console.mjs';
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
});

const signIn = async () => assert.equal((await cli(['login', '--no-browser'], { fake, configDir: dir })).code, 0);
const run = (args, extra = {}) => cli(args, { fake, configDir: dir, cwd: work, ...extra });
const NODE = process.execPath;
const git = (...args) => spawnSync('git', args, { cwd: work, encoding: 'utf8' });

/** A stand-in package manager on PATH: writes what it was asked into called.txt and ends with `code`. */
function fakeTool(name, code = 0) {
  const bin = scratch('cr-cli-bin-');
  if (process.platform === 'win32') {
    writeFileSync(join(bin, name + '.cmd'), `@echo off\r\necho ${name} %*> "%~dp0called.txt"\r\nexit /b ${code}\r\n`);
  } else {
    writeFileSync(join(bin, name), `#!/bin/sh\necho "${name} $*" > "$(dirname "$0")/called.txt"\nexit ${code}\n`);
    chmodSync(join(bin, name), 0o755);
  }
  return { PATH: bin + delimiter + process.env.PATH, called: () => (existsSync(join(bin, 'called.txt')) ? readFileSync(join(bin, 'called.txt'), 'utf8').trim() : null) };
}

test('run: success passes through and sends nothing', async () => {
  const r = await run(['run', '--', NODE, '-e', "console.error('just a note'); process.exit(0)"], { env: { CR_MONITOR_KEY: KEY } });
  assert.equal(r.code, 0);
  assert.match(r.err, /just a note/);
  assert.equal(fake.state.reports.length, 0);
});

test('run: a failure keeps its exit code and is reported as cr-report.sh does: name, code, last 20 lines, scrubbed', async () => {
  const script = "for (let i = 1; i <= 30; i++) console.error('line ' + i); console.error('login failed for asha@example.com password=hunter2'); process.exit(3)";
  const r = await run(['run', '--route', 'nightly-import', '--', NODE, '-e', script], { env: { CR_MONITOR_KEY: KEY, CR_MONITOR_ENVIRONMENT: 'production', CR_MONITOR_RELEASE: '2026.11.21' } });
  assert.equal(r.code, 3);
  assert.match(r.err, /line 30/);
  assert.equal(fake.state.reports.length, 1);
  const { headers, body } = fake.state.reports[0];
  assert.equal(headers.authorization, 'Bearer ' + KEY);
  const p = body.errors[0];
  assert.equal(p.kind, 'script');
  assert.equal(p.level, 'error');
  assert.equal(p.message, 'node exited with code 3');
  assert.equal(p.route, 'nightly-import');
  assert.deepEqual(p.context, { exit_code: 3 });
  const lines = p.stack.split('\n');
  assert.equal(lines.length, 20);
  assert.equal(lines[0], 'line 12');
  assert.equal(lines[19], 'login failed for [email] password=[removed]');
  // The arguments are never sent: they may hold secrets.
  assert.ok(!JSON.stringify(body).includes('process.exit'));
  assert.equal(body.environment, 'production');
  assert.equal(body.release, '2026.11.21');
  assert.equal(body.platform, 'script');
});

test('run: with no key the command still runs and keeps its code; a command that is not there is 127', async () => {
  let r = await run(['run', '--', NODE, '-e', 'process.exit(4)']);
  assert.equal(r.code, 4);
  assert.match(r.err, /not reported: no app key/);
  assert.equal(fake.state.reports.length, 0);
  r = await run(['run', '--', 'cr-no-such-command-xyz'], { env: { CR_MONITOR_KEY: KEY } });
  assert.equal(r.code, 127);
  assert.match(r.err, /could not start cr-no-such-command-xyz/);
  assert.equal(fake.state.reports[0].body.errors[0].message, 'cr-no-such-command-xyz exited with code 127');
  // The console not there: said in one line, and the command's code is still the answer.
  r = await run(['run', '--', NODE, '-e', 'process.exit(6)'], { env: { CR_MONITOR_KEY: KEY, CR_MONITOR_ENDPOINT: 'http://127.0.0.1:9/api/v1/app-reports' } });
  assert.equal(r.code, 6);
  assert.match(r.err, /not reported: the console could not be reached/);
  fake.state.reportStatus = 403;
  r = await run(['run', '--', NODE, '-e', 'process.exit(7)'], { env: { CR_MONITOR_KEY: KEY } });
  assert.equal(r.code, 7);
  assert.match(r.err, /not reported: The console refused the report/);
  r = await run(['run']);
  assert.equal(r.code, 2);
});

test('run: a command stopped by a signal is not reported when the person stopped it', { skip: process.platform === 'win32' }, async () => {
  const r = await run(['run', '--', NODE, '-e', "process.kill(process.pid, 'SIGTERM')"], { env: { CR_MONITOR_KEY: KEY } });
  assert.equal(r.code, 143);
  assert.equal(fake.state.reports.length, 0);
});

test('init: a Node project, the file from the console checked by SHA-256, the key in .env, a warning when .env is not ignored', async () => {
  writeFileSync(join(work, 'package.json'), JSON.stringify({ name: 'shop', type: 'module' }));
  git('init', '-q');
  const r = await run(['init', '--key', KEY, '--from', 'download']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /This looks like a Node\.js project \(package\.json\)/);
  const file = readFileSync(join(work, 'cyberrakshak-monitor.mjs'), 'utf8');
  assert.equal(file, SDK_FILES['node/cyberrakshak-monitor.mjs']);
  assert.ok(!existsSync(join(work, 'cyberrakshak-monitor.cjs')));
  assert.equal(readFileSync(join(work, '.env'), 'utf8'), `CR_MONITOR_KEY=${KEY}\n`);
  assert.match(r.err, /Warning: \.env is not in \.gitignore/);
  assert.match(r.out, /import \* as monitor from '\.\/cyberrakshak-monitor\.mjs';/);
  assert.match(r.out, /process\.env\.CR_MONITOR_KEY/);
  assert.doesNotMatch(r.out, new RegExp(KEY), 'a key the person gave is never printed back');
  // Ignored now: no warning; the line replaced, the rest of .env kept as it was, its CRLF too.
  writeFileSync(join(work, '.gitignore'), '.env\n');
  writeFileSync(join(work, '.env'), 'APP=1\r\nCR_MONITOR_KEY=crk_old\r\nOTHER=2\r\n');
  const again = await run(['init', '--key', KEY, '--from', 'download', '--json']);
  assert.equal(again.code, 0, again.err);
  assert.equal(readFileSync(join(work, '.env'), 'utf8'), `APP=1\r\nCR_MONITOR_KEY=${KEY}\r\nOTHER=2\r\n`);
  assert.equal(again.json.key.gitignored, true);
  assert.equal(again.json.install.files[0].status, 'up to date');
  assert.equal(again.json.install.files[0].sha256, createHash('sha256').update(SDK_FILES['node/cyberrakshak-monitor.mjs']).digest('hex'));
});

test('init: never writes the key into a .env git tracks', async () => {
  writeFileSync(join(work, 'requirements.txt'), 'flask\n');
  git('init', '-q');
  writeFileSync(join(work, '.env'), 'APP=1\n');
  git('add', '.env');
  await signIn();
  const r = await run(['init', '--site', 'shop.example.org', '--from', 'download']);
  assert.equal(r.code, 0, r.err);
  assert.equal(readFileSync(join(work, '.env'), 'utf8'), 'APP=1\n');
  assert.match(r.out, /git tracks \.env here, and the key must never be committed/);
  // A key made just now cannot be shown again: this once, then.
  assert.match(r.out, new RegExp('shown this once: ' + fake.state.madeKeys[0]));
  assert.ok(existsSync(join(work, 'cyberrakshak_monitor.py')));
});

test('init: from the registry where it is published; when the package manager fails, the checked file instead', async () => {
  writeFileSync(join(work, 'package.json'), JSON.stringify({ name: 'api' }));
  let npm = fakeTool('npm', 0);
  let r = await run(['init', '--key', KEY], { env: { PATH: npm.PATH } });
  assert.equal(r.code, 0, r.err);
  assert.equal(npm.called(), 'npm install @cyberrakshak/monitor');
  assert.ok(!existsSync(join(work, 'cyberrakshak-monitor.cjs')));
  assert.match(r.out, /const monitor = require\('@cyberrakshak\/monitor'\);/);

  npm = fakeTool('npm', 1);
  r = await run(['init', '--key', KEY, '--json'], { env: { PATH: npm.PATH } });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.json.install.from, 'download');
  assert.equal(r.json.install.registry_tried.status, 'npm ended with code 1');
  assert.ok(existsSync(join(work, 'cyberrakshak-monitor.cjs')), 'CommonJS: package.json has no "type": "module"');
  assert.match(r.json.start[0], /require\('\.\/cyberrakshak-monitor\.cjs'\)/);

  // PHP from Packagist; --no-install only says what to run.
  const php = scratch('cr-cli-php-');
  writeFileSync(join(php, 'composer.json'), '{}');
  r = await cli(['init', '--key', KEY, '--no-install'], { fake, configDir: dir, cwd: php });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /cyberrakshak\/monitor: not run \(--no-install\) \(run: composer require cyberrakshak\/monitor\)/);
  assert.match(r.out, /getenv\('CR_MONITOR_KEY'\)/);
  assert.doesNotMatch(r.out, /require_once/);
});

test('init: Android and iOS get the Gradle and Swift Package Manager lines, and the key is never put in a file', async () => {
  writeFileSync(join(work, 'settings.gradle.kts'), 'rootProject.name = "shop"\n');
  writeFileSync(join(work, 'build.gradle.kts'), 'plugins { id("com.android.application") }\n');
  let r = await run(['init', '--key', KEY]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /This looks like a Android \(Kotlin\) project/);
  assert.match(r.out, /maven\("https:\/\/jitpack\.io"\)/);
  assert.match(r.out, /implementation\("com\.github\.LaabamOne-Business-Solutions-Pvt-Ltd:cyberrakshak-monitor-android:1\.0\.0"\)/);
  assert.ok(!existsSync(join(work, '.env')));
  const ios = scratch('cr-cli-ios-');
  writeFileSync(join(ios, 'Package.swift'), '// swift-tools-version:5.9\n');
  r = await cli(['init', '--key', KEY, '--json'], { fake, configDir: dir, cwd: ios });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.json.type, 'ios');
  assert.equal(r.json.install.from, 'swiftpm');
  assert.equal(r.json.key.written_to, null);
  assert.ok(r.json.start.includes('import CyberRakshakMonitor'));
});

test('init: a download that does not match its SHA-256 is not written', async () => {
  writeFileSync(join(work, 'run.sh'), '#!/bin/sh\n');
  fake.state.sdkTamper = 'shell/cr-report.sh';
  const r = await run(['init', '--key', KEY]);
  assert.equal(r.code, 1);
  assert.match(r.err, /cr-report\.sh as downloaded does not match the SHA-256 in \/sdk\/index\.json, so it was not written/);
  assert.ok(!existsSync(join(work, 'cr-report.sh')));
});

test('init: a key for --site is made when the site has none, kept when .env has the site\'s, and never replaced unasked', async () => {
  await signIn();
  writeFileSync(join(work, 'composer.json'), '{}');
  let r = await run(['init', '--site', 'example.com', '--no-install']);
  assert.equal(r.code, 1);
  assert.match(r.err, /example\.com already has an app key \(crk_••••C3d4\).*--new-key/s);
  writeFileSync(join(work, '.env'), `CR_MONITOR_KEY=${KEY}\n`);
  r = await run(['init', '--site', 'example.com', '--no-install', '--json']);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.json.key.from, '.env');
  assert.equal(fake.state.madeKeys.length, 0);
  r = await run(['init', '--site', 'example.com', '--no-install', '--new-key', '--json']);
  assert.equal(r.code, 0, r.err);
  assert.equal(fake.state.madeKeys.length, 1);
  assert.equal(readFileSync(join(work, '.env'), 'utf8'), `CR_MONITOR_KEY=${fake.state.madeKeys[0]}\n`);
  r = await run(['init', '--no-install']);
  assert.equal(r.code, 0, 'the key in .env is enough');
  const empty = scratch('cr-cli-empty-');
  r = await cli(['init'], { fake, configDir: dir, cwd: empty });
  assert.equal(r.code, 2);
  assert.match(r.err, /Say which site/);
  r = await cli(['init', '--type', 'cobol', '--key', KEY], { fake, configDir: dir, cwd: empty });
  assert.equal(r.code, 2);
});
