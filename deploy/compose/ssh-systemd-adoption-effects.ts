import { createHash } from "node:crypto";
import { dirname } from "node:path";
import {
	adoptLegacyCaddyUpstreams,
	classifyMigrations,
	emptyReleaseHistory,
	type ReleaseHistory,
	type ReleaseRecord,
	releasePorts,
	validateReleaseHistory,
} from "./release-config";
import {
	composePromotionCommand,
	type RemoteHost,
	releaseDirectory,
	type SshPromotionConfig,
	SshPromotionEffects,
} from "./ssh-promotion-effects";
import {
	type LegacyUnitEnablement,
	type SystemdAdoptionEffects,
	type SystemdAdoptionJournal,
	validateSystemdAdoptionJournal,
} from "./systemd-adoption";

export interface SshSystemdAdoptionConfig {
	readonly promotion: SshPromotionConfig;
	readonly legacyCommit: string;
	readonly legacySourceRoot: string;
	readonly journalPath: string;
	readonly legacyUnits: {
		readonly backend: string;
		readonly gateway: string;
		readonly frontend: string;
	};
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function parseMigrationInventory(output: string): Array<{
	readonly path: string;
	readonly contents: string;
}> {
	return output
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			const separator = line.indexOf("\t");
			if (separator <= 0)
				throw new Error("invalid legacy migration inventory row");
			return {
				path: line.slice(0, separator),
				contents: Buffer.from(line.slice(separator + 1), "base64").toString(
					"utf8",
				),
			};
		});
}

function backupPath(config: SshSystemdAdoptionConfig): string {
	return `${config.promotion.remoteRoot}/systemd-adoption-${config.legacyCommit}.Caddyfile`;
}

function unitList(config: SshSystemdAdoptionConfig): string {
	return [
		config.legacyUnits.backend,
		config.legacyUnits.gateway,
		config.legacyUnits.frontend,
	]
		.map(shellQuote)
		.join(" ");
}

export class SshSystemdAdoptionEffects implements SystemdAdoptionEffects {
	readonly #config: SshSystemdAdoptionConfig;
	readonly #remote: RemoteHost;
	readonly #target: ReleaseRecord;
	readonly #compose: SshPromotionEffects;
	readonly #operationId: string;
	readonly #crash: () => Promise<never>;
	#legacyUnitsEnabled: LegacyUnitEnablement | null;
	#caddyBackupSha256: string | null;
	admissionClosedAt: number | null = null;
	admissionOpenedAt: number | null = null;

