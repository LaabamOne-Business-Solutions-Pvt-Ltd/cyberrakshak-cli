// `cyberrakshak init`: set error monitoring up in this project. What kind of project it is; the library, from a
// registry where it is published, else downloaded from the console and checked against its SHA-256; the app key in
// .env (never in a file git tracks), or where it goes for a mobile app; and how the library starts.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { offline } from './api.mjs';
import { CliError, EXIT, usage } from './errors.mjs';
import { Offline, request } from './http.mjs';
import { addApp, asArg, createKey, defaultEndpoint, findKey, findSite, masked, target as asTarget } from './monitoring.mjs';
import { line, note, printJson } from './output.mjs';
import { detect, gitState, writeEnvKey } from './project.mjs';
import { LIBRARIES, snippet, TYPES, wantedFiles } from './sdk.mjs';

/** A package manager gets this long; then it is stopped and the command to run is printed. */
const INSTALL_WAIT_MS = 5 * 60 * 1000;

async function fetchChecked(ctx, path) {
  let res;
  try {
    res = await request(ctx.console + path, { headers: { Accept: '*/*' } });
  } catch (e) {
    if (e instanceof Offline) throw offline(ctx, e);
    throw e;
  }
  if (res.status !== 200) throw new CliError('console_error', `The console did not give ${path} (HTTP ${res.status}). Try again in a minute.`, EXIT.OFFLINE);
  return res;
}

/** Download the type's files from /sdk/, each checked against index.json's SHA-256 before it is written. */
async function download(ctx, dir, type, flavour, force) {
  const index = (await fetchChecked(ctx, '/sdk/index.json')).json;
  if (!index || !Array.isArray(index.files)) throw new CliError('console_error', 'The console\'s list of libraries (/sdk/index.json) could not be read.', EXIT.OFFLINE);
  const files = wantedFiles(index, type, { flavour });
  if (files.length === 0) throw new CliError('failed', `The console has no ${LIBRARIES[type].label} library to download.`, EXIT.FAILED);
  const done = [];
  for (const f of files) {
    if (!/^\/sdk\/[A-Za-z0-9_./-]+$/.test(f.path) || f.path.includes('..') || !/^[A-Za-z0-9_.-]+$/.test(f.save_as) || !/^[0-9a-f]{64}$/.test(f.sha256)) {
      throw new CliError('failed', 'The console\'s list of libraries has an entry that cannot be used.', EXIT.FAILED);
    }
    const target = join(dir, f.save_as);
    if (existsSync(target)) {
      const have = createHash('sha256').update(readFileSync(target)).digest('hex');
      if (have === f.sha256) {
        done.push({ file: f.save_as, sha256: f.sha256, status: 'up to date' });
        continue;
      }
      if (!force) {
        done.push({ file: f.save_as, sha256: f.sha256, status: 'kept yours (it differs; --force replaces it)' });
        continue;
      }
    }
    const body = (await fetchChecked(ctx, f.path)).body;
    const sha = createHash('sha256').update(body).digest('hex');
    if (sha !== f.sha256) {
      throw new CliError('failed', `${f.save_as} as downloaded does not match the SHA-256 in /sdk/index.json, so it was not written. Try again; if it happens again, tell us.`, EXIT.FAILED);
    }
    writeFileSync(target, body);
    if (f.save_as.endsWith('.sh')) {
      try {
        chmodSync(target, 0o755);
      } catch {
        // Windows
      }
    }
    done.push({ file: f.save_as, sha256: sha, status: 'downloaded and checked' });
  }
  return done;
}

/** Run the package manager, in the project, for at most INSTALL_WAIT_MS. Resolves to { ok, code }. */
function runInstall(ctx, dir, argv) {
  return new Promise((resolvePromise) => {
    let child;
    const windows = process.platform === 'win32';
    try {
      // npm, composer and pip are .cmd files on Windows, which only a shell runs; the arguments are fixed words.
      child = spawn(argv[0], argv.slice(1), { cwd: dir, env: ctx.env, stdio: ['ignore', 'inherit', 'inherit'], shell: windows, windowsHide: true });
    } catch {
      resolvePromise({ ok: false, code: null, missing: true });
      return;
    }
    const timer = setTimeout(() => {
      child.kill();
      note(ctx, `${argv[0]} did not finish in ${INSTALL_WAIT_MS / 60000} minutes and was stopped.`);
    }, INSTALL_WAIT_MS);
    child.on('error', () => {
      clearTimeout(timer);
      resolvePromise({ ok: false, code: null, missing: true });
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolvePromise({ ok: code === 0, code, missing: false });
    });
  });
}

