// `cyberrakshak run -- <command>`: run a command as it is, and if it fails, report it to the site's Errors page, as the
// shell library (cr-report.sh run) does: the command's name (never its arguments: they may hold secrets), its exit
// code and the last 20 lines of its standard error, scrubbed. Its output passes straight through, and this ends with
// the command's own exit code. Ctrl+C is not reported. With no app key, the command still runs and nothing is sent.
import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { basename, delimiter, extname, join } from 'node:path';
import { constants as os } from 'node:os';
import { envelope, findKey, reportEndpoint, reportRefusal, sendReport } from './monitoring.mjs';
import { clip, sendable } from './scrub.mjs';

const KEEP_LINES = 20;
const MAX_STACK = 12000;
const MAX_LINE = 4000;

/** On Windows, the file a command name runs (PATH and PATHEXT), so a .cmd or .bat is started through cmd.exe. */
function resolveWindows(command, env) {
  if (/[\\/]/.test(command)) return existsSync(command) ? command : null;
  const exts = String(env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  for (const dir of String(env.PATH || env.Path || '').split(delimiter)) {
    if (!dir) continue;
    for (const ext of [extname(command) ? '' : null, ...exts].filter((e) => e !== null)) {
      const file = join(dir, command + ext);
      try {
        if (statSync(file).isFile()) return file;
      } catch {
        // not here
      }
    }
  }
  return null;
}

function quoteForCmd(arg) {
  return /^[A-Za-z0-9_./:=@,+\\-]+$/.test(arg) ? arg : '"' + String(arg).replace(/"/g, '""') + '"';
}

/**
 * Resolves to the exit code to end with. `ctx.err` gets the command's standard error as it comes, plus at most one
 * line of ours (why a failure was not reported).
 */
export async function runCommand(ctx, argv, { key: keyFlag, route = null } = {}) {
  const name = basename(argv[0]).replace(/\.(exe|cmd|bat|com)$/i, '');
  let file = argv[0];
  let args = argv.slice(1);
  let shell = false;
  if (process.platform === 'win32') {
    const found = resolveWindows(argv[0], ctx.env);
    if (found && /\.(cmd|bat)$/i.test(found)) {
      shell = true;
      file = quoteForCmd(found);
      args = args.map(quoteForCmd);
    } else if (found) {
      file = found;
    }
  }

  const ring = [];
  let partial = '';
  const keep = (text) => {
    const parts = (partial + text).split('\n');
    partial = parts.pop();
    for (const p of parts) {
      ring.push(p.length > MAX_LINE ? p.slice(-MAX_LINE) : p);
      if (ring.length > KEEP_LINES) ring.shift();
    }
    if (partial.length > MAX_LINE * 2) partial = partial.slice(-MAX_LINE);
  };

  const outcome = await new Promise((resolve) => {
    let child;
    try {
      child = spawn(file, args, { stdio: ['inherit', 'inherit', 'pipe'], shell, windowsHide: false, env: ctx.env, cwd: ctx.cwd });
    } catch (e) {
      resolve({ code: 127, signal: null, startError: e });
      return;
    }
    let interrupted = false;
    const onSignal = (sig) => {
      interrupted = true;
      try {
        child.kill(sig);
      } catch {
        // gone already
      }
    };
    const sigint = () => onSignal('SIGINT');
    const sigterm = () => onSignal('SIGTERM');
    process.on('SIGINT', sigint);
    process.on('SIGTERM', sigterm);
    child.stderr.on('data', (chunk) => {
      ctx.err.write(chunk);
      keep(chunk.toString('utf8'));
    });
    child.on('error', (e) => {
      process.off('SIGINT', sigint);
      process.off('SIGTERM', sigterm);
      resolve({ code: 127, signal: null, startError: e });
    });
    child.on('close', (code, signal) => {
      process.off('SIGINT', sigint);
      process.off('SIGTERM', sigterm);
      resolve({ code, signal, interrupted });
    });
  });

  if (partial !== '') keep('\n');
  let code;
  if (outcome.startError) {
    const why = outcome.startError.code === 'ENOENT' ? 'command not found' : outcome.startError.message;
    ctx.err.write(`cyberrakshak run: could not start ${name}: ${why}\n`);
    ring.push(`${name}: ${why}`);
    code = 127;
  } else if (outcome.signal) {
    code = 128 + (os.signals[outcome.signal] || 1);
  } else {
    code = outcome.code ?? 1;
  }
  // Ctrl+C (or a stop asked of this process) is the person's choice, not a failure.
  const stoppedByPerson = outcome.interrupted || outcome.signal === 'SIGINT' || outcome.signal === 'SIGTERM' || (process.platform === 'win32' && code === 3221225786);
  if (code === 0 || stoppedByPerson) return code;

  let found = null;
  try {
    found = findKey(ctx, keyFlag);
  } catch (e) {
    ctx.err.write(`cyberrakshak run: not reported: ${e.message}\n`);
    return code;
  }
  if (!found) {
    ctx.err.write('cyberrakshak run: not reported: no app key (set CR_MONITOR_KEY, or run cyberrakshak init).\n');
    return code;
  }
  const stack = sendable(ring.join('\n'), MAX_STACK, true);
  const problem = {
    kind: 'script',
    level: 'error',
    message: sendable(`${name} exited with code ${code}`, 4000),
    count: 1,
    at: new Date().toISOString(),
    route: clip(sendable(route || name, 200), 200),
    context: { exit_code: code },
  };
  if (stack.trim() !== '') problem.stack = stack;
  const environment = /^[a-z0-9_-]{1,30}$/.test(String(ctx.env.CR_MONITOR_ENVIRONMENT || '')) ? ctx.env.CR_MONITOR_ENVIRONMENT : null;
  const release = /^[A-Za-z0-9._+-]{1,60}$/.test(String(ctx.env.CR_MONITOR_RELEASE || '')) ? ctx.env.CR_MONITOR_RELEASE : null;
  try {
    const res = await sendReport(reportEndpoint(ctx), found.key, envelope(problem, { environment, release }));
    if (res.status !== 204) ctx.err.write(`cyberrakshak run: not reported: ${reportRefusal(res.status, null, res)}\n`);
  } catch (e) {
    ctx.err.write(`cyberrakshak run: not reported: the console could not be reached (${e.reason || e.message}).\n`);
  }
  return code;
}
