#!/usr/bin/env bun
// The `useagent` entry point: pick a command, parse its args (pure), build the client
// from env, and run. Every failure funnels through CliError -> a terse stderr line + the
// right exit code. `mcp` connects over stdio and keeps the process alive for the client.

import process from "node:process";
import { readFile, writeFile } from "node:fs/promises";
import { CliError } from "./errors";
import { USAGE, parseFanArgs, parseRunArgs, parseStatusArgs } from "./args";
import { clientFromEnv } from "./config";
import { fanCommand, runCommand, statusCommand, type CommandIO } from "./commands";
import { runMcpServer } from "./mcp";

async function main(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv;
  const io: CommandIO = {
    out: (line) => void process.stdout.write(`${line}\n`),
    err: (line) => void process.stderr.write(`${line}\n`),
    readFile: (path) => readFile(path, "utf8"),
    writeFile: (path, data) => writeFile(path, data, "utf8"),
  };

  switch (command) {
    case "run":
      return runCommand(clientFromEnv(process.env), parseRunArgs(rest), io);
    case "fan":
      return fanCommand(clientFromEnv(process.env), parseFanArgs(rest), io);
    case "status":
      return statusCommand(clientFromEnv(process.env), parseStatusArgs(rest), io);
    case "mcp":
      await runMcpServer(clientFromEnv(process.env));
      // The stdio transport owns the process lifetime; never resolve so we do not exit
      // out from under the connected client (the process ends when stdin closes).
      return new Promise<number>(() => {});
    case "help":
    case "--help":
    case "-h":
      io.out(USAGE);
      return 0;
    case undefined:
      io.err(USAGE);
      return 2;
    default:
      io.err(`unknown command: ${command}\n\n${USAGE}`);
      return 2;
  }
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    if (error instanceof CliError) {
      process.stderr.write(`error: ${error.message}\n`);
      process.exit(error.exitCode);
    }
    process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
