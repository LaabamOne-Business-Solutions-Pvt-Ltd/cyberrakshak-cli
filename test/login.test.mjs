// Signing in and out against the fake console: the browser flow (loopback + PKCE), the device code, whoami, logout,
// and every way a sign-in ends.
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { startFakeConsole } from './fake-console.mjs';
import { cli, fakeBrowser, get, scratch } from './helpers.mjs';

let fake;
let dir;
before(async () => {
  fake = await startFakeConsole();
});
after(async () => {
  await fake.close();
});
beforeEach(() => {
  fake.reset();
  dir = scratch();
});

const saved = () => JSON.parse(readFileSync(join(dir, 'credentials.json'), 'utf8')).consoles[fake.url];

test('login: the browser flow signs in, with PKCE S256, the state checked, and the token saved for the user only', async () => {
  const seen = {};
  const r = await cli(['login'], { fake, configDir: dir, openBrowser: fakeBrowser(seen) });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /Signed in as Asha Rao <asha@example\.invalid> \(organisation Example Traders\)\./);
  // What the console was asked.
  const q = fake.state.lastAuth;
  assert.equal(q.code_challenge_method, 'S256');
  assert.match(q.code_challenge, /^[A-Za-z0-9_-]{43}$/);
  assert.match(q.state, /^[A-Za-z0-9_-]{22}$/);
  assert.ok(Number(q.port) >= 1024);
  assert.ok(q.name && q.name.length <= 60);
  assert.match(seen.url, new RegExp('^' + fake.url.replace(/[.]/g, '\\.') + '/cli/auth\\?'));
  assert.equal(seen.callbackStatus, 200);
  assert.match(seen.callbackBody, /You are signed in/);
  // The exchange: the code with the verifier, to the same redirect_uri.
  const ex = fake.state.calls.find((c) => c.path === '/api/v1/cli/token');
  assert.equal(ex.body.grant_type, 'authorization_code');
  assert.match(ex.body.code_verifier, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(ex.body.redirect_uri, `http://127.0.0.1:${q.port}/callback`);
  assert.equal(ex.headers.authorization, undefined);
  // Saved, and only the user may read it.
  const entry = saved();
  assert.ok(fake.state.tokens.has(entry.token));
  assert.equal(entry.user.email, 'asha@example.invalid');
  assert.equal(entry.method, 'browser');
  if (process.platform !== 'win32') assert.equal(statSync(join(dir, 'credentials.json')).mode & 0o777, 0o600);
  // The token is never printed.
  assert.ok(!r.out.includes(entry.token) && !r.err.includes(entry.token));
  // The address to open is always printed, in case the browser did not open.
  assert.match(r.err, /\/cli\/auth\?port=/);
});

test('login: a visit to the listener with another state is ignored, and the real one still signs in', async () => {
  const seen = {};
  const stray = async (url) => {
    const port = new URL(url).searchParams.get('port');
    const res = await get(`http://127.0.0.1:${port}/callback?code=stolen&state=someone-elses`);
    seen.strayStatus = res.status;
    seen.strayBody = res.body;
    const other = await get(`http://127.0.0.1:${port}/elsewhere`);
    seen.otherStatus = other.status;
  };
  const r = await cli(['login'], { fake, configDir: dir, openBrowser: fakeBrowser(seen, stray) });
  assert.equal(r.code, 0, r.err);
  assert.equal(seen.strayStatus, 400);
  assert.match(seen.strayBody, /not the sign-in the terminal started/);
  assert.equal(seen.otherStatus, 404);
  // The stray code was never exchanged.
  assert.ok(!fake.state.calls.some((c) => c.path === '/api/v1/cli/token' && c.body.code === 'stolen'));
});

test('login: a callback whose state does not match is never exchanged, and the wait ends with a message', async () => {
  fake.state.browserAnswer = 'wrong-state';
  const r = await cli(['login'], { fake, configDir: dir, openBrowser: fakeBrowser({}), loginWaitMs: 600 });
  assert.equal(r.code, 3);
  assert.match(r.err, /No answer from the browser/);
  assert.ok(!fake.state.calls.some((c) => c.path === '/api/v1/cli/token'));
  assert.ok(!existsSync(join(dir, 'credentials.json')));
});

test('login: Deny in the browser signs nothing in', async () => {
  fake.state.browserAnswer = 'deny';
  const seen = {};
  const r = await cli(['login'], { fake, configDir: dir, openBrowser: fakeBrowser(seen) });
  assert.equal(r.code, 3);
  assert.match(r.err, /You chose Deny/);
  for (let i = 0; i < 50 && seen.callbackBody === undefined; i++) await new Promise((res) => setTimeout(res, 20));
  assert.match(seen.callbackBody, /Sign-in cancelled/);
  assert.ok(!existsSync(join(dir, 'credentials.json')));
});

