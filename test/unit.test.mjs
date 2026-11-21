// The parts on their own: scrubbing (the libraries' shared cases), the console address, where the sign-in is kept,
// what a folder is, and .env.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { consoleUrl, configDir, currentToken, forgetSignIn, saveSignIn, savedSignIn } from '../lib/config.mjs';
import { pkce, computerName } from '../lib/auth.mjs';
import { detect, writeEnvKey } from '../lib/project.mjs';
import { clean, scrub, sendable } from '../lib/scrub.mjs';
import { LIBRARIES, snippet, TYPES, wantedFiles } from '../lib/sdk.mjs';
import { parse } from '../lib/main.mjs';
import { VERSION } from '../lib/version.mjs';
import { scratch } from './helpers.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));

test('scrub: every case the monitoring libraries share', () => {
  const { vectors } = JSON.parse(readFileSync(join(here, 'scrub-vectors.json'), 'utf8'));
  assert.ok(vectors.length > 20);
  for (const v of vectors) assert.equal(scrub(v.in), v.out, JSON.stringify(v.in));
});

test('what is sent is cleaned of terminal codes and cut from the end for an error output', () => {
  assert.equal(clean('\u001b[31mred\u001b[0m text\u0007'), 'red text');
  assert.equal(sendable('a'.repeat(50) + 'END', 10, true), 'aaaaaaaEND');
  assert.equal(sendable('START' + 'b'.repeat(50), 8), 'STARTbbb');
});

test('the console address: https anywhere, http only on this computer, the origin only', () => {
  assert.equal(consoleUrl(undefined, {}), 'https://app.cyberrakshak.ai');
  assert.equal(consoleUrl('https://app.cyberrakshak.ai/some/path?x=1', {}), 'https://app.cyberrakshak.ai');
  assert.equal(consoleUrl(undefined, { CYBERRAKSHAK_CONSOLE: 'http://127.0.0.1:8000' }), 'http://127.0.0.1:8000');
  assert.equal(consoleUrl('http://localhost:8000', {}), 'http://localhost:8000');
  for (const bad of ['http://app.cyberrakshak.ai', 'file:///etc/passwd', 'nonsense', 'https://a:b@c.example']) {
    assert.throws(() => consoleUrl(bad, {}), (e) => e.code === 'usage', bad);
  }
});

test('the sign-in is kept per console, readable by the user alone, and forgotten cleanly', () => {
  const dir = scratch();
  const env = { CYBERRAKSHAK_CONFIG_DIR: join(dir, 'nested', 'cyberrakshak') };
  saveSignIn('https://a.example', { token: '1|a' }, env);
  saveSignIn('http://127.0.0.1:8000', { token: '2|b' }, env);
  assert.equal(savedSignIn('https://a.example', env).token, '1|a');
  if (process.platform !== 'win32') {
    assert.equal(statSync(join(env.CYBERRAKSHAK_CONFIG_DIR, 'credentials.json')).mode & 0o777, 0o600);
    assert.equal(statSync(env.CYBERRAKSHAK_CONFIG_DIR).mode & 0o777, 0o700);
  }
  assert.deepEqual(currentToken('https://a.example', { ...env, CYBERRAKSHAK_TOKEN: ' 9|env ' }), { token: '9|env', source: 'env' });
  assert.equal(forgetSignIn('https://a.example', env), true);
  assert.equal(savedSignIn('https://a.example', env), null);
  assert.equal(forgetSignIn('http://127.0.0.1:8000', env), true);
  assert.ok(!existsSync(join(env.CYBERRAKSHAK_CONFIG_DIR, 'credentials.json')), 'no file is left holding nothing');
  // A damaged file is no sign-in, not a crash.
  mkdirSync(env.CYBERRAKSHAK_CONFIG_DIR, { recursive: true });
  writeFileSync(join(env.CYBERRAKSHAK_CONFIG_DIR, 'credentials.json'), '{not json');
  assert.equal(savedSignIn('https://a.example', env), null);
});

test('the OS config folder', () => {
  const dir = configDir({ APPDATA: 'C:\\Users\\a\\AppData\\Roaming', XDG_CONFIG_HOME: '/home/a/.config' });
  assert.match(dir, process.platform === 'win32' ? /AppData[\\/]Roaming[\\/]cyberrakshak$/ : /\.config[\\/]cyberrakshak$/);
});

