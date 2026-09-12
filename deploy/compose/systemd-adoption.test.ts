import { describe, expect, test } from "bun:test";
import {
	emptyReleaseHistory,
	type ReleaseHistory,
	type ReleaseManifest,
	type ReleaseRecord,
} from "./release-config";
import {
	adoptSystemdDeployment,
	recoverSystemdAdoption,
	type SystemdAdoptionEffects,
	type SystemdAdoptionJournal,
	validateSystemdAdoptionJournal,
} from "./systemd-adoption";

const image = (name: string, character: string) =>
	`${name}@sha256:${character.repeat(64)}`;
const manifest: ReleaseManifest = {
	commit: "2".repeat(40),
	backend: image("registry.example/backend", "2"),
	gateway: image("registry.example/gateway", "2"),
	frontend: image("registry.example/frontend", "2"),
};
const input = {
	manifest,
	legacyCommit: "1".repeat(40),
	legacyUnitsEnabled: { backend: false, gateway: true, frontend: false },
	caddyBackupSha256: "a".repeat(64),
};

class FakeEffects implements SystemdAdoptionEffects {
	readonly events: string[] = [];
	history: ReleaseHistory = emptyReleaseHistory();
	journal: SystemdAdoptionJournal | null = null;
	legacyHealthy = true;
	targetHealthy = false;
	targetPublic = true;
	legacyPublic = true;
	drainResult = true;
	failAt: string | null = null;
	nowCount = 0;

	private event(name: string) {
		this.events.push(name);
		if (this.failAt === name) throw new Error(`failed at ${name}`);
	}
	now() {
		return `2026-09-02T00:00:${String(this.nowCount++).padStart(2, "0")}.000Z`;
	}
	async loadHistory() {
		return structuredClone(this.history);
	}
	async persistHistory(history: ReleaseHistory) {
		this.event(`history:${history.current?.color ?? "empty"}`);
		this.history = structuredClone(history);
	}
	async persistJournal(journal: SystemdAdoptionJournal | null) {
		this.event(`journal:${journal?.phase ?? "clear"}`);
		this.journal = journal ? structuredClone(journal) : null;
	}
	async preflight() {
		this.event("preflight");
	}
	async warmTargetEdge() {
		this.event("edge:warm-target");
	}
	async stopTargetEdge() {
		this.event("edge:stop-target");
	}
	async closeAdmission() {
		this.event("admission:close");
	}
	async openAdmission() {
		this.event("admission:open");
	}
	async drainLegacyBackend(timeoutMs: number) {
		this.event(`legacy:drain:${timeoutMs}`);
		return this.drainResult;
	}
	async legacyBackendHealthy() {
		return this.legacyHealthy;
	}
	async stopLegacyBackend() {
		this.event("legacy:stop-backend");
		this.legacyHealthy = false;
	}
	async startLegacyBackend() {
		this.event("legacy:start-backend");
		if (this.failAt !== "legacy:stay-down") this.legacyHealthy = true;
	}
	async waitLegacyBackendHealthy() {
		return this.legacyHealthy;
	}
	async targetBackendHealthy() {
		return this.targetHealthy;
	}
	async startTargetBackend() {
		this.event("target:start-backend");
		if (this.failAt !== "target:stay-down") this.targetHealthy = true;
	}
	async stopTargetBackend() {
		this.event("target:stop-backend");
		this.targetHealthy = false;
	}
	async waitTargetBackendHealthy() {
		return this.targetHealthy;
	}
	async switchCaddyToTarget() {
		this.event("caddy:target");
	}
	async restoreLegacyCaddy() {
		this.event("caddy:legacy");
	}
	async verifyTargetPublic() {
		this.event("public:target");
		return this.targetPublic;
	}
	async verifyLegacyPublic() {
		this.event("public:legacy");
		return this.legacyPublic;
	}
	async disableLegacyUnits() {
		this.event("legacy:disable-units");
	}
	async restoreLegacyUnitEnablement() {
		this.event("legacy:restore-unit-enablement");
	}
	async stopLegacyEdge() {
		this.event("legacy:stop-edge");
	}
}

function interruptedJournal(
	phase: SystemdAdoptionJournal["phase"],
): SystemdAdoptionJournal {
	const target: ReleaseRecord = {
		manifest,
		color: "green",
		promotedAt: "2026-09-02T00:00:00.000Z",
	};
	return {
		version: 1,
		phase,
		target,
		legacyCommit: input.legacyCommit,
		legacyUnitsEnabled: input.legacyUnitsEnabled,
		caddyBackupSha256: input.caddyBackupSha256,
		startedAt: "2026-09-02T00:00:00.000Z",
		updatedAt: "2026-09-02T00:00:01.000Z",
	};
}

