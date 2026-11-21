// Signing in and out.
//
// `login`: the browser flow. A listener on 127.0.0.1 (a port the system picks), the console's /cli/auth page opened
// with a one-off state and a PKCE challenge (S256); the person signs in there as on the website (password, Google,
// Microsoft or Apple, and two-factor) and presses Allow; the console sends the browser back to
// http://127.0.0.1:<port>/callback with a one-time code (good for about a minute), which is exchanged here, with the
// PKCE verifier only this process knows, for the sign-in's token.
//
// `login --read-only` (either flow) asks for a read-only sign-in: it reads everything a full one does, and cannot make
// or replace an app key. The one to give CI and servers.
//
// `login --no-browser`: the device flow (RFC 8628), for SSH and servers. The console gives a short code; the person
// enters it at /cli/activate on any phone or computer and presses Allow; this process asks every few seconds until then.
//
// Every wait ends: the browser flow after LOGIN_WAIT_MS, the device flow when its code expires (10 minutes).
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { hostname } from 'node:os';
import { call } from './api.mjs';
import { openBrowser } from './browser.mjs';
import { CliError, EXIT } from './errors.mjs';
import { currentToken, forgetSignIn, saveSignIn } from './config.mjs';
import { line, note, printJson, when } from './output.mjs';

/** How long the browser flow waits for Allow. */
export const LOGIN_WAIT_MS = 5 * 60 * 1000;

/** The device flow never waits longer than this, whatever the console says. */
const DEVICE_WAIT_MAX_MS = 15 * 60 * 1000;

const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export function pkce() {
  const verifier = b64url(randomBytes(32));
  return { verifier, challenge: b64url(createHash('sha256').update(verifier).digest()) };
}

/** This computer's name as the console shows it: printable, at most 60 characters. */
export function computerName() {
  const name = String(hostname() || '').replace(/[^\x20-\x7E]/g, '').trim().slice(0, 60);
  return name || 'Unnamed computer';
}

