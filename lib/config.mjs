// Where the command line keeps its sign-in, and which console it talks to.
//
// The sign-in is a token, kept in the user's own config folder (Windows %APPDATA%\cyberrakshak\, macOS and Linux
// ~/.config/cyberrakshak/, or $XDG_CONFIG_HOME/cyberrakshak/), in credentials.json, readable by the user alone (0600;
// on Windows the folder is already the user's own). One sign-in per console, so signing in to a test console never
// replaces the real one. CYBERRAKSHAK_TOKEN, when set, is used instead of the file (CI and servers).
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { usage } from './errors.mjs';

export const DEFAULT_CONSOLE = 'https://app.cyberrakshak.ai';

/** The folder, from CYBERRAKSHAK_CONFIG_DIR when set (tests, or a shared machine), else the OS's own place. */
export function configDir(env = process.env) {
  if (env.CYBERRAKSHAK_CONFIG_DIR) return env.CYBERRAKSHAK_CONFIG_DIR;
  if (process.platform === 'win32') return join(env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'cyberrakshak');
  return join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'cyberrakshak');
}

export function credentialsPath(env = process.env) {
  return join(configDir(env), 'credentials.json');
}

/**
 * The console's address: --console, else CYBERRAKSHAK_CONSOLE, else app.cyberrakshak.ai. Only its origin is kept.
 * Plain http only for this computer (127.0.0.1, localhost, ::1): a token is never sent unencrypted across a network.
 */
export function consoleUrl(flag, env = process.env) {
  const given = flag || env.CYBERRAKSHAK_CONSOLE || DEFAULT_CONSOLE;
  let url;
  try {
    url = new URL(given);
  } catch {
    throw usage(`"${given}" is not a web address. Give the console as https://…`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw usage('The console must be an https:// address.');
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.protocol === 'http:' && !local) throw usage('The console must be an https:// address (http:// only for this computer).');
  if (url.username || url.password) throw usage('The console address must not carry a user name or password.');
  return url.origin;
}

function readAll(env) {
  const path = credentialsPath(env);
  if (!existsSync(path)) return { consoles: {} };
  try {
    const data = JSON.parse(readFileSync(path, 'utf8'));
    return data && typeof data === 'object' && data.consoles && typeof data.consoles === 'object' ? data : { consoles: {} };
  } catch {
    return { consoles: {} };
  }
}

function writeAll(data, env) {
  const dir = configDir(env);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = credentialsPath(env);
  const tmp = path + '.' + process.pid + '.tmp';
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  try {
    chmodSync(tmp, 0o600);
  } catch {
    // Windows: the folder is the user's own.
  }
  // On Windows a file being read at that moment (an antivirus scan, an editor) refuses to be replaced for a moment:
  // a few tries, then written in place.
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(tmp, path);
      return;
    } catch (e) {
      if (attempt >= 4 || !['EPERM', 'EACCES', 'EBUSY'].includes(e && e.code)) {
        writeFileSync(path, readFileSync(tmp), { mode: 0o600 });
        rmSync(tmp, { force: true });
        return;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
}

/** The saved sign-in for a console, or null. */
export function savedSignIn(console, env = process.env) {
  const entry = readAll(env).consoles[console];
  return entry && typeof entry.token === 'string' && entry.token !== '' ? entry : null;
}

export function saveSignIn(console, entry, env = process.env) {
  const data = readAll(env);
  data.consoles[console] = entry;
  writeAll(data, env);
}

/** Forget a console's sign-in; the file goes when it holds no other. */
export function forgetSignIn(console, env = process.env) {
  const data = readAll(env);
  if (!(console in data.consoles)) return false;
  delete data.consoles[console];
  if (Object.keys(data.consoles).length === 0) {
    rmSync(credentialsPath(env), { force: true });
  } else {
    writeAll(data, env);
  }
  return true;
}

/** The token to use: CYBERRAKSHAK_TOKEN when set, else the saved one. */
export function currentToken(console, env = process.env) {
  if (env.CYBERRAKSHAK_TOKEN && env.CYBERRAKSHAK_TOKEN.trim() !== '') return { token: env.CYBERRAKSHAK_TOKEN.trim(), source: 'env' };
  const saved = savedSignIn(console, env);
  return saved ? { token: saved.token, source: 'file', saved } : null;
}
