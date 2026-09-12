import {
	composeReleaseEnv,
	emptyReleaseHistory,
	type ReleaseHistory,
	type ReleaseManifest,
	type ReleaseRecord,
	validateReleaseManifest,
	validateReleaseRecord,
} from "./release-config";

export const systemdAdoptionPhases = [
	"preflight",
	"warm-edge",
	"close-admission",
	"drain-legacy-backend",
	"stop-legacy-backend",
	"start-target-backend",
	"switch-caddy",
	"verify-public",
	"disable-legacy-units",
	"commit-history",
	"open-admission",
	"admission-opened",
	"stop-legacy-edge",
	"compensate",
	"failed-closed",
] as const;

export type SystemdAdoptionPhase = (typeof systemdAdoptionPhases)[number];

export interface SystemdAdoptionJournal {
	version: 1;
	phase: SystemdAdoptionPhase;
	target: ReleaseRecord;
	legacyCommit: string;
	legacyUnitsEnabled: LegacyUnitEnablement;
	caddyBackupSha256: string;
	startedAt: string;
	updatedAt: string;
	error?: string;
}

export interface SystemdAdoptionInput {
	manifest: ReleaseManifest;
	legacyCommit: string;
	legacyUnitsEnabled: LegacyUnitEnablement;
	caddyBackupSha256: string;
}

