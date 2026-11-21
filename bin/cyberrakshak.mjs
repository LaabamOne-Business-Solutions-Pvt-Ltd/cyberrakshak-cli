#!/usr/bin/env node
// The `cyberrakshak` command. Everything is in ../lib; this only checks the Node.js version and sets the exit code.
const [major] = process.versions.node.split('.').map(Number);
if (major < 18) {
  process.stderr.write(`The Cyber Rakshak command line needs Node.js 18 or later; this is ${process.versions.node}.\n`);
  process.exit(1);
}
const { main } = await import('../lib/main.mjs');
const code = await main(process.argv.slice(2));
process.exitCode = code;
// Nothing should be left running; if something is, it must not keep the terminal waiting.
setTimeout(() => process.exit(code), 3000).unref();
