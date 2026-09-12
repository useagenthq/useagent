import {
	advanceOperation,
	beginOperation,
	commitOperation,
	composeReleaseEnv,
	finishOperation,
	type PendingOperationPhase,
	planNextRelease,
	type ReleaseHistory,
	type ReleaseManifest,
	type ReleaseRecord,
} from "./release-config";

export interface PromotionEffects {
	now(): string;
	persistHistory(history: ReleaseHistory): Promise<void>;
	preflight(record: ReleaseRecord): Promise<void>;
	warmEdge(
		record: ReleaseRecord,
		env: Readonly<Record<string, string>>,
	): Promise<void>;
	stopEdge(record: ReleaseRecord): Promise<void>;
	closeAdmission(timeoutMs?: number): Promise<void>;
	openAdmission(timeoutMs?: number): Promise<void>;
	drainBackend(timeoutMs: number): Promise<boolean>;
	backendHealthy(record: ReleaseRecord, timeoutMs?: number): Promise<boolean>;
	stopBackend(record: ReleaseRecord, timeoutMs?: number): Promise<void>;
	startBackend(
		record: ReleaseRecord,
		env: Readonly<Record<string, string>>,
		timeoutMs?: number,
	): Promise<void>;
	waitBackendHealthy(
		record: ReleaseRecord,
		timeoutMs?: number,
	): Promise<boolean>;
	switchCaddy(record: ReleaseRecord, timeoutMs?: number): Promise<void>;
	verifyPublic(record: ReleaseRecord, timeoutMs?: number): Promise<boolean>;
}

export type PromotionResult =
	| { status: "complete"; history: ReleaseHistory }
	| { status: "compensated"; history: ReleaseHistory; error: string }
	| { status: "failed-closed"; history: ReleaseHistory; error: string };

const admissionWindowMs = 30_000;
const drainTimeoutMs = 10_000;
const stopTimeoutMs = 5_000;
const startTimeoutMs = 10_000;
const caddyTimeoutMs = 3_000;

