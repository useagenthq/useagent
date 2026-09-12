import { dirname } from "node:path";
import type { PromotionEffects } from "./promotion";
import {
	classifyMigrations,
	type MigrationFile,
	type ReleaseHistory,
	type ReleaseRecord,
	releasePorts,
	renderCaddyTemplate,
	rewriteCaddyUpstreams,
} from "./release-config";

type PromotionCommand = "promote" | "rollback";
type Service = "backend" | "gateway" | "frontend";

const defaultBackendTimeoutMs = 60_000;
const defaultCaddyTimeoutMs = 10_000;
const defaultPublicVerifyTimeoutMs = 90_000;

export interface SshPromotionConfig {
	readonly sshHost: string;
	readonly sshKey: string | null;
	readonly sshConfig: string | null;
	readonly sshControlPath: string;
	readonly appDomain: string;
	readonly gatewayDomain: string;
	readonly publicGatewayUrl: string;
	readonly backendEnvFile: string;
	readonly gatewayEnvFile: string;
	readonly remoteRoot: string;
	readonly historyPath: string;
	readonly caddyConfigPath: string;
	readonly caddyEnvFile: string;
	readonly composeSource: string;
	readonly caddyTemplateSource: string;
	readonly crashAfter: "source-backend-stopped" | "caddy-switched" | null;
}

interface ProcessResult {
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
}

export interface PrepareReleaseOptions {
	readonly allowLegacyBlue?: boolean;
	readonly applyMigrations?: boolean;
	readonly caddyConfig?: string;
}

const serviceNames: readonly Service[] = ["backend", "gateway", "frontend"];

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function timeoutSeconds(timeoutMs: number): number {
	return Math.max(1, Math.ceil(timeoutMs / 1000));
}