test('login: a code the console refuses (used, expired, wrong verifier) is said plainly', async () => {
  fake.state.rejectCode = true;
  const r = await cli(['login'], { fake, configDir: dir, openBrowser: fakeBrowser({}) });
  assert.equal(r.code, 3);
  assert.match(r.err, /sign-in code was not accepted/);
  assert.ok(!existsSync(join(dir, 'credentials.json')));
});

test('login: no browser and nobody coming back ends after the wait, with the way forward', async () => {
  const r = await cli(['login'], { fake, configDir: dir, loginWaitMs: 300 });
  assert.equal(r.code, 3);
  assert.match(r.err, /Open this address in your browser/);
  assert.match(r.err, /No answer from the browser .*--no-browser/s);
});

test('login: --json prints one document and nothing else on standard output', async () => {
  const r = await cli(['login', '--json'], { fake, configDir: dir, openBrowser: fakeBrowser({}) });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.json.signed_in, true);
  assert.equal(r.json.saved, true);
  assert.equal(r.json.user.email, 'asha@example.invalid');
  assert.equal(r.json.token, undefined);
});

test('login --no-browser: the device code, through pending and slow_down, signs in; the wait grows by 5 s on slow_down', async () => {
  fake.state.deviceAnswers = ['authorization_pending', 'slow_down', 'authorization_pending', 'approve'];
  const waits = [];
  const r = await cli(['login', '--no-browser'], { fake, configDir: dir, sleep: async (ms) => waits.push(ms) });
  assert.equal(r.code, 0, r.err);
  assert.match(r.err, /\/cli\/activate/);
  assert.match(r.err, /BCDF-GHJK/);
  assert.match(r.err, /expires in 10 minutes/);
  assert.deepEqual(waits, [5000, 5000, 10000, 10000]);
  assert.match(r.out, /Signed in as Asha Rao/);
  assert.equal(saved().method, 'code');
  const asked = fake.state.calls.find((c) => c.path === '/api/v1/cli/device');
  assert.ok(asked.body.name);
});

test('login --no-browser: denied, and expired, each end with their own message', async () => {
  fake.state.deviceAnswers = ['authorization_pending', 'access_denied'];
  let r = await cli(['login', '--no-browser'], { fake, configDir: dir });
  assert.equal(r.code, 3);
  assert.match(r.err, /denied in the browser/);
  fake.state.deviceAnswers = ['expired_token'];
  r = await cli(['login', '--no-browser', '--json'], { fake, configDir: dir });
  assert.equal(r.code, 3);
  assert.equal(r.json.error.code, 'expired');
  assert.match(r.json.error.message, /code expired/);
  assert.ok(!existsSync(join(dir, 'credentials.json')));
});

test('login --no-browser: the local wait ends with the code even if the console keeps saying pending', async () => {
  fake.state.deviceAnswers = ['authorization_pending'];
  fake.state.deviceExpiresIn = 1;
  let clock = 0;
  const realNow = Date.now;
  Date.now = () => realNow() + clock;
  try {
    const r = await cli(['login', '--no-browser'], { fake, configDir: dir, sleep: async (ms) => { clock += ms; } });
    assert.equal(r.code, 3);
    assert.match(r.err, /code expired before it was approved/);
  } finally {
    Date.now = realNow;
  }
});

test('login --read-only: both flows ask for it, and the sign-in says so', async () => {
  const seen = {};
  let r = await cli(['login', '--read-only'], { fake, configDir: dir, openBrowser: fakeBrowser(seen) });
  assert.equal(r.code, 0, r.err);
  assert.equal(fake.state.lastAuth.scope, 'read');
  assert.match(r.out, /\(organisation Example Traders\), read-only\./);
  assert.equal(saved().read_only, true);
  r = await cli(['whoami'], { fake, configDir: dir });
  assert.match(r.out, /read-only \(it cannot make app keys\)/);
  r = await cli(['login', '--no-browser', '--read-only', '--json'], { fake, configDir: dir });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.json.read_only, true);
  assert.equal(fake.state.calls.find((c) => c.path === '/api/v1/cli/device').body.scope, 'read');
  // Without it: a full sign-in, and nothing asks for a scope.
  r = await cli(['login', '--no-browser', '--json'], { fake, configDir: dir });
  assert.equal(r.json.read_only, false);
  assert.equal(fake.state.calls.filter((c) => c.path === '/api/v1/cli/device').pop().body.scope, undefined);
  r = await cli(['login'], { fake, configDir: dir, openBrowser: fakeBrowser({}) });
  assert.equal(fake.state.lastAuth.scope, undefined);
});

test('login --print-token: the token is printed once and not saved', async () => {
  const r = await cli(['login', '--no-browser', '--print-token'], { fake, configDir: dir });
  assert.equal(r.code, 0, r.err);
  const token = r.out.trim();
  assert.ok(fake.state.tokens.has(token));
  assert.match(r.err, /CYBERRAKSHAK_TOKEN/);
  assert.ok(!existsSync(join(dir, 'credentials.json')));
});