test('PKCE: a 43-character verifier and its S256 challenge', () => {
  const a = pkce();
  const b = pkce();
  assert.match(a.verifier, /^[A-Za-z0-9_-]{43}$/);
  assert.match(a.challenge, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(a.verifier, b.verifier);
  assert.ok(computerName().length > 0 && computerName().length <= 60);
});

test('what a folder is', () => {
  const make = (files) => {
    const d = scratch('cr-cli-detect-');
    for (const [name, body] of Object.entries(files)) {
      mkdirSync(join(d, name, '..'), { recursive: true });
      writeFileSync(join(d, name), body);
    }
    return detect(d);
  };
  assert.deepEqual(make({ 'package.json': '{"type":"module"}' }).type, 'node');
  assert.equal(make({ 'package.json': '{}' }).flavour, 'cjs');
  assert.equal(make({ 'package.json': '{"dependencies":{"expo":"52"}}' }).type, 'react-native');
  assert.equal(make({ 'package.json': '{"dependencies":{"expo":"52"}}' }).expo, true);
  assert.equal(make({ 'package.json': '{"dependencies":{"react-native":"0.76"}}', 'android/build.gradle': 'x' }).type, 'react-native');
  assert.equal(make({ 'composer.json': '{}' }).type, 'php');
  const laravel = make({ 'composer.json': '{}', 'package.json': '{}' });
  assert.equal(laravel.type, 'node');
  assert.deepEqual(laravel.also, ['php']);
  assert.equal(make({ 'pyproject.toml': '' }).type, 'python');
  assert.equal(make({ 'requirements.txt': '' }).type, 'python');
  assert.equal(make({ 'settings.gradle.kts': '', 'app/build.gradle.kts': 'plugins { id("com.android.application") }' }).type, 'android');
  assert.equal(make({ 'settings.gradle': '' }).type, 'shell', 'Gradle without Android is not an Android app');
  assert.equal(make({ 'Package.swift': '' }).type, 'ios');
  assert.equal(make({ 'Shop.xcodeproj/project.pbxproj': '' }).type, 'ios');
  assert.equal(make({ 'backup.sh': '#!/bin/sh' }).type, 'shell');
  assert.equal(make({}).type, 'shell');
});

test('.env: the line put in or replaced, the rest and its line endings kept', () => {
  const d = scratch('cr-cli-env-');
  let w = writeEnvKey(d, 'CR_MONITOR_KEY', 'crk_x');
  assert.equal(w.created, true);
  assert.equal(readFileSync(join(d, '.env'), 'utf8'), 'CR_MONITOR_KEY=crk_x\n');
  writeFileSync(join(d, '.env'), 'A=1\r\nexport CR_MONITOR_KEY=old\r\nB=2');
  w = writeEnvKey(d, 'CR_MONITOR_KEY', 'crk_y');
  assert.equal(w.replaced, true);
  assert.equal(readFileSync(join(d, '.env'), 'utf8'), 'A=1\r\nCR_MONITOR_KEY=crk_y\r\nB=2\r\n');
});

test('every library has an install, a start, and a file to fall back to (shell: the file only)', () => {
  const index = { files: [
    { platform: 'node', save_as: 'cyberrakshak-monitor.mjs' }, { platform: 'node', save_as: 'cyberrakshak-monitor.cjs' }, { platform: 'shell', save_as: 'cr-report.sh' },
  ] };
  assert.deepEqual(wantedFiles(index, 'node').map((f) => f.save_as), ['cyberrakshak-monitor.mjs']);
  assert.deepEqual(wantedFiles(index, 'node', { flavour: 'cjs' }).map((f) => f.save_as), ['cyberrakshak-monitor.cjs']);
  for (const type of TYPES) {
    const lib = LIBRARIES[type];
    assert.ok(snippet(type).length > 0, type);
    if (type === 'shell') {
      assert.equal(lib.registry, null);
      continue;
    }
    assert.equal(lib.registry.published, true, type);
    assert.ok(lib.registry.install || lib.registry.lines, type);
    // On Windows the package manager runs through cmd.exe: nothing in its words may mean something to it.
    if (lib.registry.install) assert.doesNotMatch(lib.registry.install.join(' '), /[\^<>&|%]/, type);
  }
  assert.match(snippet('node', { fromRegistry: true }).join('\n'), /from '@cyberrakshak\/monitor'/);
  assert.match(snippet('php', { fromRegistry: false }).join('\n'), /require_once/);
});

test('reading the command line', () => {
  assert.deepEqual(parse(['run', '--route', 'x', '--', 'cmd', '--json']), { positional: ['run'], flags: { route: 'x' }, rest: ['cmd', '--json'] });
  assert.deepEqual(parse(['errors', 'a.example', '--page=2', '--json']).flags, { page: '2', json: true });
  assert.throws(() => parse(['--json=yes']), (e) => e.code === 'usage');
  assert.throws(() => parse(['--site']), (e) => e.code === 'usage');
  assert.throws(() => parse(['--nope']), (e) => e.code === 'usage');
});

test('the version is package.json\'s', () => {
  assert.equal(VERSION, JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')).version);
});
