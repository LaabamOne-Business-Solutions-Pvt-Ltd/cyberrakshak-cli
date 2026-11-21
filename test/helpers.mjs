// Running the command line in this process against the fake console, with its output captured.
import { request as httpRequest } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../lib/main.mjs';

const made = [];
process.on('exit', () => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

/** A new empty folder, removed when the tests end. */
export function scratch(prefix = 'cr-cli-') {
  const d = mkdtempSync(join(tmpdir(), prefix));
  made.push(d);
  return d;
}

class Sink {
  constructor() {
    this.text = '';
  }
  write(chunk) {
    this.text += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  }
}

/**
 * Run `cyberrakshak <args>`. `env` is the whole environment the command sees (tests never inherit the real one, so no
 * real token or console can leak in).
 */
export async function cli(args, { fake, env = {}, configDir, ...io } = {}) {
  const out = new Sink();
  const err = new Sink();
  const fullEnv = {
    CYBERRAKSHAK_CONFIG_DIR: configDir,
    ...(fake ? { CYBERRAKSHAK_CONSOLE: fake.url } : {}),
    CYBERRAKSHAK_BROWSER: 'none',
    PATH: process.env.PATH,
    PATHEXT: process.env.PATHEXT,
    SystemRoot: process.env.SystemRoot,
    ...env,
  };
  for (const k of Object.keys(fullEnv)) if (fullEnv[k] === undefined) delete fullEnv[k];
  const code = await main(args, { out, err, env: fullEnv, sleep: io.sleep || (() => Promise.resolve()), ...io });
  return { code, out: out.text, err: err.text, json: tryJson(out.text) };
}

function tryJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** GET a URL without following redirects. */
export function get(url) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { method: 'GET', agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

/**
 * A stand-in for the person's browser: opens the console's /cli/auth page (which, in the fake, answers Allow or Deny at
 * once) and follows its redirect to the command line's own listener. `before` runs first (a stray visit, say).
 */
export function fakeBrowser(record = {}, before = null) {
  return async (url) => {
    record.url = url;
    setTimeout(async () => {
      try {
        if (before) await before(url);
        const page = await get(url);
        record.consoleStatus = page.status;
        if (page.status === 302) {
          const back = await get(page.headers.location);
          record.callback = page.headers.location;
          record.callbackStatus = back.status;
          record.callbackBody = back.body;
        }
      } catch (e) {
        record.error = e;
      }
    }, 20);
    return true;
  };
}
