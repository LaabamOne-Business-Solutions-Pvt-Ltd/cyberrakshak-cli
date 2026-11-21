// What the command line prints: plain text for people (stdout), notes and progress on stderr, or one JSON document
// (--json) for scripts. No colours: a pipe, a CI log and a screen reader all read the same.

export function printJson(ctx, value) {
  ctx.out.write(JSON.stringify(value, null, 2) + '\n');
}

export function line(ctx, text = '') {
  ctx.out.write(text + '\n');
}

/** A note for the person, never part of the answer (stderr), so `--json` and pipes stay clean. */
export function note(ctx, text = '') {
  ctx.err.write(text + '\n');
}

/** Columns lined up; the last column is never padded. Cells are cut at `max` characters. */
export function table(ctx, headers, rows, max = 60) {
  const cut = (v) => {
    const s = v === null || v === undefined || v === '' ? '-' : String(v).replace(/\s+/g, ' ');
    return s.length > max ? s.slice(0, max - 1) + '…' : s;
  };
  const cells = [headers, ...rows].map((r) => r.map(cut));
  const widths = headers.map((_, i) => Math.max(...cells.map((r) => r[i].length)));
  for (const r of cells) {
    ctx.out.write(r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(widths[i]))).join('  ').trimEnd() + '\n');
  }
}

/** "4 min ago", "3 days ago"; "-" for nothing. From the console's ISO time. */
export function ago(iso, now = Date.now()) {
  if (!iso) return '-';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '-';
  const s = Math.round((now - t) / 1000);
  if (s < 0) return 'just now';
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  const d = Math.round(h / 24);
  return `${d} days ago`;
}

/** 21 Nov 2026, 14:05 (the computer's own time zone). */
export function when(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '-';
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()}, ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function plural(n, one, many = one + 's') {
  return `${n} ${n === 1 ? one : many}`;
}