describe("systemd adoption", () => {
	test("warms green edge before a bounded single-backend cutover", async () => {
		const effects = new FakeEffects();
		const result = await adoptSystemdDeployment(effects, input);
		expect(result.status).toBe("complete");
		expect(result.history.current?.color).toBe("green");
		expect(effects.events.indexOf("edge:warm-target")).toBeLessThan(
			effects.events.indexOf("admission:close"),
		);
		expect(effects.events.indexOf("legacy:stop-backend")).toBeLessThan(
			effects.events.indexOf("target:start-backend"),
		);
		expect(effects.events.indexOf("public:target")).toBeLessThan(
			effects.events.indexOf("history:green"),
		);
		expect(effects.events.indexOf("history:green")).toBeLessThan(
			effects.events.indexOf("admission:open"),
		);
		expect(effects.events.indexOf("admission:open")).toBeLessThan(
			effects.events.indexOf("legacy:stop-edge"),
		);
		expect(effects.legacyHealthy).toBe(false);
		expect(effects.targetHealthy).toBe(true);
		expect(effects.journal).toBeNull();
	});

	test("a preflight failure leaves legacy serving without closing admission", async () => {
		const effects = new FakeEffects();
		effects.failAt = "preflight";
		const result = await adoptSystemdDeployment(effects, input);
		expect(result.status).toBe("compensated");
		expect(effects.events).not.toContain("admission:close");
		expect(effects.events).toContain("edge:stop-target");
		expect(effects.legacyHealthy).toBe(true);
		expect(effects.history).toEqual(emptyReleaseHistory());
	});

	test("a pre-cutover crash recovery also leaves admission and legacy untouched", async () => {
		const effects = new FakeEffects();
		const result = await recoverSystemdAdoption(
			effects,
			interruptedJournal("warm-edge"),
		);
		expect(result.status).toBe("compensated");
		expect(effects.events).not.toContain("admission:close");
		expect(effects.events).toContain("edge:stop-target");
		expect(effects.legacyHealthy).toBe(true);
	});

	test("a failure after admission closes reopens on the untouched legacy backend", async () => {
		const effects = new FakeEffects();
		effects.drainResult = false;
		const result = await adoptSystemdDeployment(effects, input);
		expect(result.status).toBe("compensated");
		expect(effects.events).not.toContain("legacy:stop-backend");
		expect(effects.events.indexOf("public:legacy")).toBeLessThan(
			effects.events.indexOf("admission:open"),
		);
		expect(effects.legacyHealthy).toBe(true);
	});

	test("a target failure after legacy stops restores legacy before reopening", async () => {
		const effects = new FakeEffects();
		effects.failAt = "target:stay-down";
		const result = await adoptSystemdDeployment(effects, input);
		expect(result.status).toBe("compensated");
		expect(effects.events).toContain("legacy:start-backend");
		expect(effects.events.indexOf("caddy:legacy")).toBeLessThan(
			effects.events.indexOf("admission:open"),
		);
		expect(effects.legacyHealthy).toBe(true);
		expect(effects.targetHealthy).toBe(false);
	});

	test("a public failure after the Caddy switch restores Caddy and legacy", async () => {
		const effects = new FakeEffects();
		effects.targetPublic = false;
		const result = await adoptSystemdDeployment(effects, input);
		expect(result.status).toBe("compensated");
		expect(effects.events).toContain("caddy:target");
		expect(effects.events).toContain("target:stop-backend");
		expect(effects.events).toContain("caddy:legacy");
		expect(effects.history).toEqual(emptyReleaseHistory());
	});

	test("recovery finishes forward after history commits while target is healthy", async () => {
		const effects = new FakeEffects();
		const journal = interruptedJournal("open-admission");
		effects.history = {
			version: 1,
			current: journal.target,
			previous: null,
			pending: null,
		};
		effects.legacyHealthy = false;
		effects.targetHealthy = true;
		const result = await recoverSystemdAdoption(effects, journal);
		expect(result.status).toBe("complete");
		expect(effects.events).toContain("caddy:target");
		expect(effects.events).not.toContain("caddy:legacy");
		expect(effects.events).toContain("legacy:stop-edge");
		expect(effects.journal).toBeNull();
	});

	test("recovery resets committed history and stays closed if neither backend recovers", async () => {
		const effects = new FakeEffects();
		const journal = interruptedJournal("open-admission");
		effects.history = {
			version: 1,
			current: journal.target,
			previous: null,
			pending: null,
		};
		effects.legacyHealthy = false;
		effects.targetHealthy = false;
		effects.failAt = "legacy:stay-down";
		const result = await recoverSystemdAdoption(effects, journal);
		expect(result.status).toBe("failed-closed");
		expect(effects.history).toEqual(emptyReleaseHistory());
		expect(effects.events).not.toContain("admission:open");
		expect(effects.journal?.phase).toBe("failed-closed");
	});

	test("rejects adoption identity that cannot be recovered from the journal", async () => {
		const effects = new FakeEffects();
		expect(
			adoptSystemdDeployment(effects, { ...input, legacyCommit: "short" }),
		).rejects.toThrow(
			"legacy commit must be exactly 40 lowercase hex characters",
		);
		expect(
			adoptSystemdDeployment(effects, {
				...input,
				caddyBackupSha256: "short",
			}),
		).rejects.toThrow(
			"Caddy backup sha256 must be exactly 64 lowercase hex characters",
		);
		expect(() =>
			validateSystemdAdoptionJournal({
				...interruptedJournal("warm-edge"),
				phase: "unknown",
			}),
		).toThrow("systemd adoption journal phase is invalid");
	});
});
