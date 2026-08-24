/** A user-facing CLI failure. `exitCode` is the process code the bin exits with
 *  (2 for a usage error, 1 for an operational/config error). The message is terse
 *  and actionable - it names the missing env or the malformed input exactly. */
export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode = 1,
  ) {
    super(message);
    this.name = "CliError";
  }
}