	constructor(input: {
		readonly config: SshSystemdAdoptionConfig;
		readonly remote: RemoteHost;
		readonly target: ReleaseRecord;
		readonly composeFile: string;
		readonly caddyTemplate: string;
		readonly caddyBackupSha256?: string | null;
		readonly legacyUnitsEnabled?: LegacyUnitEnablement | null;
		readonly crash: () => Promise<never>;
	}) {
		this.#config = input.config;
		this.#remote = input.remote;
		this.#target = input.target;
		this.#operationId = `adopt-systemd:${input.target.manifest.commit}:green`;
		this.#caddyBackupSha256 = input.caddyBackupSha256 ?? null;
		this.#legacyUnitsEnabled = input.legacyUnitsEnabled ?? null;
		this.#crash = input.crash;
		this.#compose = new SshPromotionEffects({
			config: input.config.promotion,
			remote: input.remote,
			history: emptyReleaseHistory(),
			target: input.target,
			kind: "promote",
			composeFile: input.composeFile,
			caddyTemplate: input.caddyTemplate,
			operationId: this.#operationId,
			crash: input.crash,
		});
	}

	now(): string {
		return new Date().toISOString();
	}

	async captureLegacyCaddy(): Promise<string> {
		const live = await this.#remote.readOptional(
			this.#config.promotion.caddyConfigPath,
		);
		if (!live) throw new Error("legacy Caddy configuration is missing");
		const digest = sha256(live);
		await this.#remote.writeAtomic(backupPath(this.#config), live, "600");
		this.#caddyBackupSha256 = digest;
		return digest;
	}

	async captureLegacyUnitEnablement(): Promise<LegacyUnitEnablement> {
		const capture = async (unit: string): Promise<boolean> => {
			const result = await this.#remote.run(
				`systemctl is-enabled ${shellQuote(unit)}`,
				{ allowFailure: true, timeoutMs: 5_000 },
			);
			const state = result.stdout.trim();
			if (state === "enabled") return true;
			if (state === "disabled") return false;
			throw new Error(
				`legacy unit ${unit} has unsupported enablement ${state}`,
			);
		};
		const [backend, gateway, frontend] = await Promise.all([
			capture(this.#config.legacyUnits.backend),
			capture(this.#config.legacyUnits.gateway),
			capture(this.#config.legacyUnits.frontend),
		]);
		const captured = { backend, gateway, frontend };
		this.#legacyUnitsEnabled = captured;
		return captured;
	}

	async #assertLegacyCaddyUnchanged(): Promise<string> {
		const live = await this.#remote.readOptional(
			this.#config.promotion.caddyConfigPath,
		);
		if (!live || sha256(live) !== this.#caddyBackupSha256) {
			throw new Error("live Caddy config changed after adoption capture");
		}
		return live;
	}

	async #caddyState(target: ReleaseRecord): Promise<"legacy" | "target"> {
		const live = await this.#remote.readOptional(
			this.#config.promotion.caddyConfigPath,
		);
		if (!live) throw new Error("live Caddy configuration is missing");
		if (sha256(live) === this.#caddyBackupSha256) return "legacy";
		const staged = await this.#remote.readOptional(
			`${releaseDirectory(this.#config.promotion, target)}/Caddyfile`,
		);
		if (staged && sha256(live) === sha256(staged)) return "target";
		throw new Error("live Caddy config drifted outside the adoption journal");
	}

	async loadJournal(): Promise<SystemdAdoptionJournal | null> {
		const text = await this.#remote.readOptional(this.#config.journalPath);
		return text ? validateSystemdAdoptionJournal(JSON.parse(text)) : null;
	}

	async loadHistory(): Promise<ReleaseHistory> {
		const text = await this.#remote.readOptional(
			this.#config.promotion.historyPath,
		);
		return text
			? validateReleaseHistory(JSON.parse(text))
			: emptyReleaseHistory();
	}

	async persistHistory(history: ReleaseHistory): Promise<void> {
		await this.#remote.writeAtomic(
			this.#config.promotion.historyPath,
			`${JSON.stringify(history, null, 2)}\n`,
		);
	}

	async persistJournal(journal: SystemdAdoptionJournal | null): Promise<void> {
		if (journal) {
			await this.#remote.writeAtomic(
				this.#config.journalPath,
				`${JSON.stringify(journal, null, 2)}\n`,
			);
			return;
		}
		await this.#remote.run(
			`rm -f -- ${shellQuote(this.#config.journalPath)}; ` +
				`sync -f ${shellQuote(dirname(this.#config.journalPath))}`,
		);
	}

	async #legacyDirectHealthy(
		service: "backend" | "gateway" | "frontend",
		timeoutMs = 3_000,
	): Promise<boolean> {
		const path = service === "frontend" ? "/healthz" : "/api/health";
		const port = releasePorts("blue")[service];
		const result = await this.#remote.run(
			`curl --connect-timeout 1 --max-time 2 -fsS -D - ` +
				`http://127.0.0.1:${port}${path}`,
			{ allowFailure: true, timeoutMs },
		);
		return (
			result.code === 0 &&
			result.stdout.includes(this.#config.legacyCommit) &&
			(service === "frontend" ||
				result.stdout
					.toLowerCase()
					.includes(`run-events-v1:${this.#config.legacyCommit}`))
		);
	}

	async #prepareWritablePaths(target: ReleaseRecord): Promise<void> {
		const image = target.manifest.backend;
		const mounts = [
			{
				host: "/var/lib/useagent/artifacts",
				container: "/app/backend/.artifacts",
			},
			{ host: "/var/lib/useagent/runs", container: "/app/backend/.runs" },
			{
				host: "/var/lib/useagent/slack-uploads",
				container: "/app/backend/.slack-uploads",
			},
			{
				host: "/var/lib/useagent/codex-app-server",
				container: "/var/lib/useagent/codex-app-server",
			},
			{
				host: "/opt/useagent/pi-runtime",
				container: "/opt/useagent/pi-runtime",
			},
		];
		await this.#remote.run(
			`uid=$(docker run --rm --entrypoint id ${shellQuote(image)} -u); ` +
				`gid=$(docker run --rm --entrypoint id ${shellQuote(image)} -g); ` +
				mounts
					.map(
						(mount) =>
							`if ! test -d ${shellQuote(mount.host)}; then ` +
							`install -d -o "$uid" -g "$gid" -m 0770 ${shellQuote(mount.host)}; fi`,
					)
					.join("; "),
		);
		const sentinel = `.useagent-adoption-${target.manifest.commit}`;
		const script =
			"set -eu; command -v bun >/dev/null; command -v codex >/dev/null; " +
			mounts
				.map(
					(mount) =>
						`probe=${shellQuote(`${mount.container}/${sentinel}`)}; ` +
						`: > "$probe"; rm -f "$probe"`,
				)
				.join("; ");
		await this.#remote.run(
			composePromotionCommand(
				this.#config.promotion,
				target,
				`run --rm --no-deps --entrypoint sh backend -c ${shellQuote(script)}`,
			),
		);
	}

	async #validateLegacyMigrations(target: ReleaseRecord): Promise<void> {
		const script =
			`for file in ${shellQuote(`${this.#config.legacySourceRoot}/backend/drizzle`)}/*.sql; do ` +
			`[ -f "$file" ] || continue; printf "%s\\t" "$(basename "$file")"; ` +
			`base64 -w0 "$file"; printf "\\n"; done`;
		const legacy = parseMigrationInventory(
			(await this.#remote.run(script)).stdout,
		);
		const targetFiles = await this.#compose.migrationInventory(
			target.manifest.backend,
		);
		const decision = classifyMigrations(legacy, targetFiles);
		if (!decision.forwardSafe) {
			throw new Error(
				`legacy migration transition is not expansion-safe: ${JSON.stringify(decision)}`,
			);
		}
	}

	async preflight(target: ReleaseRecord): Promise<void> {
		if (target.color !== "green") {
			throw new Error("systemd adoption target must use green");
		}
		const history = await this.loadHistory();
		if (history.current || history.previous || history.pending) {
			throw new Error(
				"systemd adoption requires empty Compose release history",
			);
		}
		await this.#remote.run(
			`test -z "$(docker ps --filter label=io.useagent.release.service=backend -q)"; ` +
				`for unit in ${unitList(this.#config)}; do ` +
				`systemctl is-active --quiet "$unit"; done`,
		);
		const green = releasePorts("green");
		await this.#remote.run(
			[green.backend, green.gateway, green.frontend]
				.map(
					(port) => `! ss -ltn '( sport = :${port} )' | tail -n +2 | grep -q .`,
				)
				.join(" && "),
		);
		const healthy = await Promise.all([
			this.#legacyDirectHealthy("backend"),
			this.#legacyDirectHealthy("gateway"),
			this.#legacyDirectHealthy("frontend"),
		]);
		if (healthy.some((value) => !value)) {
			throw new Error("legacy service fingerprints do not match legacy commit");
		}
		const backup = await this.#remote.readOptional(backupPath(this.#config));
		if (!backup || sha256(backup) !== this.#caddyBackupSha256) {
			throw new Error("legacy Caddy backup hash does not match the journal");
		}
		await this.#assertLegacyCaddyUnchanged();
		const blue = releasePorts("blue");
		const markerized = adoptLegacyCaddyUpstreams(
			backup,
			{
				backend: `127.0.0.1:${blue.backend}`,
				gateway: `127.0.0.1:${blue.gateway}`,
				frontend: `127.0.0.1:${blue.frontend}`,
			},
			{
				backend: `127.0.0.1:${green.backend}`,
				gateway: `127.0.0.1:${green.gateway}`,
				frontend: `127.0.0.1:${green.frontend}`,
			},
		);
		await this.#compose.prepareRelease(target, {
			allowLegacyBlue: true,
			applyMigrations: false,
			caddyConfig: markerized,
		});
		await this.#validateLegacyMigrations(target);
		await this.#compose.applyMigrations(target);
		await this.#prepareWritablePaths(target);
	}

	async warmTargetEdge(target: ReleaseRecord): Promise<void> {
		await this.#compose.warmEdge(target);
	}

	async stopTargetEdge(target: ReleaseRecord): Promise<void> {
		await this.#compose.stopEdge(target);
	}

	async #legacyAdmission(
		action: "open" | "close",
		timeoutMs = 10_000,
	): Promise<void> {
		const script = `${this.#config.legacySourceRoot}/deploy/hetzner/deployment-admission.ts`;
		await this.#remote.run(
			`set -a; . ${shellQuote(this.#config.promotion.backendEnvFile)}; set +a; ` +
				`DEPLOYMENT_OPERATION_ID=${shellQuote(this.#operationId)} ` +
				`DEPLOYMENT_ACTOR=compose-adoption ` +
				`DEPLOYMENT_REASON=${shellQuote("one-time systemd to Compose adoption")} ` +
				`/usr/local/bin/bun run ${shellQuote(script)} ${action}`,
			{ timeoutMs },
		);
	}

	async closeAdmission(timeoutMs = 10_000): Promise<void> {
		const startedAt = Date.now();
		await this.#legacyAdmission("close", timeoutMs);
		this.admissionClosedAt ??= startedAt;
	}

	async openAdmission(timeoutMs = 10_000): Promise<void> {
		if (
			await this.targetBackendHealthy(this.#target, Math.min(2_000, timeoutMs))
		) {
			await this.#compose.openAdmission(timeoutMs);
		} else {
			await this.#legacyAdmission("open", timeoutMs);
		}
		this.admissionOpenedAt = Date.now();
	}

	async drainLegacyBackend(timeoutMs: number): Promise<boolean> {
		const deadline = Date.now() + timeoutMs;
		const source =
			`(async()=>{const m=await import('${this.#config.legacySourceRoot}/backend/src/commands/admission.ts');` +
			`console.log(JSON.stringify(await m.deploymentInflightSnapshot()));` +
			`const d=await import('${this.#config.legacySourceRoot}/backend/src/db/client.ts');` +
			`await d.client.end({timeout:5})})()`;
		while (Date.now() < deadline) {
			const remaining = Math.max(1, deadline - Date.now());
			const result = await this.#remote.run(
				`set -a; . ${shellQuote(this.#config.promotion.backendEnvFile)}; set +a; ` +
					`/usr/local/bin/bun -e ${shellQuote(source)}`,
				{ timeoutMs: remaining },
			);
			const snapshot = JSON.parse(result.stdout) as { count?: unknown };
			if (snapshot.count === 0) return true;
			await Bun.sleep(Math.min(1_000, Math.max(1, deadline - Date.now())));
		}
		return false;
	}

	async legacyBackendHealthy(timeoutMs = 2_000): Promise<boolean> {
		return this.#legacyDirectHealthy("backend", timeoutMs);
	}

	async stopLegacyBackend(timeoutMs = 30_000): Promise<void> {
		await this.#remote.run(
			`systemctl stop ${shellQuote(this.#config.legacyUnits.backend)}`,
			{ timeoutMs },
		);
		if (this.#config.promotion.crashAfter === "source-backend-stopped") {
			await this.#crash();
		}
	}

	async startLegacyBackend(timeoutMs = 30_000): Promise<void> {
		await this.#remote.run(
			`systemctl start ${shellQuote(this.#config.legacyUnits.backend)}`,
			{ timeoutMs },
		);
	}

	async waitLegacyBackendHealthy(timeoutMs = 30_000): Promise<boolean> {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			if (
				await this.legacyBackendHealthy(Math.min(2_000, deadline - Date.now()))
			) {
				return true;
			}
			await Bun.sleep(Math.min(1_000, Math.max(1, deadline - Date.now())));
		}
		return false;
	}

	async targetBackendHealthy(
		target: ReleaseRecord,
		timeoutMs = 2_000,
	): Promise<boolean> {
		return this.#compose.backendHealthy(target, timeoutMs);
	}

	async startTargetBackend(
		target: ReleaseRecord,
		env: Readonly<Record<string, string>>,
		timeoutMs = 60_000,
	): Promise<void> {
		await this.#compose.startBackend(target, env, timeoutMs);
	}

	async stopTargetBackend(
		target: ReleaseRecord,
		timeoutMs = 60_000,
	): Promise<void> {
		await this.#compose.stopBackend(target, timeoutMs);
	}

	async waitTargetBackendHealthy(
		target: ReleaseRecord,
		timeoutMs = 60_000,
	): Promise<boolean> {
		return this.#compose.waitBackendHealthy(target, timeoutMs);
	}

	async switchCaddyToTarget(
		target: ReleaseRecord,
		timeoutMs = 10_000,
	): Promise<void> {
		if ((await this.#caddyState(target)) === "legacy") {
			await this.#compose.switchCaddy(target, timeoutMs);
		}
	}

	async restoreLegacyCaddy(timeoutMs = 10_000): Promise<void> {
		const backup = backupPath(this.#config);
		const live = this.#config.promotion.caddyConfigPath;
		const command =
			`test "$(sha256sum ${shellQuote(backup)} | cut -d' ' -f1)" = ` +
			`${shellQuote(this.#caddyBackupSha256 ?? "")}; ` +
			`install -o root -g root -m 644 ${shellQuote(backup)} ${shellQuote(`${live}.next`)}; ` +
			`set -a; if test -f ${shellQuote(this.#config.promotion.caddyEnvFile)}; then . ` +
			`${shellQuote(this.#config.promotion.caddyEnvFile)}; fi; set +a; ` +
			`caddy validate --config ${shellQuote(`${live}.next`)}; ` +
			`mv -f ${shellQuote(`${live}.next`)} ${shellQuote(live)}; ` +
			`systemctl reload caddy`;
		await this.#remote.run(command, { timeoutMs });
	}

	async verifyTargetPublic(
		target: ReleaseRecord,
		timeoutMs = 90_000,
	): Promise<boolean> {
		return this.#compose.verifyPublic(target, timeoutMs);
	}

	async verifyLegacyPublic(timeoutMs = 30_000): Promise<boolean> {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			try {
				const requestTimeout = Math.max(
					1,
					Math.min(2_000, deadline - Date.now()),
				);
				const [frontend, backend, gateway] = await Promise.all([
					fetch(`https://${this.#config.promotion.appDomain}/healthz`, {
						signal: AbortSignal.timeout(requestTimeout),
					}),
					fetch(`https://${this.#config.promotion.appDomain}/api/health`, {
						signal: AbortSignal.timeout(requestTimeout),
					}),
					fetch(`https://${this.#config.promotion.gatewayDomain}/api/health`, {
						signal: AbortSignal.timeout(requestTimeout),
					}),
				]);
				const frontendBody = await frontend.text();
				if (
					frontend.ok &&
					backend.ok &&
					gateway.ok &&
					frontendBody.includes(this.#config.legacyCommit) &&
					backend.headers.get("x-useagent-release-fingerprint") ===
						`run-events-v1:${this.#config.legacyCommit}` &&
					gateway.headers.get("x-useagent-release-fingerprint") ===
						`run-events-v1:${this.#config.legacyCommit}`
				) {
					return true;
				}
			} catch {
				// The restored service may need a bounded moment to become reachable.
			}
			await Bun.sleep(Math.min(1_000, Math.max(1, deadline - Date.now())));
		}
		return false;
	}

	async disableLegacyUnits(): Promise<void> {
		await this.#remote.run(`systemctl disable ${unitList(this.#config)}`);
	}

	async restoreLegacyUnitEnablement(): Promise<void> {
		if (!this.#legacyUnitsEnabled) {
			throw new Error("legacy unit enablement is unavailable for recovery");
		}
		for (const service of ["backend", "gateway", "frontend"] as const) {
			await this.#remote.run(
				`systemctl ${this.#legacyUnitsEnabled[service] ? "enable" : "disable"} ` +
					shellQuote(this.#config.legacyUnits[service]),
			);
		}
	}

	async stopLegacyEdge(): Promise<void> {
		await this.#remote.run(
			`systemctl stop ${shellQuote(this.#config.legacyUnits.frontend)} ` +
				`${shellQuote(this.#config.legacyUnits.gateway)}`,
		);
	}
}
