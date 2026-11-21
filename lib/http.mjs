// Every request the command line makes: Node's own http and https (no dependencies, and no experimental-fetch warning
// on Node 18), each with an end. A request that has not finished in TIMEOUT_MS is abandoned and reported as the console
// not answering: nothing here may hang.
import http from 'node:http';
import https from 'node:https';
import { VERSION } from './version.mjs';

/** The longest any one request may take, start to finish. */
export const TIMEOUT_MS = 15000;

/** Bigger answers are refused: nothing the console sends the command line comes near it (the libraries are ~50 KB). */
const MAX_BODY = 8 * 1024 * 1024;

export const USER_AGENT = `cyberrakshak-cli/${VERSION} (node ${process.versions.node}; ${process.platform})`;

/** The console could not be reached, or did not answer in time. */
export class Offline extends Error {
  constructor(url, reason) {
    super(reason);
    this.name = 'Offline';
    this.url = url;
    this.reason = reason;
  }
}

/**
 * One request. Resolves to { status, headers, body (Buffer), json (parsed, or null) } for any HTTP answer, 4xx and 5xx
 * included; rejects with Offline when there is no answer.
 *
 * @param {string} url
 * @param {{method?: string, headers?: Record<string, string>, body?: string|Buffer|object, timeoutMs?: number}} [options]
 */
export function request(url, options = {}) {
  const { method = 'GET', headers = {}, timeoutMs = TIMEOUT_MS } = options;
  let { body } = options;
  let target;
  try {
    target = new URL(url);
  } catch {
    return Promise.reject(new Offline(url, 'the address is not a web address'));
  }
  const send = { 'User-Agent': USER_AGENT, Accept: 'application/json', ...headers };
  if (body !== undefined && body !== null && !Buffer.isBuffer(body) && typeof body !== 'string') {
    body = JSON.stringify(body);
    send['Content-Type'] = send['Content-Type'] || 'application/json';
  }
  if (body !== undefined && body !== null) send['Content-Length'] = String(Buffer.byteLength(body));
  const client = target.protocol === 'https:' ? https : target.protocol === 'http:' ? http : null;
  if (client === null) return Promise.reject(new Offline(url, 'only http and https addresses can be used'));

  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    // agent: false: one connection per request, closed after it, so no kept-alive socket holds the process open.
    const req = client.request(target, { method, headers: send, agent: false }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY) {
          req.destroy();
          finish(reject, new Offline(url, 'the answer was too large'));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        let json = null;
        if (/json/i.test(String(res.headers['content-type'] || '')) && buffer.length > 0) {
          try {
            json = JSON.parse(buffer.toString('utf8'));
          } catch {
            json = null;
          }
        }
        finish(resolve, { status: res.statusCode || 0, headers: res.headers, body: buffer, json });
      });
      res.on('error', (e) => finish(reject, new Offline(url, e.message)));
    });
    timer = setTimeout(() => {
      req.destroy();
      finish(reject, new Offline(url, `no answer in ${Math.round(timeoutMs / 1000)} seconds`));
    }, timeoutMs);
    req.on('error', (e) => finish(reject, new Offline(url, describe(e))));
    if (body !== undefined && body !== null) req.write(body);
    req.end();
  });
}

/** A connection failure in words. */
function describe(error) {
  switch (error && error.code) {
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return 'the address could not be found (no internet connection, or a wrong address)';
    case 'ECONNREFUSED':
      return 'the connection was refused';
    case 'ECONNRESET':
      return 'the connection was dropped';
    case 'ETIMEDOUT':
      return 'the connection timed out';
    case 'CERT_HAS_EXPIRED':
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
    case 'SELF_SIGNED_CERT_IN_CHAIN':
    case 'ERR_TLS_CERT_ALTNAME_INVALID':
      return "the site's certificate could not be trusted";
    default:
      return (error && error.message) || 'the connection failed';
  }
}