export async function init(ctx, opts = {}) {
  const dir = resolve(ctx.cwd || process.cwd(), opts.dir || '.');
  if (!existsSync(dir)) throw usage(`There is no folder ${dir}.`);
  const seen = detect(dir);
  const type = opts.type || seen.type;
  if (!TYPES.includes(type)) throw usage(`--type is one of: ${TYPES.join(', ')}.`);
  const lib = LIBRARIES[type];
  const report = { folder: dir, type, detected: { type: seen.type, from: seen.why, also: seen.also }, install: null, key: null, start: [] };
  if (!ctx.json) {
    line(ctx, opts.type ? `Setting up ${lib.label} (as asked).` : `This looks like a ${lib.label} project (${seen.why}).`);
    if (!opts.type && seen.also.length) line(ctx, `It also looks like: ${seen.also.map((t) => LIBRARIES[t].label).join(', ')}. To set that up instead: --type ${seen.also[0]}`);
  }

  // 1. The app key: --key; else for --site or --app, the one already here if it is that one's, or one made now (with
  //    --app and --kind, the app is added first when the account has none of that name); else the one already in
  //    CR_MONITOR_KEY or .env. `chosen`: the website or app, when it is known, for where its reports go.
  if (opts.site && opts.app) throw usage('One at a time: --site for a website, or --app for an app.');
  if (opts.kind && !opts.app) throw usage('--kind goes with --app: cyberrakshak init --app "Shop app" --kind mobile');
  let key = null;
  let keySource = null;
  let madeNow = false;
  let chosen = null;
  const quiet = { ...ctx, json: true, out: { write() {} } };
  const here = opts.key ? null : findKey(ctx, null, dir);
  if (opts.key) {
    ({ key, where: keySource } = findKey(ctx, opts.key, dir));
  } else if (opts.site || opts.app) {
    let found = null;
    try {
      found = await findSite(ctx, opts.site || opts.app);
    } catch (e) {
      if (!(opts.app && opts.kind && e instanceof CliError && e.code === 'not_found')) throw e;
    }
    if (found === null) {
      const made = await addApp(quiet, opts.app, { kind: opts.kind, region: opts.region || null });
      chosen = asTarget(made.app, true);
      key = made.key;
      keySource = `made now for ${chosen.label}, added now`;
      madeNow = true;
    } else {
      const { site, monitoring } = found;
      chosen = site;
      if (!monitoring) throw new CliError('no_access', 'Error monitoring is not available on your account yet.', EXIT.NO_ACCESS);
      const current = site.monitoring && site.monitoring.app_key && site.monitoring.app_key.on ? site.monitoring.app_key : null;
      if (current && here && here.key.slice(-4) === current.hint && !opts.newKey) {
        ({ key, where: keySource } = here);
      } else if (current && !opts.newKey) {
        throw new CliError('failed', `${site.label} already has an app key (${current.masked}), and it is not in ${here ? here.where : 'CR_MONITOR_KEY or .env'}. Give it with --key, or make a new one with --new-key: the old one then stops working at once.`, EXIT.FAILED);
      } else {
        const made = await createKey(quiet, site.id, { replace: !!current });
        key = made.key;
        keySource = `made now for ${site.label}`;
        madeNow = true;
      }
    }
  } else if (here) {
    ({ key, where: keySource } = here);
  } else {
    throw usage('Say what the errors are for: --site example.com for a website, --app "Shop app" for an app (with --kind mobile, api, mcp or script to add it), or give its app key (--key, or CR_MONITOR_KEY).');
  }
  // An EU website's or app's reports go to the EU server: its address goes beside the key, and into how it starts.
  const endpoint = chosen && chosen.monitoring && chosen.monitoring.endpoint && chosen.monitoring.endpoint !== defaultEndpoint(ctx) ? chosen.monitoring.endpoint : null;
  if (chosen) report.for = { id: chosen.id, kind: chosen.app ? chosen.kind : 'website', name: chosen.label, region: chosen.monitoring ? chosen.monitoring.region ?? null : null };

  // 2. The library: from its registry; when the package manager is not there or fails, the console's file, checked.
  const registry = lib.registry;
  let fromRegistry = false;
  if (opts.from === 'registry' && !registry) note(ctx, `${lib.label}: there is no registry package; the file is downloaded.`);
  const tryRegistry = registry && opts.from !== 'download' && (registry.published || opts.from === 'registry');
  if (tryRegistry && registry.lines) {
    report.install = { from: registry.tool, package: registry.name, status: 'add these lines', lines: registry.lines };
    fromRegistry = true;
  } else if (tryRegistry && opts.noInstall) {
    report.install = { from: registry.tool, package: registry.name, command: registry.install.join(' '), status: 'not run (--no-install)' };
    fromRegistry = true;
  } else if (tryRegistry) {
    if (!ctx.json) line(ctx, `Installing ${registry.name} with ${registry.tool}…`);
    const r = await runInstall(ctx, dir, registry.install);
    const tried = { from: registry.tool, package: registry.name, command: registry.install.join(' '), status: r.ok ? 'installed' : r.missing ? `${registry.tool} was not found` : `${registry.tool} ended with code ${r.code}` };
    if (r.ok) {
      report.install = tried;
      fromRegistry = true;
    } else {
      if (!ctx.json) note(ctx, `${tried.command}: ${tried.status}. Downloading the file from the console instead.`);
      report.install = { from: 'download', files: await download(ctx, dir, type, seen.flavour, !!opts.force), registry_tried: tried };
    }
  } else {
    report.install = { from: 'download', files: await download(ctx, dir, type, seen.flavour, !!opts.force) };
  }
  if (fromRegistry && registry.record) report.install.note = registry.record;

  // 3. Where the key goes, and an EU one's address beside it (the libraries are told it: their default is the console).
  const name = type === 'react-native' && !seen.expo ? null : lib.keyVar;
  const endpointVar = type === 'react-native' ? 'EXPO_PUBLIC_CR_MONITOR_ENDPOINT' : 'CR_MONITOR_ENDPOINT';
  const withEndpoint = (w) => {
    if (endpoint === null) return;
    if (w && w.written) {
      writeEnvKey(dir, endpointVar, endpoint);
      report.endpoint = { url: endpoint, written_to: '.env', variable: endpointVar };
    } else {
      report.endpoint = { url: endpoint, written_to: null };
    }
  };
  if (name && !lib.mobile) {
    const w = writeEnvKey(dir, name, key);
    report.key = { masked: masked(key), from: keySource, ...(w.written ? { written_to: '.env', variable: name } : { written_to: null, reason: 'git tracks .env' }), gitignored: w.git.ignored, git_repo: w.git.repo };
    withEndpoint(w);
  } else if (name && type === 'react-native') {
    const w = writeEnvKey(dir, name, key);
    report.key = { masked: masked(key), from: keySource, ...(w.written ? { written_to: '.env', variable: name } : { written_to: null, reason: 'git tracks .env' }), gitignored: w.git.ignored, git_repo: w.git.repo, ships_in_app: true };
    withEndpoint(w);
  } else {
    report.key = { masked: masked(key), from: keySource, written_to: null, reason: 'a mobile app carries its key in its build', ships_in_app: true };
    withEndpoint(null);
  }
  if (madeNow && !report.key.written_to) report.key.key = key;

  report.start = snippet(type, { fromRegistry, flavour: seen.flavour, expo: seen.expo, endpoint });

  if (ctx.json) {
    printJson(ctx, report);
    return report;
  }
  printReport(ctx, type, report, madeNow, key);
  return report;
}

