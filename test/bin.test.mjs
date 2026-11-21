// The real `cyberrakshak` command, as a separate process, against the fake console: it ends by itself (nothing left
// holding the terminal), with the right exit code.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startFakeConsole } from './fake-console.mjs';
import { scratch } from './helpers.mjs';

const BIN = fileURLToPath(new URL('../bin/cyberrakshak.mjs', import.meta.url));
let fake;
before(async () => {
  fake = await startFakeConsole();
});
after(async () => {
  await fake.close();
});

function cyberrakshak(args, env) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [BIN, ...args], {
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, CYBERRAKSHAK_BROWSER: 'none', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => (out += c));
    child.stderr.on('data', (c) => (err += c));
    const timer = setTimeout(() => child.kill(), 20000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out, err, ms: Date.now() - started });
    });
  });
}

test('signs in with a code, answers whoami, runs a command with its own exit code, and every run ends promptly', async () => {
  const env = { CYBERRAKSHAK_CONFIG_DIR: scratch(), CYBERRAKSHAK_CONSOLE: fake.url };
  // The device flow waits its 5 s interval once before it asks.
  let r = await cyberrakshak(['login', '--no-browser'], env);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /Signed in as Asha Rao/);
  r = await cyberrakshak(['whoami', '--json'], env);
  assert.equal(r.code, 0, r.err);
  assert.equal(JSON.parse(r.out).user.email, 'asha@example.invalid');
  assert.ok(r.ms < 5000, `whoami took ${r.ms} ms`);
  r = await cyberrakshak(['run', '--', process.execPath, '-e', 'process.exit(9)'], env);
  assert.equal(r.code, 9);
  r = await cyberrakshak(['sites', '--console', 'http://127.0.0.1:9'], env);
  assert.equal(r.code, 3);
  r = await cyberrakshak(['logout'], env);
  assert.equal(r.code, 0);
  r = await cyberrakshak(['whoami'], env);
  assert.equal(r.code, 3);
  assert.ok(r.ms < 5000);
});