function sameText(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

/** The page the browser shows after Allow or Deny: plain, nothing loaded from anywhere. */
function page(title, text) {
  const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>:root{color-scheme:light dark}body{font:16px/1.5 system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;background:#f9fafb;color:#111827}
main{max-width:28rem;padding:2rem}h1{font-size:1.25rem;margin:0 0 .5rem}p{margin:0;color:#4b5563}
@media (prefers-color-scheme:dark){body{background:#080c16;color:#e4ebf1}p{color:#9dabbe}}</style></head>
<body><main><h1>${esc(title)}</h1><p>${esc(text)}</p></main></body></html>`;
}

/**
 * Wait for the browser to come back to the listener. Resolves to { code } or { denied: true }; rejects with a CliError
 * when the time is up.
 */
function waitForCallback(server, state, waitMs) {
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      reject(new CliError('expired', `No answer from the browser in ${Math.round(waitMs / 60000)} minutes. Run cyberrakshak login again (or cyberrakshak login --no-browser on a computer without a browser).`, EXIT.SIGNED_OUT));
    }, waitMs);
    server.on('request', (req, res) => {
      const reply = (status, title, text) => {
        res.writeHead(status, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
          'Referrer-Policy': 'no-referrer',
        });
        res.end(page(title, text));
      };
      let url;
      try {
        url = new URL(req.url || '/', 'http://127.0.0.1');
      } catch {
        reply(400, 'Not a sign-in', 'This address is only for the Cyber Rakshak command line.');
        return;
      }
      if (req.method !== 'GET' || url.pathname !== '/callback') {
        reply(404, 'Not found', 'This address is only for the Cyber Rakshak command line.');
        return;
      }
      if (done) {
        reply(200, 'Already done', 'This sign-in is finished. You can close this tab.');
        return;
      }
      // A visit that does not carry this sign-in's own state is not this sign-in's: it is ignored, and the wait goes on.
      if (!sameText(url.searchParams.get('state') || '', state)) {
        reply(400, 'This is not the sign-in the terminal started', 'Go back to the terminal, and start again there if you need to.');
        return;
      }
      done = true;
      clearTimeout(timer);
      if (url.searchParams.get('error')) {
        reply(200, 'Sign-in cancelled', 'You chose Deny. Nothing was signed in. You can close this tab.');
        resolve({ denied: true });
        return;
      }
      const code = url.searchParams.get('code') || '';
      reply(200, 'You are signed in', 'Go back to the terminal: the Cyber Rakshak command line is signed in. You can close this tab.');
      resolve({ code });
    });
  });
}

/** What the token answer says, as it is kept and shown. */
function signedIn(ctx, answer, method) {
  const user = answer.user || {};
  return {
    token: answer.access_token,
    user: { name: user.name || null, email: user.email || null },
    organization: answer.organization ? { name: answer.organization.name } : null,
    computer: computerName(),
    method,
    signed_in_at: new Date().toISOString(),
    expires_at: answer.expires_at || null,
    idle_days: answer.idle_days || null,
    read_only: Array.isArray(answer.abilities) && !answer.abilities.includes('monitoring:write'),
  };
}

function finish(ctx, entry, printToken) {
  const who = entry.user.email ? `${entry.user.name ? entry.user.name + ' ' : ''}<${entry.user.email}>` : entry.user.name || 'your account';
  const org = (entry.organization ? ` (organisation ${entry.organization.name})` : ' (no organisation)') + (entry.read_only ? ', read-only' : '');
  if (printToken) {
    // For CI: shown once, never saved here.
    if (ctx.json) {
      printJson(ctx, { signed_in: true, saved: false, token: entry.token, user: entry.user, organization: entry.organization, console: ctx.console, expires_at: entry.expires_at, read_only: entry.read_only });
    } else {
      note(ctx, `Signed in as ${who}${org}.`);
      note(ctx, 'The token is below, this once. It was not saved on this computer: put it in your CI or server as the secret CYBERRAKSHAK_TOKEN.');
      line(ctx, entry.token);
    }
    return;
  }
  saveSignIn(ctx.console, entry, ctx.env);
  if (ctx.json) {
    printJson(ctx, { signed_in: true, saved: true, user: entry.user, organization: entry.organization, console: ctx.console, expires_at: entry.expires_at, idle_days: entry.idle_days, read_only: entry.read_only });
    return;
  }
  line(ctx, `Signed in as ${who}${org}.`);
  if (entry.idle_days) line(ctx, `This sign-in ends if it is not used for ${entry.idle_days} days${entry.expires_at ? `, and on ${when(entry.expires_at)} at the latest` : ''}.`);
}

async function exchange(ctx, body) {
  const res = await call(ctx, 'POST', '/api/v1/cli/token', { body, auth: false, allow: [400] });
  return res;
}

export async function loginWithBrowser(ctx, { printToken = false, waitMs = LOGIN_WAIT_MS, readOnly = false } = {}) {
  const { verifier, challenge } = pkce();
  const state = b64url(randomBytes(16));
  const server = createServer();
  server.keepAliveTimeout = 1000;
  await new Promise((resolve, reject) => {
    server.once('error', (e) => reject(new CliError('failed', `Could not start the sign-in listener on this computer: ${e.message}. Try cyberrakshak login --no-browser.`, EXIT.FAILED)));
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  const redirectUri = `http://127.0.0.1:${port}/callback`;
  const url = `${ctx.console}/cli/auth?` + new URLSearchParams({
    port: String(port),
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    name: computerName(),
    ...(readOnly ? { scope: 'read' } : {}),
  }).toString();
  try {
    const opened = await (ctx.openBrowser || openBrowser)(url, ctx.env);
    note(ctx, opened ? 'Your browser is opening to sign in to Cyber Rakshak. If it does not, open this address:' : 'Open this address in your browser to sign in to Cyber Rakshak:');
    note(ctx, '  ' + url);
    note(ctx, `Waiting for you to press Allow (up to ${Math.round(waitMs / 60000)} minutes; Ctrl+C to stop). No browser here? Use: cyberrakshak login --no-browser`);
    const back = await waitForCallback(server, state, waitMs);
    if (back.denied) throw new CliError('denied', 'You chose Deny in the browser. Nothing was signed in.', EXIT.SIGNED_OUT);
    const res = await exchange(ctx, { grant_type: 'authorization_code', code: back.code, code_verifier: verifier, redirect_uri: redirectUri });
    if (res.status !== 200 || !res.json || !res.json.access_token) {
      const error = res.json && res.json.error;
      throw new CliError('failed', error === 'invalid_grant'
        ? 'The sign-in code was not accepted (it is used once, within a minute). Run cyberrakshak login again.'
        : 'The console did not finish the sign-in. Run cyberrakshak login again.', EXIT.SIGNED_OUT);
    }
    finish(ctx, signedIn(ctx, res.json, 'browser'), printToken);
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function loginWithCode(ctx, { printToken = false, sleepFn = sleep, readOnly = false } = {}) {
  const res = await call(ctx, 'POST', '/api/v1/cli/device', { body: { name: computerName(), ...(readOnly ? { scope: 'read' } : {}) }, auth: false });
  const d = res.json || {};
  if (!d.device_code || !d.user_code || !d.verification_uri) throw new CliError('failed', 'The console did not give a sign-in code. Try again in a minute.', EXIT.OFFLINE);
  const expiresMs = Math.min(DEVICE_WAIT_MAX_MS, Math.max(1, Number(d.expires_in) || 600) * 1000);
  let interval = Math.max(1, Number(d.interval) || 5) * 1000;
  note(ctx, 'To sign in, open this page on any phone or computer:');
  note(ctx, '  ' + d.verification_uri);
  note(ctx, 'and enter the code:');
  note(ctx, '  ' + d.user_code);
  if (d.verification_uri_complete) note(ctx, `(or open ${d.verification_uri_complete})`);
  note(ctx, `Check that the page names this computer (${computerName()}) before you press Allow. The code expires in ${Math.round(expiresMs / 60000)} minutes; Ctrl+C to stop.`);
  const deadline = Date.now() + expiresMs;
  let offlineInARow = 0;
  for (;;) {
    await sleepFn(interval);
    if (Date.now() > deadline) throw new CliError('expired', 'The code expired before it was approved. Run cyberrakshak login --no-browser again.', EXIT.SIGNED_OUT);
    let answer;
    try {
      answer = await exchange(ctx, { grant_type: DEVICE_GRANT, device_code: d.device_code });
      offlineInARow = 0;
    } catch (e) {
      // A short loss of connection while waiting is not the end; three in a row is.
      if (e instanceof CliError && e.code === 'offline' && ++offlineInARow < 3) continue;
      throw e;
    }
    if (answer.status === 200 && answer.json && answer.json.access_token) {
      finish(ctx, signedIn(ctx, answer.json, 'code'), printToken);
      return;
    }
    const error = answer.json && answer.json.error;
    if (error === 'authorization_pending') continue;
    if (error === 'slow_down') {
      interval += 5000;
      continue;
    }
    if (error === 'expired_token') throw new CliError('expired', 'The code expired before it was approved. Run cyberrakshak login --no-browser again.', EXIT.SIGNED_OUT);
    if (error === 'access_denied') throw new CliError('denied', 'The sign-in was denied in the browser. Nothing was signed in.', EXIT.SIGNED_OUT);
    throw new CliError('failed', 'The console did not finish the sign-in. Run cyberrakshak login --no-browser again.', EXIT.SIGNED_OUT);
  }
}

export async function logout(ctx) {
  const current = currentToken(ctx.console, ctx.env);
  if (current === null) {
    if (ctx.json) printJson(ctx, { signed_out: false, reason: 'not_signed_in', console: ctx.console });
    else line(ctx, `You are not signed in to ${ctx.console}.`);
    return;
  }
  // First the console, then this computer: a sign-in that could not be ended there is kept here, so logout can be run
  // again (or it can be ended in the console). A 401 means it had already ended.
  try {
    await call(ctx, 'DELETE', '/api/v1/cli/token', { allow: [401] });
  } catch (e) {
    if (e instanceof CliError && (e.code === 'offline' || e.code === 'console_error')) {
      throw new CliError(e.code, `${e.message} You are still signed in: run cyberrakshak logout again when the console can be reached, or end the sign-in in the console (Sign-in & two-factor → Command line).`, e.exit);
    }
    throw e;
  }
  const forgotten = current.source === 'file' ? forgetSignIn(ctx.console, ctx.env) : false;
  if (ctx.json) {
    printJson(ctx, { signed_out: true, revoked: true, forgotten, console: ctx.console, from_environment: current.source === 'env' });
    return;
  }
  if (current.source === 'env') {
    line(ctx, 'Signed out: the sign-in no longer works anywhere. It came from CYBERRAKSHAK_TOKEN: remove that from your environment too.');
  } else {
    line(ctx, 'Signed out: the sign-in no longer works anywhere, and it was removed from this computer.');
  }
}

export async function whoami(ctx) {
  const res = await call(ctx, 'GET', '/api/v1/cli/me');
  const me = res.json || {};
  if (ctx.json) {
    printJson(ctx, { console: ctx.console, ...me });
    return;
  }
  const user = me.user || {};
  line(ctx, `Signed in to ${ctx.console} as ${user.name ? user.name + ' ' : ''}<${user.email}>${me.organization ? ` (organisation ${me.organization.name})` : ' (no organisation)'}.`);
  const can = me.can || {};
  const yes = [];
  if (can.monitoring) yes.push('error monitoring for your websites (sites, keys, init, test, errors)');
  if (can.laptops) yes.push("your company's laptops and security events (laptops, alerts)");
  if (can.servers) yes.push('servers (servers)');
  line(ctx, yes.length ? `Available on your account: ${yes.join('; ')}.` : 'Your account has no monitoring, company laptops or servers for the command line to show yet.');
  const s = me.sign_in || {};
  if (s.computer) line(ctx, `This sign-in: ${s.computer}${s.read_only ? ', read-only (it cannot make app keys)' : ''}, since ${when(s.created_at)}${s.idle_days ? `; it ends after ${s.idle_days} days unused` : ''}${s.expires_at ? ` and on ${when(s.expires_at)} at the latest` : ''}.`);
}