function printReport(ctx, type, report, madeNow, key) {
  const i = report.install;
  line(ctx, '');
  if (i.from === 'download') {
    for (const f of i.files) line(ctx, `  ${f.file}: ${f.status}`);
  } else if (i.lines) {
    line(ctx, `Add the library (${i.package}):`);
    for (const l of i.lines) line(ctx, '  ' + l);
  } else {
    line(ctx, `  ${i.package}: ${i.status}${i.status.startsWith('not run') ? ` (run: ${i.command})` : ''}`);
  }
  if (i.note) line(ctx, i.note);
  line(ctx, '');
  const k = report.key;
  if (k.written_to) {
    line(ctx, `The app key ${k.masked} (${k.from}) is in ${k.written_to} as ${k.variable}.`);
    if (k.git_repo && !k.gitignored) note(ctx, `Warning: .env is not in .gitignore. Add it there, or the key could be committed.`);
    if (!k.git_repo) note(ctx, 'Note: this folder is not a git repository. Keep .env out of any copy you share.');
  } else if (k.reason === 'git tracks .env') {
    line(ctx, 'The app key was not written: git tracks .env here, and the key must never be committed.');
    line(ctx, madeNow ? `Put it in your environment as CR_MONITOR_KEY. It is shown this once: ${key}` : `Put it in your environment as CR_MONITOR_KEY (${k.masked}).`);
  } else {
    line(ctx, madeNow ? `The app key, shown this once: ${key}` : `The app key: ${k.masked} (${k.from}).`);
    line(ctx, type === 'android'
      ? 'Put it in your app as the key below (a BuildConfig field from your local, untracked properties is a good place).'
      : type === 'ios'
        ? 'Put it in your app as the key below (an Info.plist value from an untracked .xcconfig is a good place).'
        : 'Put it in your app as the key below (react-native-config, or your build settings).');
  }
  if (k.ships_in_app) line(ctx, 'In a mobile app the key ships inside the app, where someone determined can read it out. If it is misused, make a new key and release the app with it.');
  const e = report.endpoint;
  if (e && e.written_to) line(ctx, `Its data is kept in the EU, so it reports to ${e.url}: that is in ${e.written_to} as ${e.variable}.`);
  else if (e) line(ctx, `Its data is kept in the EU, so it reports to ${e.url}: give the library that address as its endpoint, as below.`);
  line(ctx, '');
  line(ctx, 'Start it once, as early as you can:');
  line(ctx, '');
  for (const l of report.start) line(ctx, '  ' + l);
  line(ctx, '');
  line(ctx, `Then check it end to end: cyberrakshak test${report.for ? ' ' + asArg(report.for.name) : ''}`);
}