export interface LegacyUnitEnablement {
	readonly backend: boolean;
	readonly gateway: boolean;
	readonly frontend: boolean;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateTimestamp(value: unknown, label: string): string {
	if (typeof value !== "string") throw new Error(`${label} must be a string`);
	const parsed = new Date(value);
	if (Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== value) {
		throw new Error(`${label} must be an ISO timestamp`);
	}
	return value;
}

export function validateSystemdAdoptionJournal(
	value: unknown,
): SystemdAdoptionJournal {
	if (!isObject(value))
		throw new Error("systemd adoption journal must be an object");
	const allowed = new Set([
		"version",
		"phase",
		"target",
		"legacyCommit",
		"legacyUnitsEnabled",
		"caddyBackupSha256",
		"startedAt",
		"updatedAt",
		"error",
	]);
	if (Object.keys(value).some((key) => !allowed.has(key))) {
		throw new Error("systemd adoption journal contains unknown fields");
	}
	if (value.version !== 1) {
		throw new Error("systemd adoption journal version must be 1");
	}
	if (
		typeof value.phase !== "string" ||
		!systemdAdoptionPhases.includes(value.phase as SystemdAdoptionPhase)
	) {
		throw new Error("systemd adoption journal phase is invalid");
	}
	if (!isObject(value.legacyUnitsEnabled)) {
		throw new Error("legacy unit enablement must be an object");
	}
	const unitEnablement = value.legacyUnitsEnabled;
	const unitKeys = Object.keys(unitEnablement).sort();
	if (
		unitKeys.join(",") !== "backend,frontend,gateway" ||
		unitKeys.some((key) => typeof unitEnablement[key] !== "boolean")
	) {
		throw new Error(
			"legacy unit enablement must contain backend, gateway, and frontend booleans",
		);
	}
	const legacyUnitsEnabled: LegacyUnitEnablement = {
		backend: unitEnablement.backend as boolean,
		gateway: unitEnablement.gateway as boolean,
		frontend: unitEnablement.frontend as boolean,
	};
	const target = validateReleaseRecord(value.target, "systemd adoption target");
	if (target.color !== "green") {
		throw new Error("systemd adoption target must use green");
	}
	if (
		typeof value.legacyCommit !== "string" ||
		!/^[a-f0-9]{40}$/.test(value.legacyCommit)
	) {
		throw new Error(
			"legacy commit must be exactly 40 lowercase hex characters",
		);
	}
	if (
		typeof value.caddyBackupSha256 !== "string" ||
		!/^[a-f0-9]{64}$/.test(value.caddyBackupSha256)
	) {
		throw new Error(
			"Caddy backup sha256 must be exactly 64 lowercase hex characters",
		);
	}
	if (value.error !== undefined && typeof value.error !== "string") {
		throw new Error("systemd adoption journal error must be a string");
	}
	return {
		version: 1,
		phase: value.phase as SystemdAdoptionPhase,
		target,
		legacyCommit: value.legacyCommit,
		legacyUnitsEnabled,
		caddyBackupSha256: value.caddyBackupSha256,
		startedAt: validateTimestamp(value.startedAt, "adoption startedAt"),
		updatedAt: validateTimestamp(value.updatedAt, "adoption updatedAt"),
		...(value.error === undefined ? {} : { error: value.error }),
	};
}

export interface SystemdAdoptionEffects {
	now(): string;
	loadHistory(): Promise<ReleaseHistory>;
	persistHistory(history: ReleaseHistory): Promise<void>;
	persistJournal(journal: SystemdAdoptionJournal | null): Promise<void>;
	preflight(target: ReleaseRecord): Promise<void>;
	warmTargetEdge(
		target: ReleaseRecord,
		env: Readonly<Record<string, string>>,
	): Promise<void>;
	stopTargetEdge(target: ReleaseRecord): Promise<void>;
	closeAdmission(timeoutMs?: number): Promise<void>;
	openAdmission(timeoutMs?: number): Promise<void>;
	drainLegacyBackend(timeoutMs: number): Promise<boolean>;
	legacyBackendHealthy(timeoutMs?: number): Promise<boolean>;
	stopLegacyBackend(timeoutMs?: number): Promise<void>;
	startLegacyBackend(timeoutMs?: number): Promise<void>;
	waitLegacyBackendHealthy(timeoutMs?: number): Promise<boolean>;
	targetBackendHealthy(
		target: ReleaseRecord,
		timeoutMs?: number,
	): Promise<boolean>;
	startTargetBackend(
		target: ReleaseRecord,
		env: Readonly<Record<string, string>>,
		timeoutMs?: number,
	): Promise<void>;
	stopTargetBackend(target: ReleaseRecord, timeoutMs?: number): Promise<void>;
	waitTargetBackendHealthy(
		target: ReleaseRecord,
		timeoutMs?: number,
	): Promise<boolean>;
	switchCaddyToTarget(target: ReleaseRecord, timeoutMs?: number): Promise<void>;
	restoreLegacyCaddy(timeoutMs?: number): Promise<void>;
	verifyTargetPublic(
		target: ReleaseRecord,
		timeoutMs?: number,
	): Promise<boolean>;
	verifyLegacyPublic(timeoutMs?: number): Promise<boolean>;
	disableLegacyUnits(): Promise<void>;
	restoreLegacyUnitEnablement(): Promise<void>;
	stopLegacyEdge(): Promise<void>;
}

export type SystemdAdoptionResult =
	| { status: "complete"; history: ReleaseHistory }
	| { status: "compensated"; history: ReleaseHistory; error: string }
	| {
			status: "failed-closed";
			history: ReleaseHistory;
			journal: SystemdAdoptionJournal;
			error: string;
	  };

const admissionWindowMs = 30_000;
const drainTimeoutMs = 10_000;
const stopTimeoutMs = 5_000;
const startTimeoutMs = 10_000;
const caddyTimeoutMs = 3_000;

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function adoptionHistory(
	target: ReleaseRecord,
	promotedAt: string,
): ReleaseHistory {
	return {
		version: 1,
		current: { ...target, promotedAt },
		previous: null,
		pending: null,
	};
}

function isEmptyHistory(history: ReleaseHistory): boolean {
	return !history.current && !history.previous && !history.pending;
}

function historyContainsTarget(
	history: ReleaseHistory,
	target: ReleaseRecord,
): boolean {
	return (
		history.current?.color === target.color &&
		history.current.manifest.commit === target.manifest.commit &&
		!history.pending
	);
}

async function persistPhase(
	effects: SystemdAdoptionEffects,
	journal: SystemdAdoptionJournal,
	phase: SystemdAdoptionPhase,
	error?: string,
): Promise<SystemdAdoptionJournal> {
	const next = {
		...journal,
		phase,
		updatedAt: effects.now(),
		...(error ? { error } : {}),
	};
	await effects.persistJournal(next);
	return next;
}

async function failClosed(
	effects: SystemdAdoptionEffects,
	journal: SystemdAdoptionJournal,
	history: ReleaseHistory,
	error: string,
): Promise<SystemdAdoptionResult> {
	const failed = await persistPhase(effects, journal, "failed-closed", error);
	return { status: "failed-closed", history, journal: failed, error };
}

async function finishForward(
	effects: SystemdAdoptionEffects,
	journal: SystemdAdoptionJournal,
): Promise<SystemdAdoptionResult> {
	const { target } = journal;
	await effects.closeAdmission();
	if (!(await effects.targetBackendHealthy(target))) {
		throw new Error("target backend is not healthy enough to finish adoption");
	}
	if (await effects.legacyBackendHealthy()) {
		await effects.stopLegacyBackend();
		if (await effects.legacyBackendHealthy()) {
			throw new Error(
				"legacy backend remained healthy while finishing adoption",
			);
		}
	}
	await effects.switchCaddyToTarget(target);
	if (!(await effects.verifyTargetPublic(target))) {
		throw new Error("target release is not publicly healthy");
	}
	await effects.disableLegacyUnits();
	const history = adoptionHistory(target, effects.now());
	await effects.persistHistory(history);
	await effects.openAdmission();
	await effects.stopLegacyEdge();
	await effects.persistJournal(null);
	return { status: "complete", history };
}

async function compensateToLegacy(
	effects: SystemdAdoptionEffects,
	journal: SystemdAdoptionJournal,
	error: string,
): Promise<SystemdAdoptionResult> {
	journal = await persistPhase(effects, journal, "compensate", error);
	try {
		await effects.closeAdmission();
		await effects.restoreLegacyUnitEnablement();

		let targetHealthy = await effects.targetBackendHealthy(journal.target);
		let legacyHealthy = await effects.legacyBackendHealthy();
		if (targetHealthy) {
			await effects.stopTargetBackend(journal.target);
			targetHealthy = await effects.targetBackendHealthy(journal.target);
		}
		if (targetHealthy) {
			throw new Error("target backend remained healthy during compensation");
		}
		if (!legacyHealthy) {
			await effects.startLegacyBackend();
			legacyHealthy = await effects.waitLegacyBackendHealthy();
		}
		if (!legacyHealthy) throw new Error("neither backend is healthy");

		await effects.restoreLegacyCaddy();
		if (!(await effects.verifyLegacyPublic())) {
			throw new Error("legacy public verification failed");
		}
		const history = emptyReleaseHistory();
		await effects.persistHistory(history);
		await effects.stopTargetEdge(journal.target);
		await effects.openAdmission();
		await effects.persistJournal(null);
		return { status: "compensated", history, error };
	} catch (recoveryError) {
		const recoveryMessage = errorMessage(recoveryError);
		return failClosed(
			effects,
			journal,
			await effects.loadHistory(),
			`${error}; ${recoveryMessage}`,
		);
	}
}

export async function recoverSystemdAdoption(
	effects: SystemdAdoptionEffects,
	journal: SystemdAdoptionJournal,
): Promise<SystemdAdoptionResult> {
	const history = await effects.loadHistory();
	if (journal.phase === "preflight" || journal.phase === "warm-edge") {
		await effects.stopTargetEdge(journal.target);
		await effects.persistJournal(null);
		return {
			status: "compensated",
			history,
			error:
				journal.error ?? `recovering interrupted adoption at ${journal.phase}`,
		};
	}
	if (
		historyContainsTarget(history, journal.target) &&
		(await effects.targetBackendHealthy(journal.target))
	) {
		try {
			return await finishForward(effects, journal);
		} catch (error) {
			await effects.persistHistory(emptyReleaseHistory());
			return compensateToLegacy(effects, journal, errorMessage(error));
		}
	}
	if (!isEmptyHistory(history)) {
		await effects.persistHistory(emptyReleaseHistory());
	}
	return compensateToLegacy(
		effects,
		journal,
		journal.error ?? `recovering interrupted adoption at ${journal.phase}`,
	);
}

export async function adoptSystemdDeployment(
	effects: SystemdAdoptionEffects,
	input: SystemdAdoptionInput,
): Promise<SystemdAdoptionResult> {
	const existing = await effects.loadHistory();
	if (!isEmptyHistory(existing)) {
		throw new Error("systemd adoption requires empty Compose release history");
	}
	if (!/^[a-f0-9]{40}$/.test(input.legacyCommit)) {
		throw new Error(
			"legacy commit must be exactly 40 lowercase hex characters",
		);
	}
	if (!/^[a-f0-9]{64}$/.test(input.caddyBackupSha256)) {
		throw new Error(
			"Caddy backup sha256 must be exactly 64 lowercase hex characters",
		);
	}
	const startedAt = effects.now();
	const target: ReleaseRecord = {
		manifest: validateReleaseManifest(input.manifest),
		color: "green",
		promotedAt: startedAt,
	};
	let journal: SystemdAdoptionJournal = {
		version: 1,
		phase: "preflight",
		target,
		legacyCommit: input.legacyCommit,
		legacyUnitsEnabled: input.legacyUnitsEnabled,
		caddyBackupSha256: input.caddyBackupSha256,
		startedAt,
		updatedAt: startedAt,
	};
	await effects.persistJournal(journal);

	try {
		await effects.preflight(target);
		journal = await persistPhase(effects, journal, "warm-edge");
		await effects.warmTargetEdge(
			target,
			composeReleaseEnv(target.manifest, target.color),
		);

		journal = await persistPhase(effects, journal, "close-admission");
		const admissionClosedAt = performance.now();
		const remainingAdmissionMs = (step: string): number => {
			const remaining = Math.floor(
				admissionWindowMs - (performance.now() - admissionClosedAt),
			);
			if (remaining <= 0) {
				throw new Error(`admission window exhausted before ${step}`);
			}
			return remaining;
		};
		await effects.closeAdmission(remainingAdmissionMs("admission close"));

		journal = await persistPhase(effects, journal, "drain-legacy-backend");
		if (
			!(await effects.drainLegacyBackend(
				Math.min(drainTimeoutMs, remainingAdmissionMs("legacy backend drain")),
			))
		) {
			throw new Error("legacy backend did not drain within 10000ms");
		}

		journal = await persistPhase(effects, journal, "stop-legacy-backend");
		await effects.stopLegacyBackend(
			Math.min(stopTimeoutMs, remainingAdmissionMs("legacy backend stop")),
		);
		if (await effects.legacyBackendHealthy()) {
			throw new Error("legacy backend remained healthy after stop");
		}

		journal = await persistPhase(effects, journal, "start-target-backend");
		await effects.startTargetBackend(
			target,
			composeReleaseEnv(target.manifest, target.color),
			Math.min(startTimeoutMs, remainingAdmissionMs("target backend start")),
		);
		if (
			!(await effects.waitTargetBackendHealthy(
				target,
				Math.min(startTimeoutMs, remainingAdmissionMs("target backend health")),
			))
		) {
			throw new Error("target backend did not become healthy");
		}

		journal = await persistPhase(effects, journal, "switch-caddy");
		await effects.switchCaddyToTarget(
			target,
			Math.min(caddyTimeoutMs, remainingAdmissionMs("Caddy switch")),
		);
		journal = await persistPhase(effects, journal, "verify-public");
		if (
			!(await effects.verifyTargetPublic(
				target,
				remainingAdmissionMs("public verification"),
			))
		) {
			throw new Error("target release public verification failed");
		}

		journal = await persistPhase(effects, journal, "disable-legacy-units");
		await effects.disableLegacyUnits();
		journal = await persistPhase(effects, journal, "commit-history");
		const history = adoptionHistory(target, effects.now());
		await effects.persistHistory(history);
		journal = await persistPhase(effects, journal, "open-admission");
		await effects.openAdmission(remainingAdmissionMs("admission reopen"));
		remainingAdmissionMs("admission reopened");
		journal = await persistPhase(effects, journal, "admission-opened");
		journal = await persistPhase(effects, journal, "stop-legacy-edge");
		await effects.stopLegacyEdge();
		await effects.persistJournal(null);
		return { status: "complete", history };
	} catch (error) {
		const message = errorMessage(error);
		return recoverSystemdAdoption(effects, { ...journal, error: message });
	}
}
