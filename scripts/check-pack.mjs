// What `npm pack` would publish, against what it must: exactly these files, the version everywhere the same, and the
// command a Node.js script with LF line endings (a CR in its first line stops it running on macOS and Linux).
//   node scripts/check-pack.mjs
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const lib = readdirSync(join(root, 'lib')).filter((f) => f.endsWith('.mjs')).map((f) => 'lib/' + f);
const WANT = ['CHANGELOG.md', 'LICENSE', 'README.md', 'bin/cyberrakshak.mjs', 'package.json', ...lib].sort();

const out = execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: root, encoding: 'utf8', shell: process.platform === 'win32' });
const [info] = JSON.parse(out);
const got = info.files.map((f) => f.path).sort();
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const problems = [];
if (JSON.stringify(got) !== JSON.stringify(WANT)) problems.push('files are ' + got.join(', ') + '; want ' + WANT.join(', '));
const version = readFileSync(join(root, 'lib', 'version.mjs'), 'utf8').match(/VERSION = '([^']+)'/);
if (!version || version[1] !== pkg.version) problems.push(`lib/version.mjs says ${version && version[1]}, package.json ${pkg.version}`);
if (info.version !== pkg.version) problems.push('npm pack version ' + info.version);
const bin = readFileSync(join(root, 'bin', 'cyberrakshak.mjs'));
if (!bin.toString('utf8').startsWith('#!/usr/bin/env node\n')) problems.push('bin/cyberrakshak.mjs does not start with "#!/usr/bin/env node" and an LF');
for (const f of WANT.filter((f) => f.endsWith('.mjs'))) {
  if (readFileSync(join(root, f)).includes('\r')) problems.push(f + ' has CR line endings');
}
if (pkg.bin.cyberrakshak !== 'bin/cyberrakshak.mjs') problems.push('package.json bin');
if (Object.keys(pkg.dependencies || {}).length) problems.push('it has dependencies: ' + Object.keys(pkg.dependencies).join(', '));

console.log(`${info.name}@${info.version}: ${info.entryCount} files, ${info.size} bytes packed, ${info.unpackedSize} unpacked`);
for (const f of info.files) {
  console.log(`  ${String(f.size).padStart(6)}  ${f.path}  sha256 ${createHash('sha256').update(readFileSync(join(root, f.path))).digest('hex')}`);
}
for (const p of problems) console.error('  PROBLEM: ' + p);
process.exit(problems.length ? 1 : 0);
