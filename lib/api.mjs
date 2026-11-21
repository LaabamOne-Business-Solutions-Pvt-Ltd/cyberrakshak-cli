// Talking to the console's command-line API (/api/v1/cli/…) with the sign-in's token, and turning every answer that is
// not a success into a CliError a customer can act on.
import { CliError, EXIT } from './errors.mjs';
import { Offline, request } from './http.mjs';
import { currentToken } from './config.mjs';

/** Why the console refused a sign-in (its 401 `reason`), in words. */
const ENDED = {
  unknown: () => 'it was signed out (in the console, or with cyberrakshak logout)',
  idle: (j) => `it was not used for ${Number(j && j.idle_days) || 30} days`,
  expired: () => 'sign-ins last a year at the most',
  wrong_kind: () => 'this token is not a command-line sign-in',
  missing: () => 'no token was sent',
};

export function offline(ctx, e) {
  return new CliError(
    'offline',
    `Could not reach the Cyber Rakshak console at ${ctx.console}: ${e.reason}. Check your internet connection and try again.`,
    EXIT.OFFLINE,
  );
}

/** The token this command uses, or "not signed in". */
export function tokenFor(ctx) {
  const current = currentToken(ctx.console, ctx.env);
  if (current === null) {
    throw new CliError('not_signed_in', `You are not signed in to ${ctx.console}. Run: cyberrakshak login`, EXIT.SIGNED_OUT);
  }
  return current;
}

/**
 * A call to the console. `auth: false` for the sign-in steps, which have no token yet. Resolves to the answer for a
 * 2xx (and for the statuses listed in `allow`); throws a CliError for everything else.
 *
 * @param {object} ctx
 * @param {string} method
 * @param {string} path  e.g. /api/v1/cli/me
 * @param {{body?: object, query?: Record<string, string|undefined|null>, auth?: boolean, allow?: number[], what?: string}} [options]
 */
export async function call(ctx, method, path, options = {}) {
  const { body, query, auth = true, allow = [], what } = options;
  const qs = query ? new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined && v !== null && v !== '')).toString() : '';
  const url = ctx.console + path + (qs ? '?' + qs : '');
  const headers = {};
  let current = null;
  if (auth) {
    current = tokenFor(ctx);
    headers.Authorization = 'Bearer ' + current.token;
  }
  let res;
  try {
    res = await request(url, { method, headers, body, timeoutMs: ctx.timeoutMs });
  } catch (e) {
    if (e instanceof Offline) throw offline(ctx, e);
    throw e;
  }
  if ((res.status >= 200 && res.status < 300) || allow.includes(res.status)) return res;
  throw refusal(ctx, res, current, what);
}

/** The CliError for a refused answer. */
export function refusal(ctx, res, current, what) {
  const message = res.json && typeof res.json.message === 'string' ? res.json.message : null;
  if (res.status === 401) {
    const reason = res.json && typeof res.json.reason === 'string' ? res.json.reason : 'unknown';
    const fromEnv = current && current.source === 'env' ? ' (the token in CYBERRAKSHAK_TOKEN)' : '';
    return new CliError(
      'signed_out',
      `Your sign-in to ${ctx.console}${fromEnv} has ended: ${(ENDED[reason] || ENDED.unknown)(res.json)}. Run: cyberrakshak login`,
      EXIT.SIGNED_OUT,
    );
  }
  if (res.status === 403) {
    return new CliError('no_access', message && message !== 'This action is unauthorized.' ? message : `${what || 'This'} is not available on your account.`, EXIT.NO_ACCESS);
  }
  if (res.status === 404) {
    return new CliError('not_found', what ? `${what} is not available on your account, or was not found.` : 'Not found on your account.', EXIT.NO_ACCESS);
  }
  if (res.status === 429) {
    const wait = Number.parseInt(String(res.headers['retry-after'] || ''), 10);
    return new CliError('slow_down', `The console asked to slow down. Try again in ${Number.isFinite(wait) && wait > 0 ? wait + ' seconds' : 'a minute'}.`, EXIT.FAILED);
  }
  if (res.status === 422) {
    return new CliError('failed', message || 'The console could not use what was sent.', EXIT.FAILED);
  }
  if (res.status === 409) {
    return new CliError('failed', message || 'The console refused: it conflicts with what is there.', EXIT.FAILED);
  }
  if (res.status >= 500) {
    return new CliError('console_error', `The console had a problem answering (HTTP ${res.status}). Try again in a minute.`, EXIT.OFFLINE);
  }
  return new CliError('failed', message || `The console answered HTTP ${res.status}.`, EXIT.FAILED);
}
