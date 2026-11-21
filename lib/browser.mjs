// Opening the sign-in page in the person's browser, without a shell (a URL's & or ? must never be read as a command).
// CYBERRAKSHAK_BROWSER=none opens nothing (the URL is printed either way); any other value is a program to run with
// the URL as its one argument.
import { spawn } from 'node:child_process';

/** Resolves to true when a browser was started, false when none could be (the caller prints the URL anyway). */
export function openBrowser(url, env = process.env) {
  const chosen = env.CYBERRAKSHAK_BROWSER;
  if (chosen === 'none') return Promise.resolve(false);
  let command;
  let args;
  if (chosen) {
    command = chosen;
    args = [url];
  } else if (process.platform === 'win32') {
    command = 'rundll32.exe';
    args = ['url.dll,FileProtocolHandler', url];
  } else if (process.platform === 'darwin') {
    command = 'open';
    args = [url];
  } else {
    command = 'xdg-open';
    args = [url];
  }
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { stdio: 'ignore', detached: true, windowsHide: true });
    } catch {
      resolve(false);
      return;
    }
    let done = false;
    const settle = (value) => {
      if (!done) {
        done = true;
        resolve(value);
      }
    };
    child.on('error', () => settle(false));
    // A launcher that is there starts at once; one that fails says so within moments.
    child.on('exit', (code) => settle(code === 0 || code === null));
    setTimeout(() => settle(true), 1500).unref();
    child.unref();
  });
}