async function persistPhase(
	effects: PromotionEffects,
	history: ReleaseHistory,
	phase: PendingOperationPhase,
	error?: string,
): Promise<ReleaseHistory> {
	const next = advanceOperation(history, phase, effects.now(), error);
	await effects.persistHistory(next);
	return next;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function markFailedClosed(
	effects: PromotionEffects,
	history: ReleaseHistory,
	error: string,
): Promise<PromotionResult> {
	const failed = await persistPhase(effects, history, "failed-closed", error);
	return { status: "failed-closed", history: failed, error };
}

export async function compensatePromotion(
	effects: PromotionEffects,
	history: ReleaseHistory,
	error: string,
	admissionClosed: boolean,
): Promise<PromotionResult> {
	const pending = history.pending;
	if (!pending)
		throw new Error("cannot compensate without a pending release operation");
	history = await persistPhase(effects, history, "compensate", error);

	if (!admissionClosed) {
		await effects.stopEdge(pending.to);
		const clean = finishOperation(history);
		await effects.persistHistory(clean);
		return { status: "compensated", history: clean, error };
	}

	let targetHealthy = await effects.backendHealthy(pending.to);
	let previousHealthy = pending.from
		? await effects.backendHealthy(pending.from)
		: false;
	// A process can die after the durable `open-admission` phase is written but
	// after the admission mutation itself succeeds. Re-closing is idempotent and
	// restores the barrier before compensation touches a live backend. If both
	// backends are down, no process can accept work and recovery can safely bring
	// the previous backend back before reopening it.
	if (targetHealthy || previousHealthy) await effects.closeAdmission();

	if (pending.from && !previousHealthy) {
		if (targetHealthy) {
			await effects.stopBackend(pending.to);
			targetHealthy = false;
		}
		await effects.startBackend(
			pending.from,
			composeReleaseEnv(pending.from.manifest, pending.from.color),
		);
		previousHealthy = await effects.waitBackendHealthy(pending.from);
	}

	if (pending.from && previousHealthy) {
		if (targetHealthy) await effects.stopBackend(pending.to);
		await effects.switchCaddy(pending.from);
		if (!(await effects.verifyPublic(pending.from))) {
			return markFailedClosed(
				effects,
				history,
				`${error}; compensation public verification failed`,
			);
		}
		await effects.stopEdge(pending.to);
		if (history.current?.manifest.commit === pending.to.manifest.commit) {
			history = {
				...history,
				current: pending.from,
				previous: pending.to,
			};
			await effects.persistHistory(history);
		}
		await effects.openAdmission();
		const clean = finishOperation(history);
		await effects.persistHistory(clean);
		return { status: "compensated", history: clean, error };
	}

	// Bootstrap has no prior backend. If the target is healthy, finish the
	// verified cutover rather than taking down the only healthy backend.
	if (!pending.from && targetHealthy) {
		await effects.switchCaddy(pending.to);
		if (await effects.verifyPublic(pending.to)) {
			history = commitOperation(history, effects.now());
			await effects.persistHistory(history);
			await effects.openAdmission();
			const clean = finishOperation(history);
			await effects.persistHistory(clean);
			return { status: "complete", history: clean };
		}
	}

	return markFailedClosed(
		effects,
		history,
		`${error}; no healthy backend available for recovery`,
	);
}

async function executeOperation(
	effects: PromotionEffects,
	history: ReleaseHistory,
	kind: "promote" | "rollback",
	target: ReleaseRecord,
): Promise<PromotionResult> {
	history = beginOperation(history, kind, target, effects.now());
	await effects.persistHistory(history);
	let admissionClosed = false;

	try {
		// Preflight and edge warming are deliberately outside the admission-closed
		// window. They may be expensive but cannot affect the single DB writer.
		await effects.preflight(target);
		history = await persistPhase(effects, history, "warm-edge");
		await effects.warmEdge(
			target,
			composeReleaseEnv(target.manifest, target.color),
		);
		if (await effects.backendHealthy(target)) {
			await effects.stopBackend(target);
			if (await effects.backendHealthy(target)) {
				throw new Error("inactive backend remained healthy after stop");
			}
		}

		history = await persistPhase(effects, history, "close-admission");
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
		admissionClosed = true;

		history = await persistPhase(effects, history, "drain-backend");
		if (
			!(await effects.drainBackend(
				Math.min(drainTimeoutMs, remainingAdmissionMs("backend drain")),
			))
		) {
			throw new Error(`backend did not drain within ${drainTimeoutMs}ms`);
		}

		const active = history.pending?.from;
		if (active) {
			history = await persistPhase(effects, history, "stop-active-backend");
			await effects.stopBackend(
				active,
				Math.min(stopTimeoutMs, remainingAdmissionMs("active backend stop")),
			);
			if (await effects.backendHealthy(active)) {
				throw new Error("active backend remained healthy after stop");
			}
		}

		history = await persistPhase(effects, history, "start-target-backend");
		await effects.startBackend(
			target,
			composeReleaseEnv(target.manifest, target.color),
			Math.min(startTimeoutMs, remainingAdmissionMs("target backend start")),
		);
		if (
			!(await effects.waitBackendHealthy(
				target,
				Math.min(startTimeoutMs, remainingAdmissionMs("target backend health")),
			))
		) {
			throw new Error("target backend did not become healthy");
		}

		history = await persistPhase(effects, history, "switch-caddy");
		await effects.switchCaddy(
			target,
			Math.min(caddyTimeoutMs, remainingAdmissionMs("Caddy switch")),
		);
		history = await persistPhase(effects, history, "verify-public");
		if (
			!(await effects.verifyPublic(
				target,
				remainingAdmissionMs("public verification"),
			))
		) {
			throw new Error("public release verification failed");
		}

		history = await persistPhase(effects, history, "commit-history");
		history = commitOperation(history, effects.now());
		await effects.persistHistory(history);
		await effects.openAdmission(remainingAdmissionMs("admission reopen"));
		remainingAdmissionMs("admission reopened");
		history = await persistPhase(effects, history, "admission-opened");

		const oldEdge = history.pending?.from;
		if (oldEdge) {
			history = await persistPhase(effects, history, "stop-old-edge");
			await effects.stopEdge(oldEdge);
		}
		const complete = finishOperation(history);
		await effects.persistHistory(complete);
		return { status: "complete", history: complete };
	} catch (error) {
		return compensatePromotion(
			effects,
			history,
			errorMessage(error),
			admissionClosed,
		);
	}
}

export async function promote(
	effects: PromotionEffects,
	history: ReleaseHistory,
	manifest: ReleaseManifest,
): Promise<PromotionResult> {
	const plan = planNextRelease(history);
	const promotedAt = effects.now();
	return executeOperation(effects, history, "promote", {
		manifest,
		color: plan.targetColor,
		promotedAt,
	});
}

export async function rollback(
	effects: PromotionEffects,
	history: ReleaseHistory,
): Promise<PromotionResult> {
	if (!history.current || !history.previous) {
		throw new Error("rollback requires current and previous releases");
	}
	if (history.current.color === history.previous.color) {
		throw new Error("rollback target must use the inactive release color");
	}
	return executeOperation(effects, history, "rollback", {
		...history.previous,
		promotedAt: effects.now(),
	});
}
