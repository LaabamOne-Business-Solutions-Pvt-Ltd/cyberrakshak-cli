// What can go wrong, in words for a customer, and the exit code each ends with (README: "Exit codes").

export const EXIT = {
  OK: 0,
  /** It ran and did not succeed (a test that did not arrive, a download that did not match). */
  FAILED: 1,
  /** The command or its options were wrong. */
  USAGE: 2,
  /** Not signed in, or the sign-in has ended (signed out, expired, unused too long). */
  SIGNED_OUT: 3,
  /** The account cannot see this (not available on it, not its site, not found). */
  NO_ACCESS: 4,
  /** The console could not be reached, did not answer in time, or had a problem answering. */
  OFFLINE: 5,
};

export class CliError extends Error {
  /**
   * @param {string} code a stable word for scripts (--json): usage, not_signed_in, signed_out, no_access, not_found,
   *                      offline, slow_down, console_error, failed, denied, expired
   * @param {string} message what to tell the person
   * @param {number} exit
   */
  constructor(code, message, exit = EXIT.FAILED) {
    super(message);
    this.name = 'CliError';
    this.code = code;
    this.exit = exit;
  }
}

export const usage = (message) => new CliError('usage', message, EXIT.USAGE);
export const failed = (message) => new CliError('failed', message, EXIT.FAILED);