async function signIn() {
  const r = await cli(['login', '--no-browser'], { fake, configDir: dir });
  assert.equal(r.code, 0, r.err);
  return saved().token;
}

test('whoami: who, the organisation, and what the account has; --json too', async () => {
  await signIn();
  let r = await cli(['whoami'], { fake, configDir: dir });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /Signed in to http:\/\/127\.0\.0\.1:\d+ as Asha Rao <asha@example\.invalid> \(organisation Example Traders\)/);
  assert.match(r.out, /error monitoring/);
  assert.match(r.out, /laptops/);
  assert.doesNotMatch(r.out, /servers \(servers\)/);
  r = await cli(['whoami', '--json'], { fake, configDir: dir });
  assert.equal(r.json.user.email, 'asha@example.invalid');
  assert.equal(r.json.can.servers, false);
  const call = fake.state.calls.filter((c) => c.path === '/api/v1/cli/me').pop();
  assert.match(call.headers.authorization, /^Bearer 42\|/);
  assert.match(call.headers['user-agent'], /^cyberrakshak-cli\/1\.0\.0 /);
});

test('not signed in, signed out, unused too long: each says so and ends with exit code 3', async () => {
  let r = await cli(['whoami'], { fake, configDir: dir });
  assert.equal(r.code, 3);
  assert.match(r.err, /You are not signed in to .* Run: cyberrakshak login/);
  assert.ok(!fake.state.calls.length, 'nothing is asked of the console without a sign-in');
  const token = await signIn();
  fake.state.tokens.get(token).revoked = true;
  r = await cli(['sites'], { fake, configDir: dir });
  assert.equal(r.code, 3);
  assert.match(r.err, /has ended: it was signed out/);
  fake.state.reason = 'idle';
  r = await cli(['sites', '--json'], { fake, configDir: dir });
  assert.equal(r.code, 3);
  assert.equal(r.json.error.code, 'signed_out');
  assert.match(r.json.error.message, /not used for 30 days/);
});

test('CYBERRAKSHAK_TOKEN is used instead of the saved sign-in', async () => {
  const token = await signIn();
  const other = '43|from-the-environment';
  fake.state.tokens.set(other, { revoked: false });
  const r = await cli(['whoami'], { fake, configDir: dir, env: { CYBERRAKSHAK_TOKEN: other } });
  assert.equal(r.code, 0, r.err);
  const call = fake.state.calls.filter((c) => c.path === '/api/v1/cli/me').pop();
  assert.equal(call.headers.authorization, 'Bearer ' + other);
  assert.notEqual(other, token);
  fake.state.tokens.get(other).revoked = true;
  const ended = await cli(['whoami'], { fake, configDir: dir, env: { CYBERRAKSHAK_TOKEN: other } });
  assert.equal(ended.code, 3);
  assert.match(ended.err, /\(the token in CYBERRAKSHAK_TOKEN\)/);
});

test('logout: ends the sign-in on the console first, then removes it here', async () => {
  const token = await signIn();
  const r = await cli(['logout'], { fake, configDir: dir });
  assert.equal(r.code, 0, r.err);
  assert.equal(fake.state.tokens.get(token).revoked, true);
  assert.ok(!existsSync(join(dir, 'credentials.json')));
  assert.match(r.out, /Signed out/);
  const again = await cli(['logout'], { fake, configDir: dir });
  assert.equal(again.code, 0);
  assert.match(again.out, /not signed in/);
});

test('logout: when the console cannot be reached, the sign-in is kept here and the person is told', async () => {
  await signIn();
  const r = await cli(['logout'], { configDir: dir, env: { CYBERRAKSHAK_CONSOLE: 'http://127.0.0.1:9' } });
  assert.equal(r.code, 0, 'not signed in to that console: nothing to do');
  assert.match(r.out, /not signed in to http:\/\/127\.0\.0\.1:9/);
  const elsewhere = await cli(['logout', '--console', fake.url], { configDir: dir, env: { CYBERRAKSHAK_CONSOLE: 'http://127.0.0.1:9' } });
  assert.equal(elsewhere.code, 0, elsewhere.err);
  await signIn();
  fake.state.delayMs = 400;
  const slow = await cli(['logout'], { fake, configDir: dir, timeoutMs: 100 });
  assert.equal(slow.code, 5);
  assert.match(slow.err, /no answer in/);
  assert.match(slow.err, /still signed in/);
  assert.ok(existsSync(join(dir, 'credentials.json')));
});

test('one sign-in per console: signing in to another console keeps the first', async () => {
  await signIn();
  const other = await startFakeConsole();
  try {
    const r = await cli(['login', '--no-browser', '--console', other.url], { configDir: dir });
    assert.equal(r.code, 0, r.err);
    const all = JSON.parse(readFileSync(join(dir, 'credentials.json'), 'utf8')).consoles;
    assert.deepEqual(Object.keys(all).sort(), [fake.url, other.url].sort());
  } finally {
    await other.close();
  }
});
