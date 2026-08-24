// Pure argument parsing for every command. No IO, no process, no client - each parser
// takes the raw argv tail and returns a typed options object or throws a CliError with
// a terse usage hint. Extracted so the whole surface is unit-testable without spawning.

import { DEFAULT_BASE_URL, MAX_FLEET_CONCURRENCY } from "@useagent/agent-client/fleet";
import { CliError } from "./errors";

export const USAGE = `useagent - fan cloud agent tasks out to your hosted org

Usage:
  useagent run "<prompt>" [--engine <id>] [--model <id>] [--repo owner/name]... [--watch]
  useagent fan <tasks.jsonl> [--parallel <n>] [--qc "<verifier prompt>"] [--out <results.jsonl>]
  useagent status <runId>
  useagent mcp

Environment:
  USEAGENT_API_KEY   required - org API key (sent as Authorization: Bearer <key>)
  USEAGENT_BASE_URL  optional - hosted origin (default ${DEFAULT_BASE_URL})`;

export interface RunArgs {
  readonly prompt: string;
  readonly engine?: string;
  readonly model?: string;
  readonly repos: string[];
  readonly watch: boolean;
}

export interface FanArgs {
  readonly file: string;
  readonly parallel: number;
  readonly qc?: string;
  readonly out?: string;
}

export interface StatusArgs {
  readonly runId: string;
}

interface FlagSpec {
  /** Flags that consume the next token (or `--flag=value`), given at most once. */
  readonly value: readonly string[];
  /** Value flags that may be repeated (collected into a list), e.g. --repo. */
  readonly repeat: readonly string[];
  /** Presence-only flags, e.g. --watch. */
  readonly boolean: readonly string[];
}

interface Tokens {
  readonly positionals: string[];
  readonly values: Map<string, string[]>;
  readonly flags: Set<string>;
}

function tokenize(argv: readonly string[], spec: FlagSpec): Tokens {
  const valueFlags = new Set([...spec.value, ...spec.repeat]);
  const boolFlags = new Set(spec.boolean);
  const positionals: string[] = [];
  const values = new Map<string, string[]>();
  const flags = new Set<string>();

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const eq = token.indexOf("=");
    const name = eq === -1 ? token : token.slice(0, eq);
    if (boolFlags.has(name)) {
      if (eq !== -1) throw new CliError(`flag ${name} does not take a value`, 2);
      flags.add(name);
      continue;
    }
    if (valueFlags.has(name)) {
      let value: string;
      if (eq !== -1) {
        value = token.slice(eq + 1);
      } else {
        const next = argv[i + 1];
        if (next === undefined) throw new CliError(`flag ${name} needs a value`, 2);
        value = next;
        i++;
      }
      const list = values.get(name) ?? [];
      list.push(value);
      values.set(name, list);
      continue;
    }
    throw new CliError(`unknown flag: ${name}`, 2);
  }
  return { positionals, values, flags };
}

function single(tokens: Tokens, name: string): string | undefined {
  const list = tokens.values.get(name);
  if (!list) return undefined;
  if (list.length > 1) throw new CliError(`flag ${name} may be given only once`, 2);
  return list[0];
}

export function parseRunArgs(argv: readonly string[]): RunArgs {
  const tokens = tokenize(argv, {
    value: ["--engine", "--model"],
    repeat: ["--repo"],
    boolean: ["--watch"],
  });
  const prompt = tokens.positionals.join(" ").trim();
  if (!prompt) throw new CliError('run needs a prompt: useagent run "<prompt>"', 2);
  return {
    prompt,
    engine: single(tokens, "--engine"),
    model: single(tokens, "--model"),
    repos: tokens.values.get("--repo") ?? [],
    watch: tokens.flags.has("--watch"),
  };
}

export function parseFanArgs(argv: readonly string[]): FanArgs {
  const tokens = tokenize(argv, {
    value: ["--parallel", "--qc", "--out"],
    repeat: [],
    boolean: [],
  });
  const file = tokens.positionals[0];
  if (!file) throw new CliError("fan needs a tasks file: useagent fan <tasks.jsonl>", 2);
  if (tokens.positionals.length > 1) throw new CliError("fan takes a single tasks file", 2);

  let parallel = 6;
  const rawParallel = single(tokens, "--parallel");
  if (rawParallel !== undefined) {
    const n = Number(rawParallel);
    if (!Number.isInteger(n) || n < 1 || n > MAX_FLEET_CONCURRENCY) {
      throw new CliError(
        `--parallel must be an integer between 1 and ${MAX_FLEET_CONCURRENCY}`,
        2,
      );
    }
    parallel = n;
  }
  return { file, parallel, qc: single(tokens, "--qc"), out: single(tokens, "--out") };
}

export function parseStatusArgs(argv: readonly string[]): StatusArgs {
  const tokens = tokenize(argv, { value: [], repeat: [], boolean: [] });
  const runId = tokens.positionals[0];
  if (!runId) throw new CliError("status needs a run id: useagent status <runId>", 2);
  if (tokens.positionals.length > 1) throw new CliError("status takes a single run id", 2);
  return { runId };
}