async function runProcess(
	argv: readonly string[],
	options: {
		readonly input?: string;
		readonly allowFailure?: boolean;
		readonly timeoutMs?: number;
	} = {},
): Promise<ProcessResult> {
	const child = Bun.spawn([...argv], {
		stdin: options.input === undefined ? "ignore" : "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	if (options.input !== undefined) {
		if (!child.stdin) throw new Error("process stdin pipe is unavailable");
		child.stdin.write(options.input);
		child.stdin.end();
	}
	const stdoutPromise = new Response(child.stdout).text();
	const stderrPromise = new Response(child.stderr).text();
	const timeoutMs = options.timeoutMs ?? 310_000;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const code = await Promise.race([
		child.exited,
		new Promise<null>((resolve) => {
			timer = setTimeout(() => resolve(null), timeoutMs);
		}),
	]).finally(() => {
		if (timer) clearTimeout(timer);
	});
	if (code === null) {
		child.kill();
		await child.exited.catch(() => {});
		throw new Error(`${argv[0]} timed out after ${timeoutMs}ms`);
	}
	const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
	const result = { code, stdout, stderr };
	if (code !== 0 && !options.allowFailure) {
		throw new Error(
			`${argv[0]} failed (${code}): ${stderr.trim() || stdout.trim()}`,
		);
	}
	return result;
}

export class RemoteHost {
	readonly #config: SshPromotionConfig;
	readonly #deadlineAt: number;

	constructor(config: SshPromotionConfig, deadlineAt = Date.now() + 300_000) {
		this.#config = config;
		this.#deadlineAt = deadlineAt;
	}

	sshArgs(): string[] {
		return [
			"ssh",
			...(this.#config.sshConfig ? ["-F", this.#config.sshConfig] : []),
			...(this.#config.sshKey ? ["-i", this.#config.sshKey] : []),
			"-o",
			"BatchMode=yes",
			"-o",
			"ConnectTimeout=10",
			"-o",
			"StrictHostKeyChecking=accept-new",
			"-o",
			"ServerAliveInterval=15",
			"-o",
			"ControlMaster=auto",
			"-o",
			"ControlPersist=60",
			"-o",
			`ControlPath=${this.#config.sshControlPath}`,
			this.#config.sshHost,
		];
	}

	async run(
		command: string,
		options: {
			readonly input?: string;
			readonly allowFailure?: boolean;
			readonly timeoutMs?: number;
		} = {},
	): Promise<ProcessResult> {
		const remainingMs = this.#deadlineAt - Date.now();
		if (remainingMs <= 0) throw new Error("promotion exceeded 300000ms");
		const timeoutMs = Math.min(options.timeoutMs ?? remainingMs, remainingMs);
		const bounded =
			`timeout --foreground --signal=TERM --kill-after=5s ` +
			`${timeoutSeconds(timeoutMs)}s sh -c ${shellQuote(command)}`;
		return runProcess([...this.sshArgs(), bounded], {
			...options,
			timeoutMs: Math.min(remainingMs, timeoutMs + 5_000),
		});
	}

	async readOptional(path: string): Promise<string | null> {
		const result = await this.run(
			`if test -f ${shellQuote(path)}; then cat -- ${shellQuote(path)}; fi`,
		);
		return result.stdout.trim() ? result.stdout : null;
	}

	async writeAtomic(
		path: string,
		contents: string,
		mode = "600",
	): Promise<void> {
		const directory = dirname(path);
		const command =
			`umask 077; install -d -m 700 ${shellQuote(directory)}; ` +
			`tmp=$(mktemp ${shellQuote(`${directory}/.useagent-write.XXXXXX`)}); ` +
			`cat > "$tmp"; chmod ${mode} "$tmp"; sync -f "$tmp"; ` +
			`mv -f "$tmp" ${shellQuote(path)}; sync -f ${shellQuote(directory)}`;
		await this.run(command, { input: contents });
	}

	async acquireLock(): Promise<() => Promise<void>> {
		const lockPath = `${this.#config.remoteRoot}/promote.lock`;
		const child = Bun.spawn(
			[
				...this.sshArgs(),
				`install -d -m 700 ${shellQuote(this.#config.remoteRoot)}; ` +
					`flock -n ${shellQuote(lockPath)} sh -c 'printf "LOCKED\\n"; cat >/dev/null'`,
			],
			{ stdin: "pipe", stdout: "pipe", stderr: "pipe" },
		);
		const reader = child.stdout.getReader();
		try {
			const marker = (async () => {
				const decoder = new TextDecoder();
				let output = "";
				while (!output.includes("\n")) {
					const chunk = await reader.read();
					if (chunk.done) break;
					output += decoder.decode(chunk.value, { stream: true });
				}
				return output;
			})();
			let timer: ReturnType<typeof setTimeout> | undefined;
			const text = await Promise.race([
				marker,
				new Promise<never>((_, reject) => {
					timer = setTimeout(
						() =>
							reject(new Error("timed out acquiring remote promotion lock")),
						15_000,
					);
				}),
			]).finally(() => {
				if (timer) clearTimeout(timer);
			});
			if (!text.split("\n").some((line) => line.trim() === "LOCKED")) {
				throw new Error("another promotion owns the remote host lock");
			}
		} catch (error) {
			child.stdin.end();
			child.kill();
			await child.exited.catch(() => {});
			throw error;
		} finally {
			reader.releaseLock();
		}
		return async () => {
			child.stdin.end();
			let timer: ReturnType<typeof setTimeout> | undefined;
			const exited = await Promise.race([
				child.exited.then(() => true),
				new Promise<false>((resolve) => {
					timer = setTimeout(() => resolve(false), 1_000);
				}),
			]).finally(() => {
				if (timer) clearTimeout(timer);
			});
			if (!exited) {
				child.kill();
				await child.exited.catch(() => {});
			}
		};
	}
}

export function releaseDirectory(
	config: SshPromotionConfig,
	record: ReleaseRecord,
): string {
	return `${config.remoteRoot}/releases/${record.manifest.commit}-${record.color}`;
}

export function composePromotionCommand(
	config: SshPromotionConfig,
	record: ReleaseRecord,
	args: string,
): string {
	const directory = releaseDirectory(config, record);
	return (
		`docker compose --project-name ${shellQuote(`useagent-${record.color}`)} ` +
		`--env-file ${shellQuote(`${directory}/release.env`)} ` +
		`--file ${shellQuote(`${directory}/compose.prod.yaml`)} ${args}`
	);
}

function parseMigrationInventory(output: string): MigrationFile[] {
	return output
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			const separator = line.indexOf("\t");
			if (separator <= 0) throw new Error("invalid migration inventory row");
			return {
				path: line.slice(0, separator),
				contents: Buffer.from(line.slice(separator + 1), "base64").toString(
					"utf8",
				),
			};
		});
}

export class SshPromotionEffects implements PromotionEffects {
	readonly #config: SshPromotionConfig;
	readonly #remote: RemoteHost;
	readonly #historyAtStart: ReleaseHistory;
	readonly #target: ReleaseRecord;
	readonly #kind: PromotionCommand;
	readonly #operationId: string;
	readonly #composeFile: string;
	readonly #caddyTemplate: string;
	readonly #crash: () => Promise<never>;
	admissionClosedAt: number | null = null;
	admissionOpenedAt: number | null = null;

	constructor(input: {
		readonly config: SshPromotionConfig;
		readonly remote: RemoteHost;
		readonly history: ReleaseHistory;
		readonly target: ReleaseRecord;
		readonly kind: PromotionCommand;
		readonly composeFile: string;
		readonly caddyTemplate: string;
		readonly operationId?: string;
		readonly crash: () => Promise<never>;
	}) {
		this.#config = input.config;
		this.#remote = input.remote;
		this.#historyAtStart = input.history;
		this.#target = input.target;
		this.#kind = input.kind;
		this.#operationId =
			input.operationId ??
			`${input.kind}:${input.target.manifest.commit}:${input.target.color}`;
		this.#composeFile = input.composeFile;
		this.#caddyTemplate = input.caddyTemplate;
		this.#crash = input.crash;
	}

	now(): string {
		return new Date().toISOString();
	}

	async persistHistory(history: ReleaseHistory): Promise<void> {
		await this.#remote.writeAtomic(
			this.#config.historyPath,
			`${JSON.stringify(history, null, 2)}\n`,
		);
	}

	async #stageRelease(
		record: ReleaseRecord,
		caddyOverride?: string,
	): Promise<void> {
		const ports = releasePorts(record.color);
		const directory = releaseDirectory(this.#config, record);
		const env = {
			USEAGENT_RELEASE_COLOR: record.color,
			USEAGENT_RELEASE_COMMIT: record.manifest.commit,
			USEAGENT_BACKEND_IMAGE: record.manifest.backend,
			USEAGENT_GATEWAY_IMAGE: record.manifest.gateway,
			USEAGENT_FRONTEND_IMAGE: record.manifest.frontend,
			USEAGENT_BACKEND_PORT: String(ports.backend),
			USEAGENT_GATEWAY_PORT: String(ports.gateway),
			USEAGENT_FRONTEND_PORT: String(ports.frontend),
			USEAGENT_BACKEND_ENV_FILE: this.#config.backendEnvFile,
			USEAGENT_GATEWAY_ENV_FILE: this.#config.gatewayEnvFile,
			USEAGENT_GATEWAY_PUBLIC_URL: this.#config.publicGatewayUrl,
		};
		const envText = Object.entries(env)
			.map(([key, value]) => `${key}=${value}\n`)
			.join("");
		const caddy = caddyOverride ?? (await this.#renderCaddy(record));
		await this.#remote.writeAtomic(`${directory}/release.env`, envText);
		await this.#remote.writeAtomic(
			`${directory}/compose.prod.yaml`,
			this.#composeFile,
			"644",
		);
		await this.#remote.writeAtomic(`${directory}/Caddyfile`, caddy, "644");
		await this.#remote.writeAtomic(
			`${directory}/release-manifest.json`,
			`${JSON.stringify(record.manifest, null, 2)}\n`,
		);
		await this.#remote.run(
			`${composePromotionCommand(this.#config, record, "config --quiet")}`,
		);
		await this.#validateCaddy(`${directory}/Caddyfile`);
	}

	async #renderCaddy(record: ReleaseRecord): Promise<string> {
		const ports = releasePorts(record.color);
		const upstreams = {
			backend: `127.0.0.1:${ports.backend}`,
			gateway: `127.0.0.1:${ports.gateway}`,
			frontend: `127.0.0.1:${ports.frontend}`,
		};
		const live = await this.#remote.readOptional(this.#config.caddyConfigPath);
		const source =
			live ??
			renderCaddyTemplate(this.#caddyTemplate, {
				...upstreams,
				appDomain: this.#config.appDomain,
				gatewayDomain: this.#config.gatewayDomain,
			});
		return rewriteCaddyUpstreams(source, upstreams);
	}

	async #validateCaddy(path: string): Promise<void> {
		await this.#remote.run(
			`set -a; if test -f ${shellQuote(this.#config.caddyEnvFile)}; then . ` +
				`${shellQuote(this.#config.caddyEnvFile)}; fi; set +a; ` +
				`caddy validate --config ${shellQuote(path)}`,
		);
	}

	async migrationInventory(image: string): Promise<MigrationFile[]> {
		const script =
			'for file in /app/backend/drizzle/*.sql; do [ -f "$file" ] || continue; ' +
			'printf "%s\\t" "$(basename "$file")"; base64 -w0 "$file"; printf "\\n"; done';
		const result = await this.#remote.run(
			`docker run --rm --entrypoint sh ${shellQuote(image)} -c ${shellQuote(script)}`,
		);
		return parseMigrationInventory(result.stdout);
	}

	async applyMigrations(record: ReleaseRecord): Promise<void> {
		await this.#remote.run(
			composePromotionCommand(
				this.#config,
				record,
				"run --rm --no-deps backend bun run scripts/migrate-release.ts",
			),
		);
	}

	async prepareRelease(
		record: ReleaseRecord,
		options: PrepareReleaseOptions = {},
	): Promise<void> {
		// Rebuild every staged specification from the immutable release record and
		// the checked-out controller. Rollback never trusts mutable host-side files.
		await this.#stageRelease(record, options.caddyConfig);
		if (!this.#historyAtStart.current && !options.allowLegacyBlue) {
			const ports = [
				releasePorts("blue").backend,
				releasePorts("green").backend,
			];
			const result = await this.#remote.run(
				`test -z "$(docker ps --filter label=io.useagent.release.service=backend -q)" && ` +
					ports
						.map(
							(port) =>
								`! ss -ltn '( sport = :${port} )' | tail -n +2 | grep -q .`,
						)
						.join(" && "),
				{ allowFailure: true },
			);
			if (result.code !== 0) {
				throw new Error(
					"bootstrap requires no running backend and unused blue/green ports",
				);
			}
		}
		if (this.#kind === "promote") {
			await this.#remote.run(
				composePromotionCommand(this.#config, record, "pull"),
			);
		} else {
			for (const image of serviceNames.map(
				(service) => record.manifest[service],
			)) {
				await this.#remote.run(
					`docker image inspect ${shellQuote(image)} >/dev/null`,
				);
			}
		}
		for (const service of serviceNames) {
			const image = record.manifest[service];
			const result = await this.#remote.run(
				`docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' ` +
					shellQuote(image),
			);
			if (result.stdout.trim() !== record.manifest.commit) {
				throw new Error(
					`${service} image revision does not match release manifest`,
				);
			}
		}
		const current = this.#historyAtStart.current;
		if (current) {
			const currentFiles = await this.migrationInventory(
				current.manifest.backend,
			);
			const targetFiles = await this.migrationInventory(
				record.manifest.backend,
			);
			const decision =
				this.#kind === "promote"
					? classifyMigrations(currentFiles, targetFiles)
					: classifyMigrations(targetFiles, currentFiles);
			const safe =
				this.#kind === "promote" ? decision.forwardSafe : decision.rollbackSafe;
			if (!safe)
				throw new Error(
					`migration transition is not ${this.#kind}-safe: ${JSON.stringify(decision)}`,
				);
		}
		if (this.#kind === "promote" && options.applyMigrations !== false) {
			await this.applyMigrations(record);
		}
	}

	async preflight(record: ReleaseRecord): Promise<void> {
		await this.prepareRelease(record);
	}

	async warmEdge(record: ReleaseRecord): Promise<void> {
		await this.#remote.run(
			composePromotionCommand(
				this.#config,
				record,
				"up -d --no-deps --wait --wait-timeout 120 frontend gateway",
			),
		);
		const ports = releasePorts(record.color);
		const frontend = await this.#remote.run(
			`curl --connect-timeout 2 --max-time 5 -fsS ` +
				`http://127.0.0.1:${ports.frontend}/healthz`,
		);
		if (!frontend.stdout.includes(record.manifest.commit)) {
			throw new Error(
				"frontend direct health did not report the target commit",
			);
		}
		const gateway = await this.#remote.run(
			`curl --connect-timeout 2 --max-time 5 -fsS -D - -o /dev/null ` +
				`http://127.0.0.1:${ports.gateway}/health`,
		);
		if (
			!gateway.stdout
				.toLowerCase()
				.includes(`run-events-v1:${record.manifest.commit}`)
		) {
			throw new Error("gateway direct health did not report the target commit");
		}
	}

	async stopEdge(record: ReleaseRecord): Promise<void> {
		await this.#remote.run(
			composePromotionCommand(
				this.#config,
				record,
				"stop -t 30 frontend gateway",
			),
			{ allowFailure: true },
		);
	}

	async #container(
		record: ReleaseRecord,
		timeoutMs = 2_000,
	): Promise<string | null> {
		const result = await this.#remote.run(
			composePromotionCommand(this.#config, record, "ps -q backend"),
			{ allowFailure: true, timeoutMs },
		);
		return result.stdout.trim() || null;
	}

	async #operatorRequest(
		record: ReleaseRecord,
		path: string,
		method: "GET" | "POST",
		body?: unknown,
		timeoutMs = 5_000,
	): Promise<ProcessResult> {
		const port = releasePorts(record.color).backend;
		const curl =
			`set -a; . ${shellQuote(this.#config.backendEnvFile)}; set +a; ` +
			`test -n "$USEAGENT_OPERATOR_SECRET"; ` +
			`curl --connect-timeout 1 --max-time 2 -fsS -X ${method} ` +
			`-H "Authorization: Bearer $USEAGENT_OPERATOR_SECRET" ` +
			`${method === "POST" ? "-H 'content-type: application/json' --data-binary @- " : ""}` +
			`http://127.0.0.1:${port}/api/internal/operator/${path}`;
		return this.#remote.run(curl, {
			...(body === undefined ? {} : { input: JSON.stringify(body) }),
			allowFailure: true,
			timeoutMs,
		});
	}

	async #containerControl(
		record: ReleaseRecord,
		action: "open" | "close" | "inflight",
		timeoutMs = 5_000,
	): Promise<string> {
		const container = await this.#container(record, Math.min(2_000, timeoutMs));
		if (!container)
			throw new Error(
				`no ${record.color} backend container for deployment control`,
			);
		const change = {
			open: action === "open",
			operationId: this.#operationId,
			actor: "compose-promote",
			reason:
				action === "close" ? "bounded backend swap" : "backend swap completed",
		};
		const source =
			action === "inflight"
				? `(async()=>{const m=await import('/app/backend/src/commands/admission.ts');` +
					`console.log(JSON.stringify(await m.deploymentInflightSnapshot()));` +
					`const d=await import('/app/backend/src/db/client.ts');await d.client.end({timeout:5})})()`
				: `(async()=>{const m=await import('/app/backend/src/commands/admission.ts');` +
					`const change=JSON.parse(Buffer.from(process.env.USEAGENT_CONTROL_JSON,'base64').toString());` +
					`console.log(JSON.stringify(await m.setRunAdmission(change)));` +
					`const d=await import('/app/backend/src/db/client.ts');await d.client.end({timeout:5})})()`;
		const encoded = Buffer.from(JSON.stringify(change)).toString("base64");
		const result = await this.#remote.run(
			`timeout --foreground --signal=TERM --kill-after=2s 5s ` +
				`docker exec -e USEAGENT_CONTROL_JSON=${shellQuote(encoded)} ` +
				`${shellQuote(container)} bun -e ${shellQuote(source)}`,
			{ timeoutMs },
		);
		return result.stdout;
	}

	async #setAdmission(open: boolean, timeoutMs = 10_000): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		const remainingMs = (): number => {
			const remaining = deadline - Date.now();
			if (remaining <= 0) throw new Error("admission mutation timed out");
			return remaining;
		};
		const targetHealthy = await this.backendHealthy(
			this.#target,
			remainingMs(),
		);
		const record = targetHealthy ? this.#target : this.#historyAtStart.current;
		if (!record) return;
		const body = {
			open,
			operationId: this.#operationId,
			actor: "compose-promote",
			reason: open ? "backend swap completed" : "bounded backend swap",
		};
		const response = await this.#operatorRequest(
			record,
			"run-admission",
			"POST",
			body,
			remainingMs(),
		);
		if (response.code !== 0) {
			await this.#containerControl(
				record,
				open ? "open" : "close",
				remainingMs(),
			);
		}
	}

	async closeAdmission(timeoutMs = 10_000): Promise<void> {
		if (!this.#historyAtStart.current) return;
		const startedAt = Date.now();
		await this.#setAdmission(false, timeoutMs);
		this.admissionClosedAt ??= startedAt;
	}

	async openAdmission(timeoutMs = 10_000): Promise<void> {
		await this.#setAdmission(true, timeoutMs);
		this.admissionOpenedAt = Date.now();
	}

	async drainBackend(timeoutMs: number): Promise<boolean> {
		const record = this.#historyAtStart.current;
		if (!record) return true;
		const deadline = Date.now() + timeoutMs;
		while (Date.now() <= deadline) {
			const response = await this.#operatorRequest(
				record,
				"deployment-inflight",
				"GET",
			);
			const output =
				response.code === 0
					? response.stdout
					: await this.#containerControl(record, "inflight");
			const snapshot = JSON.parse(output) as { count?: unknown };
			if (snapshot.count === 0) return true;
			await Bun.sleep(1000);
		}
		return false;
	}

	async backendHealthy(
		record: ReleaseRecord,
		timeoutMs = 2_000,
	): Promise<boolean> {
		const port = releasePorts(record.color).backend;
		const result = await this.#remote.run(
			`curl --connect-timeout 1 --max-time 2 -fsS -D - -o /dev/null ` +
				`http://127.0.0.1:${port}/api/health`,
			{ allowFailure: true, timeoutMs },
		);
		return (
			result.code === 0 &&
			result.stdout
				.toLowerCase()
				.includes(`run-events-v1:${record.manifest.commit}`)
		);
	}

	async stopBackend(
		record: ReleaseRecord,
		timeoutMs = defaultBackendTimeoutMs,
	): Promise<void> {
		const seconds = timeoutSeconds(timeoutMs);
		await this.#remote.run(
			`timeout --foreground --signal=TERM --kill-after=2s ${seconds}s ` +
				composePromotionCommand(
					this.#config,
					record,
					`stop -t ${Math.min(5, seconds)} backend`,
				),
		);
		if (
			this.#config.crashAfter === "source-backend-stopped" &&
			record.manifest.commit === this.#historyAtStart.current?.manifest.commit
		) {
			await this.#crash();
		}
	}

	async startBackend(
		record: ReleaseRecord,
		_timeoutEnv?: Readonly<Record<string, string>>,
		timeoutMs = defaultBackendTimeoutMs,
	): Promise<void> {
		const seconds = timeoutSeconds(timeoutMs);
		await this.#remote.run(
			`timeout --foreground --signal=TERM --kill-after=2s ${seconds}s ` +
				composePromotionCommand(
					this.#config,
					record,
					`up -d --no-deps --wait --wait-timeout ${seconds} backend`,
				),
		);
	}

	async waitBackendHealthy(
		record: ReleaseRecord,
		timeoutMs = defaultBackendTimeoutMs,
	): Promise<boolean> {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() <= deadline) {
			if (await this.backendHealthy(record)) return true;
			await Bun.sleep(1000);
		}
		return false;
	}

	async switchCaddy(
		record: ReleaseRecord,
		timeoutMs = defaultCaddyTimeoutMs,
	): Promise<void> {
		const staged = `${releaseDirectory(this.#config, record)}/Caddyfile`;
		const live = this.#config.caddyConfigPath;
		const directory = dirname(live);
		const command =
			`set -e; install -d -m 755 ${shellQuote(directory)}; ` +
			`backup=$(mktemp ${shellQuote(`${this.#config.remoteRoot}/.caddy-backup.XXXXXX`)}); ` +
			`had_live=0; if test -f ${shellQuote(live)}; then cp --preserve=mode,ownership ` +
			`${shellQuote(live)} "$backup"; had_live=1; fi; ` +
			`install -o root -g root -m 644 ${shellQuote(staged)} ${shellQuote(`${live}.next`)}; ` +
			`set -a; if test -f ${shellQuote(this.#config.caddyEnvFile)}; then . ` +
			`${shellQuote(this.#config.caddyEnvFile)}; fi; set +a; ` +
			`caddy validate --config ${shellQuote(`${live}.next`)}; ` +
			`mv -f ${shellQuote(`${live}.next`)} ${shellQuote(live)}; ` +
			`if ! systemctl reload caddy; then ` +
			`if test "$had_live" = 1; then cp -- "$backup" ${shellQuote(live)}; systemctl reload caddy; fi; ` +
			`rm -f "$backup"; exit 1; fi; rm -f "$backup"`;
		await this.#remote.run(
			`timeout --foreground --signal=TERM --kill-after=2s ` +
				`${timeoutSeconds(timeoutMs)}s sh -c ${shellQuote(command)}`,
		);
		if (
			this.#config.crashAfter === "caddy-switched" &&
			record.manifest.commit === this.#target.manifest.commit
		) {
			await this.#crash();
		}
	}

	async verifyPublic(
		record: ReleaseRecord,
		timeoutMs = defaultPublicVerifyTimeoutMs,
	): Promise<boolean> {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() <= deadline) {
			try {
				const requestTimeoutMs = Math.max(
					1,
					Math.min(2_000, deadline - Date.now()),
				);
				const [frontend, backend, gateway] = await Promise.all([
					fetch(`https://${this.#config.appDomain}/healthz`, {
						cache: "no-store",
						signal: AbortSignal.timeout(requestTimeoutMs),
					}),
					fetch(`https://${this.#config.appDomain}/api/health`, {
						cache: "no-store",
						signal: AbortSignal.timeout(requestTimeoutMs),
					}),
					fetch(`https://${this.#config.gatewayDomain}/health`, {
						cache: "no-store",
						signal: AbortSignal.timeout(requestTimeoutMs),
					}),
				]);
				const frontendBody = await frontend.text();
				if (
					frontend.ok &&
					backend.ok &&
					gateway.ok &&
					frontendBody.includes(record.manifest.commit) &&
					backend.headers.get("x-useagent-release-fingerprint") ===
						`run-events-v1:${record.manifest.commit}` &&
					gateway.headers.get("x-useagent-release-fingerprint") ===
						`run-events-v1:${record.manifest.commit}`
				) {
					return true;
				}
			} catch {
				// TLS/DNS may converge shortly after the first Caddy activation.
			}
			await Bun.sleep(1000);
		}
		return false;
	}
}
