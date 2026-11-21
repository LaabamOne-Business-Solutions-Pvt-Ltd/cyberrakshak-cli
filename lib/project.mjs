// What kind of project a folder is, and writing the app key where it belongs (never into a file git tracks).
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const has = (dir, name) => existsSync(join(dir, name));

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * The project's type, and what else it looks like (a folder can be two things: a Laravel app with a package.json).
 * @returns {{type: string, also: string[], flavour: 'esm'|'cjs', expo: boolean, why: string}}
 */
export function detect(dir) {
  const found = [];
  let flavour = 'esm';
  let expo = false;
  const pkg = has(dir, 'package.json') ? readJson(join(dir, 'package.json')) : null;
  if (pkg) {
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    expo = 'expo' in deps;
    if (expo || 'react-native' in deps) found.push(['react-native', expo ? 'package.json uses Expo' : 'package.json uses React Native']);
    else found.push(['node', 'package.json']);
    flavour = pkg.type === 'module' ? 'esm' : 'cjs';
  }
  if (has(dir, 'composer.json')) found.push(['php', 'composer.json']);
  for (const f of ['pyproject.toml', 'requirements.txt', 'setup.py', 'Pipfile']) {
    if (has(dir, f)) {
      found.push(['python', f]);
      break;
    }
  }
  const gradle = ['settings.gradle', 'settings.gradle.kts', 'build.gradle', 'build.gradle.kts'].find((f) => has(dir, f));
  if (gradle && (androidPlugin(dir) || has(dir, 'app/src/main/AndroidManifest.xml'))) found.push(['android', gradle]);
  let entries = [];
  try {
    entries = readdirSync(dir);
  } catch {
    entries = [];
  }
  const xcode = entries.find((e) => e.endsWith('.xcodeproj') || e.endsWith('.xcworkspace'));
  if (has(dir, 'Package.swift')) found.push(['ios', 'Package.swift']);
  else if (xcode) found.push(['ios', xcode]);
  // React Native carries android/ and ios/ folders: it is one React Native app, not three.
  const types = [...new Set(found.map(([t]) => t))];
  if (found.length === 0) {
    const scripts = entries.filter((e) => e.endsWith('.sh'));
    return { type: 'shell', also: [], flavour, expo, why: scripts.length ? `shell scripts (${scripts.slice(0, 3).join(', ')})` : 'no app files found: shell and cron' };
  }
  return { type: found[0][0], also: types.slice(1), flavour, expo, why: found[0][1] };
}

function androidPlugin(dir) {
  for (const f of ['build.gradle', 'build.gradle.kts', 'app/build.gradle', 'app/build.gradle.kts']) {
    if (has(dir, f)) {
      try {
        if (/com\.android\.(application|library)|android\s*\{/.test(readFileSync(join(dir, f), 'utf8'))) return true;
      } catch {
        // unreadable: not decisive
      }
    }
  }
  return false;
}

function git(dir, args) {
  try {
    const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8', timeout: 10000, windowsHide: true });
    return r.error ? null : r;
  } catch {
    return null;
  }
}

/** Whether git tracks the file, ignores it, and whether the folder is in a repository at all. */
export function gitState(dir, file) {
  const inside = git(dir, ['rev-parse', '--is-inside-work-tree']);
  if (!inside || inside.status !== 0 || inside.stdout.trim() !== 'true') return { repo: false, tracked: false, ignored: false };
  const tracked = git(dir, ['ls-files', '--error-unmatch', '--', file]);
  const ignored = git(dir, ['check-ignore', '-q', '--', file]);
  return { repo: true, tracked: !!tracked && tracked.status === 0, ignored: !!ignored && ignored.status === 0 };
}

/**
 * Put NAME=key in the folder's .env: the line replaced if it is there, else added; the rest of the file as it was,
 * its line endings too. Refuses (returns { written: false, reason: 'tracked' }) when git tracks .env.
 */
export function writeEnvKey(dir, name, key) {
  const file = join(dir, '.env');
  const state = gitState(dir, '.env');
  if (state.tracked) return { written: false, reason: 'tracked', file, git: state };
  const existed = existsSync(file);
  const text = existed ? readFileSync(file, 'utf8') : '';
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text === '' ? [] : text.split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const pattern = new RegExp(`^\\s*(export\\s+)?${name}\\s*=`);
  let replaced = false;
  const out = lines.map((l) => {
    if (pattern.test(l)) {
      replaced = true;
      return `${name}=${key}`;
    }
    return l;
  });
  if (!replaced) out.push(`${name}=${key}`);
  writeFileSync(file, out.join(eol) + eol, existed ? undefined : { mode: 0o600 });
  if (!existed) {
    try {
      chmodSync(file, 0o600);
    } catch {
      // Windows
    }
  }
  return { written: true, replaced, created: !existed, file, git: state };
}
