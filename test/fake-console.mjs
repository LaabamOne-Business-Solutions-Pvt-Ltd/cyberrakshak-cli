// A stand-in for the Cyber Rakshak console's command-line API, for the tests: the sign-in flows (browser + PKCE, and
// the device code), /api/v1/cli/*, /api/v1/app-reports and /sdk/. It only ever listens on 127.0.0.1; no test talks to
// a real Cyber Rakshak host. Tests change `fake.state` to make it answer what they need.
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const S256 = (verifier) => b64url(createHash('sha256').update(verifier).digest());

export const SDK_FILES = {
  'node/cyberrakshak-monitor.mjs': '// Cyber Rakshak monitor (test copy, ES module)\nexport function init() {}\n',
  'node/cyberrakshak-monitor.cjs': '// Cyber Rakshak monitor (test copy, CommonJS)\nexports.init = function init() {};\n',
  'react-native/cyberrakshak-monitor.ts': '// test copy\nexport function init(): void {}\n',
  'php/CyberRakshakMonitor.php.txt': "<?php // test copy\n",
  'python/cyberrakshak_monitor.py': '# test copy\ndef init(**kw):\n    pass\n',
  'shell/cr-report.sh': '#!/bin/sh\n# test copy\n',
  'android/CyberRakshakMonitor.kt': '// test copy\n',
  'ios/CyberRakshakMonitor.swift': '// test copy\n',
};

function sdkIndex(files) {
  return {
    version: '1.0.0',
    files: Object.entries(files).map(([path, body]) => ({
      platform: path.split('/')[0],
      path: '/sdk/' + path,
      save_as: path.split('/').pop().replace(/\.php\.txt$/, '.php'),
      sha256: createHash('sha256').update(body).digest('hex'),
      bytes: Buffer.byteLength(body),
    })),
  };
}

export const KEY = 'crk_' + 'A1b2C3d4'.repeat(4);

export function freshState() {
  return {
    user: { name: 'Asha Rao', email: 'asha@example.invalid' },
    organization: { name: 'Example Traders' },
    can: { monitoring: true, laptops: true, servers: false },
    tokens: new Map(), // token -> { revoked: false }
    codes: new Map(), // code -> { challenge, redirect_uri, used }
    devices: new Map(), // device_code -> { answers: [...], polls: 0 }
    deviceAnswers: ['authorization_pending', 'approve'],
    lastAuth: null,
    refuse: null, // { status, json } for every /api/v1/cli/* call with a token
    delayMs: 0,
    sites: [
      { id: '11111111-1111-4111-8111-111111111111', host: 'example.com', url: 'https://example.com', name: null, verified: true, score: 92, last_scanned_at: new Date().toISOString(),
        monitoring: { on: true, open: 2, new_today: 1, last_report_at: null, app_key: { on: true, masked: 'crk_••••' + KEY.slice(-4), hint: KEY.slice(-4), made_at: '2026-11-20T10:00:00+00:00' } } },
      { id: '22222222-2222-4222-8222-222222222222', host: 'shop.example.org', url: 'https://shop.example.org', name: null, verified: false, score: null, last_scanned_at: null,
        monitoring: { on: false, open: 0, new_today: 0, last_report_at: null, app_key: { on: false, masked: null, hint: null, made_at: null } } },
    ],
    monitoring: true,
    madeKeys: [],
    problems: [
      { id: 7, kind: 'exception', platform: 'Server', level: 'error', title: 'TypeError: cannot read properties of undefined', occurrences: 12, day_count: 3, last_page: null, first_seen_at: '2026-11-19T10:00:00+00:00', last_seen_at: new Date().toISOString(), reopened: false },
    ],
    reports: [],
    reportStatus: 204,
    laptops: { status: 200, json: { devices: [
      { id: 'd1', hostname: 'LAPTOP-01', display_name: 'Front desk', person: { id: 'p1', name: 'Ravi' }, online: true, risk: 'critical', open_threats: 1, issue_count: 2, top_issue: 'A threat was found', last_seen_at: new Date().toISOString(), app_version: '0.3.37', update_available: true },
      { id: 'd2', hostname: 'LAPTOP-02', display_name: null, person: null, online: false, risk: 'secure', open_threats: 0, issue_count: 0, top_issue: null, last_seen_at: '2026-11-18T10:00:00+00:00', app_version: '0.3.38', update_available: false },
    ], filters: {} } },
    alerts: { status: 200, json: { filters: {}, feed: { rows: [
      { kind: 'threat', title: 'Threat found', name: 'EICAR-Test-File', severity: 'high', first_at: '2026-11-21T08:00:00+00:00', last_at: new Date().toISOString(), count: 2, device: { id: 'd1', hostname: 'LAPTOP-01', display_name: 'Front desk', person: 'Ravi' } },
    ], pagination: { page: 1, pages: 1, rows: 1, per: 100 } } } },
    servers: { status: 404, json: { message: 'Not Found' } },
    serverAlerts: { status: 404, json: { message: 'Not Found' } },
    sdkFiles: { ...SDK_FILES },
    sdkTamper: null, // a path whose bytes are changed after index.json was made
    calls: [],
  };
}

