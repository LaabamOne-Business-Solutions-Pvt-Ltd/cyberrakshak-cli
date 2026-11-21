// Scrubbing what `cyberrakshak run` and `cyberrakshak test` send: the same rules, in the same order, as every Cyber
// Rakshak monitoring library (copied from the Node.js library, @cyberrakshak/monitor 1.0.0; test/scrub-vectors.json is
// the libraries' shared set of cases, and the tests run every one).

const SCRUB_RULES = [
  // A query string: ?name=... up to a space or quote. Where a request went is kept, never what it asked.
  [/\?[A-Za-z0-9_.%-]+[=&][^ \t\r\n#"'<>]*/g, () => ''],
  // Authorization values.
  [/(bearer|basic) +([A-Za-z0-9._~+/=-]{8,})/gi, (all, scheme, value) => (/[0-9A-Z._~+/=]/.test(value) ? scheme + ' [token]' : all)],
  // password=..., "client_secret": "...", x-api-key: ... (the name is kept, the value is not). The match starts at
  // the word (what comes before it is kept as it is) and allows 40 more name characters after it.
  [/((?:password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credential|session[_-]?id)[A-Za-z0-9_-]{0,40}\\?["']?[ ]*[=:][ ]*\\?["']?)[^ \t\r\n&,;"'<>\\]+/gi, (all, name) => name + '[removed]'],
  // JSON Web Tokens (a header of at most 500 characters).
  [/eyJ[A-Za-z0-9_-]{1,500}\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?/g, () => '[token]'],
  // Keys that say what they are.
  [/(?<![A-Za-z0-9])(?:crk_|crw_|sk_live_|sk_test_|pk_live_|pk_test_|rk_live_|ghp_|gho_|ghs_|ghu_|github_pat_|glpat-|xoxb-|xoxp-|xoxa-|AKIA|ASIA|AIza)[A-Za-z0-9_-]{10,}/g, () => '[token]'],
  // Email addresses.
  [/[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, () => '[email]'],
  // Card numbers: 13 to 19 digits (single spaces or dashes between) that pass the Luhn check.
  [/(?<![0-9])[0-9](?:[ -]?[0-9]){12,18}/g, (all) => (luhn(all.replace(/[ -]/g, '')) ? '[card]' : all)],
  // Long hex runs: session ids, hashes, keys.
  [/[0-9a-fA-F]{32,}/g, () => '[token]'],
  // Long random-looking runs: a digit, an upper-case and a lower-case letter in 40 or more of A-Z a-z 0-9 + _ -.
  [/[A-Za-z0-9+_-]{40,}/g, (all) => (/[0-9]/.test(all) && /[A-Z]/.test(all) && /[a-z]/.test(all) ? '[token]' : all)],
];

function luhn(digits) {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48;
    if (double) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    double = !double;
  }
  return sum % 10 === 0;
}

/** What a text looks like once scrubbed: what would be sent. */
export function scrub(text) {
  try {
    let out = String(text ?? '');
    for (const [pattern, replace] of SCRUB_RULES) {
      out = out.replace(pattern, replace);
    }
    return out;
  } catch {
    return '';
  }
}

/** Text as it may be sent: no terminal colour codes, no control characters but tab and newline. */
export function clean(text) {
  return String(text ?? '')
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '');
}

/** At most `max` UTF-16 units, never cut inside a surrogate pair, never holding a lone one. */
export function clip(text, max) {
  let s = String(text);
  if (s.length > max) {
    s = s.slice(0, max);
    const last = s.charCodeAt(s.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) s = s.slice(0, -1);
  }
  return wellFormed(s);
}

/** The last `max` units: the end of an error output is what matters most. */
export function clipEnd(text, max) {
  let s = String(text);
  if (s.length > max) {
    s = s.slice(s.length - max);
    const first = s.charCodeAt(0);
    if (first >= 0xdc00 && first <= 0xdfff) s = s.slice(1);
  }
  return wellFormed(s);
}

function wellFormed(s) {
  return typeof s.toWellFormed === 'function' ? s.toWellFormed() : s.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '�');
}

/** Cleaned, scrubbed and cut to `max`: from the start (a message) or from the end (`fromEnd`, an error output). */
export function sendable(text, max, fromEnd = false) {
  const cut = fromEnd ? clipEnd : clip;
  return cut(scrub(cut(clean(text), max * 2)), max);
}