export async function startFakeConsole() {
  const fake = { state: freshState() };
  const json = (res, status, body, headers = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
    res.end(body === undefined ? '' : JSON.stringify(body));
  };
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      setTimeout(() => handle(req, res, Buffer.concat(chunks)), fake.state.delayMs);
    });
  });
  const tokenOf = (req) => {
    const m = String(req.headers.authorization || '').match(/^Bearer (.+)$/);
    return m ? m[1] : null;
  };
  const issue = (readOnly = false) => {
    const token = '42|' + b64url(randomBytes(30));
    fake.state.tokens.set(token, { revoked: false, readOnly });
    const abilities = readOnly ? ['monitoring:read', 'security:read'] : ['monitoring:read', 'monitoring:write', 'security:read'];
    return { access_token: token, token_type: 'Bearer', expires_at: '2027-11-21T00:00:00+00:00', idle_days: 30, abilities, user: fake.state.user, organization: fake.state.organization };
  };

  function handle(req, res, raw) {
    const url = new URL(req.url, 'http://127.0.0.1');
    const path = url.pathname;
    const s = fake.state;
    let body = null;
    try {
      body = raw.length ? JSON.parse(raw.toString('utf8')) : null;
    } catch {
      body = null;
    }
    s.calls.push({ method: req.method, path, query: Object.fromEntries(url.searchParams), headers: req.headers, body });

    // The browser's page: what /cli/auth does once the person pressed Allow (or Deny), straight away.
    if (req.method === 'GET' && path === '/cli/auth') {
      const q = Object.fromEntries(url.searchParams);
      s.lastAuth = q;
      const port = Number(q.port);
      if (!(port >= 1024 && port <= 65535) || q.code_challenge_method !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(q.code_challenge || '') || !['read', undefined].includes(q.scope)) {
        json(res, 400, { message: 'bad request' });
        return;
      }
      const redirect = `http://127.0.0.1:${port}/callback`;
      if (s.browserAnswer === 'deny') {
        res.writeHead(302, { Location: `${redirect}?error=access_denied&state=${encodeURIComponent(q.state)}` });
        res.end();
        return;
      }
      const code = b64url(randomBytes(32));
      s.codes.set(code, { challenge: q.code_challenge, redirect_uri: redirect, used: false, readOnly: q.scope === 'read' });
      res.writeHead(302, { Location: `${redirect}?code=${code}&state=${encodeURIComponent(s.browserAnswer === 'wrong-state' ? 'not-the-state' : q.state)}` });
      res.end();
      return;
    }

    if (req.method === 'POST' && path === '/api/v1/cli/token') {
      if (body && body.grant_type === 'authorization_code') {
        const c = s.codes.get(body.code);
        if (!c || c.used || s.rejectCode || S256(String(body.code_verifier)) !== c.challenge || body.redirect_uri !== c.redirect_uri) {
          json(res, 400, { error: 'invalid_grant' });
          return;
        }
        c.used = true;
        json(res, 200, issue(c.readOnly));
        return;
      }
      if (body && body.grant_type === 'urn:ietf:params:oauth:grant-type:device_code') {
        const d = s.devices.get(body.device_code);
        if (!d) {
          json(res, 400, { error: 'invalid_grant' });
          return;
        }
        const answer = d.answers[Math.min(d.polls++, d.answers.length - 1)];
        if (answer === 'approve') {
          json(res, 200, issue(d.readOnly));
          return;
        }
        json(res, 400, { error: answer });
        return;
      }
      json(res, 400, { error: 'unsupported_grant_type' });
      return;
    }

    if (req.method === 'POST' && path === '/api/v1/cli/device') {
      const code = b64url(randomBytes(32));
      s.devices.set(code, { answers: [...s.deviceAnswers], polls: 0, name: body && body.name, readOnly: !!body && body.scope === 'read' });
      json(res, 200, { device_code: code, user_code: 'BCDF-GHJK', verification_uri: `http://127.0.0.1:${server.address().port}/cli/activate`, verification_uri_complete: `http://127.0.0.1:${server.address().port}/cli/activate?code=BCDF-GHJK`, expires_in: s.deviceExpiresIn || 600, interval: 5 });
      return;
    }

    if (req.method === 'POST' && path === '/api/v1/app-reports') {
      s.reports.push({ headers: req.headers, body });
      if (s.reportStatus === 204) {
        const m = String(req.headers.authorization || '').match(/^Bearer (crk_[A-Za-z0-9]{32})$/);
        if (m && body && Array.isArray(body.errors)) {
          for (const e of body.errors) {
            const title = String(e.message).split('\n')[0];
            const hit = s.problems.find((p) => p.title === title);
            if (hit) {
              hit.occurrences += 1;
              hit.last_seen_at = new Date().toISOString();
            } else if (!s.dropReports) {
              s.problems.unshift({ id: s.problems.length + 100, kind: e.kind, platform: 'Script', level: e.level || 'error', title, occurrences: 1, day_count: 1, last_page: null, first_seen_at: new Date().toISOString(), last_seen_at: new Date().toISOString(), reopened: false });
            }
          }
        }
      }
      res.writeHead(s.reportStatus);
      res.end();
      return;
    }

    if (req.method === 'GET' && path === '/sdk/index.json') {
      const index = sdkIndex(s.sdkFiles);
      json(res, 200, index);
      return;
    }
    if (req.method === 'GET' && path.startsWith('/sdk/')) {
      const rel = path.slice(5);
      if (!(rel in s.sdkFiles)) {
        json(res, 404, { message: 'Not Found' });
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(s.sdkTamper === rel ? s.sdkFiles[rel] + '// changed on the way\n' : s.sdkFiles[rel]);
      return;
    }

    if (path.startsWith('/api/v1/cli/')) {
      const token = tokenOf(req);
      const known = token && s.tokens.get(token);
      if (!known || known.revoked) {
        json(res, 401, { message: 'Unauthenticated.', reason: s.reason || 'unknown', idle_days: 30 });
        return;
      }
      if (s.refuse) {
        json(res, s.refuse.status, s.refuse.json, s.refuse.headers || {});
        return;
      }
      if (req.method === 'GET' && path === '/api/v1/cli/me') {
        json(res, 200, { user: s.user, organization: s.organization, can: s.can, sign_in: { computer: 'TEST-PC', read_only: !!known.readOnly, created_at: '2026-11-21T09:00:00+00:00', last_used_at: new Date().toISOString(), expires_at: '2027-11-21T00:00:00+00:00', idle_days: 30 } });
        return;
      }
      if (req.method === 'DELETE' && path === '/api/v1/cli/token') {
        known.revoked = true;
        res.writeHead(204);
        res.end();
        return;
      }
      if (req.method === 'GET' && path === '/api/v1/cli/sites') {
        json(res, 200, { monitoring: s.monitoring, sites: s.sites.map((x) => ({ ...x, monitoring: s.monitoring ? x.monitoring : null })) });
        return;
      }
      const m = path.match(/^\/api\/v1\/cli\/sites\/([^/]+)\/(app-key|errors)$/);
      if (m) {
        const site = s.sites.find((x) => x.id === decodeURIComponent(m[1]));
        if (!site || !s.monitoring) {
          json(res, 404, { message: 'Not Found' });
          return;
        }
        if (m[2] === 'app-key' && req.method === 'POST' && known.readOnly) {
          json(res, 403, { message: 'This sign-in is read-only: making an app key needs a full sign-in. Run cyberrakshak login (without --read-only).' });
          return;
        }
        if (m[2] === 'app-key' && req.method === 'POST') {
          if (site.monitoring.app_key.on && !(body && body.replace)) {
            json(res, 409, { message: 'This site already has an app key.', masked: site.monitoring.app_key.masked });
            return;
          }
          const key = 'crk_' + b64url(randomBytes(24)).replace(/[-_]/g, 'x').slice(0, 32);
          const replaced = site.monitoring.app_key.on;
          site.monitoring.app_key = { on: true, masked: 'crk_••••' + key.slice(-4), hint: key.slice(-4), made_at: new Date().toISOString() };
          s.madeKeys.push(key);
          json(res, 201, { key, masked: site.monitoring.app_key.masked, made_at: site.monitoring.app_key.made_at, replaced });
          return;
        }
        if (m[2] === 'errors' && req.method === 'GET') {
          const status = url.searchParams.get('status') === 'resolved' ? 'resolved' : 'open';
          const platform = url.searchParams.get('platform');
          const list = status === 'open' ? s.problems.filter((p) => !platform || p.platform.toLowerCase() === platform) : [];
          json(res, 200, { site: { id: site.id, host: site.host, verified: site.verified, monitoring: site.monitoring.on }, status, platform, stats: { open: s.problems.length, resolved: 0, day: 3, new: 1 }, problems: list, pagination: { page: 1, pages: 1, total: list.length } });
          return;
        }
      }
      const security = { '/api/v1/cli/laptops': s.laptops, '/api/v1/cli/alerts': s.alerts, '/api/v1/cli/servers': s.servers, '/api/v1/cli/servers/alerts': s.serverAlerts };
      if (req.method === 'GET' && security[path]) {
        json(res, security[path].status, security[path].json);
        return;
      }
    }
    json(res, 404, { message: 'Not Found' });
  }

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  fake.url = `http://127.0.0.1:${server.address().port}`;
  fake.reset = () => {
    fake.state = freshState();
  };
  fake.close = () => new Promise((r) => {
    server.closeAllConnections?.();
    server.close(() => r());
  });
  return fake;
}
