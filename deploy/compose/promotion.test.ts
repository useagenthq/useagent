import { describe, expect, test } from "bun:test";
import {
	compensatePromotion,
	type PromotionEffects,
	promote,
	rollback,
} from "./promotion";
import {
	beginOperation,
	emptyReleaseHistory,
	type ReleaseColor,
	type ReleaseHistory,
	type ReleaseManifest,
	type ReleaseRecord,
} from "./release-config";

const image = (name: string, character: string) =>
	`${name}@sha256:${character.repeat(64)}`;
const releaseManifest = (
	commit: string,
	character: string,
): ReleaseManifest => ({
	commit,
	backend: image("registry.example/backend", character),
	gateway: image("registry.example/gateway", character),
	frontend: image("registry.example/frontend", character),
});
const oldRecord: ReleaseRecord = {
	manifest: releaseManifest("1".repeat(40), "1"),
	color: "blue",
	promotedAt: "2026-09-01T00:00:00.000Z",
};
const newManifest = releaseManifest("2".repeat(40), "2");

class FakeEffects implements PromotionEffects {
	readonly events: string[] = [];
	readonly persisted: ReleaseHistory[] = [];
	healthy = new Set<ReleaseColor>(["blue"]);
	drainResult = true;
	publicResult = true;
	failStartColors = new Set<ReleaseColor>();
	nowCount = 0;

	now() {
		return `2026-09-02T00:00:${String(this.nowCount++).padStart(2, "0")}.000Z`;
	}
	async persistHistory(history: ReleaseHistory) {
		this.persisted.push(structuredClone(history));
		this.events.push(`persist:${history.pending?.phase ?? "complete"}`);
	}
	async preflight() {
		this.events.push("preflight");
	}
	async warmEdge(record: ReleaseRecord) {
		this.events.push(`warm:${record.color}`);
	}
	async stopEdge(record: ReleaseRecord) {
		this.events.push(`stop-edge:${record.color}`);
	}
	async closeAdmission() {
		this.events.push("admission:close");
	}
	async openAdmission() {
		this.events.push("admission:open");
	}
	async drainBackend(timeoutMs: number) {
		this.events.push(`drain:${timeoutMs}`);
		return this.drainResult;
	}
	async backendHealthy(record: ReleaseRecord) {
		return this.healthy.has(record.color);
	}
	async stopBackend(record: ReleaseRecord) {
		this.events.push(`backend:stop:${record.color}`);
		this.healthy.delete(record.color);
	}
	async startBackend(record: ReleaseRecord) {
		this.events.push(`backend:start:${record.color}`);
		if (!this.failStartColors.has(record.color)) this.healthy.add(record.color);
	}
	async waitBackendHealthy(record: ReleaseRecord) {
		return this.healthy.has(record.color);
	}
	async switchCaddy(record: ReleaseRecord) {
		this.events.push(`caddy:${record.color}`);
	}
	async verifyPublic(record: ReleaseRecord) {
		this.events.push(`public:${record.color}`);
		return this.publicResult;
	}
}

function activeHistory(): ReleaseHistory {
	return { version: 1, current: oldRecord, previous: null, pending: null };
}

describe("promotion state machine", () => {
	test("warms edge with admission open, swaps one backend, then verifies before commit and reopen", async () => {
		const effects = new FakeEffects();
		const result = await promote(effects, activeHistory(), newManifest);
		expect(result.status).toBe("complete");
		expect(result.history.current?.color).toBe("green");
		expect(effects.events.indexOf("preflight")).toBeLessThan(
			effects.events.indexOf("admission:close"),
		);
		expect(effects.events.indexOf("warm:green")).toBeLessThan(
			effects.events.indexOf("admission:close"),
		);
		expect(effects.events.indexOf("backend:stop:blue")).toBeLessThan(
			effects.events.indexOf("backend:start:green"),
		);
		expect(effects.events.indexOf("public:green")).toBeLessThan(
			effects.events.indexOf("persist:commit-history"),
		);
		expect(effects.events.indexOf("persist:open-admission")).toBeLessThan(
			effects.events.indexOf("admission:open"),
		);
		expect(effects.events.indexOf("admission:open")).toBeLessThan(
			effects.events.indexOf("persist:admission-opened"),
		);
		expect(effects.healthy).toEqual(new Set(["green"]));
	});

	test("a bounded drain failure never forces the active backend down and compensates", async () => {
		const effects = new FakeEffects();
		effects.drainResult = false;
		const result = await promote(effects, activeHistory(), newManifest);
		expect(result.status).toBe("compensated");
		expect(effects.events).toContain("drain:10000");
		expect(effects.events).not.toContain("backend:stop:blue");
		expect(effects.events).not.toContain("backend:start:green");
		expect(effects.events).toContain("admission:open");
		expect(effects.healthy).toEqual(new Set(["blue"]));
	});

	test("stops a stale inactive backend before entering the drain window", async () => {
		const effects = new FakeEffects();
		effects.healthy.add("green");
		await promote(effects, activeHistory(), newManifest);
		expect(effects.events.indexOf("backend:stop:green")).toBeLessThan(
			effects.events.indexOf("admission:close"),
		);
	});

	test("a target health failure restores the previous backend before reopening admission", async () => {
		const effects = new FakeEffects();
		effects.failStartColors.add("green");
		const result = await promote(effects, activeHistory(), newManifest);
		expect(result.status).toBe("compensated");
		expect(effects.events).toContain("backend:start:blue");
		expect(effects.events.lastIndexOf("admission:close")).toBeLessThan(
			effects.events.indexOf("backend:start:blue"),
		);
		expect(effects.events.indexOf("public:blue")).toBeLessThan(
			effects.events.indexOf("admission:open"),
		);
		expect(effects.healthy).toEqual(new Set(["blue"]));
	});

	test("failed compensation remains closed when neither backend is healthy", async () => {
		const effects = new FakeEffects();
		effects.failStartColors = new Set(["blue", "green"]);
		effects.publicResult = false;
		const result = await promote(effects, activeHistory(), newManifest);
		expect(result.status).toBe("failed-closed");
		expect(result.history.pending?.phase).toBe("failed-closed");
		expect(effects.events).not.toContain("admission:open");
		expect(effects.healthy.size).toBe(0);
	});

	test("compensation is safe to retry from a persisted failed-closed phase", async () => {
		const effects = new FakeEffects();
		const target: ReleaseRecord = {
			manifest: newManifest,
			color: "green",
			promotedAt: effects.now(),
		};
		let history = beginOperation(
			activeHistory(),
			"promote",
			target,
			effects.now(),
		);
		if (!history.pending)
			throw new Error("expected a pending release operation");
		history = {
			...history,
			pending: { ...history.pending, phase: "failed-closed" },
		};
		effects.healthy.clear();
		const result = await compensatePromotion(
			effects,
			history,
			"retry recovery",
			true,
		);
		expect(result.status).toBe("compensated");
		expect(effects.healthy).toEqual(new Set(["blue"]));
		expect(effects.events).toContain("admission:open");
	});

	test("re-closes admission before recovering a committed target", async () => {
		const effects = new FakeEffects();
		const target: ReleaseRecord = {
			manifest: newManifest,
			color: "green",
			promotedAt: effects.now(),
		};
		let history = beginOperation(
			activeHistory(),
			"promote",
			target,
			effects.now(),
		);
		if (!history.pending)
			throw new Error("expected a pending release operation");
		history = {
			...history,
			current: target,
			previous: oldRecord,
			pending: { ...history.pending, phase: "open-admission" },
		};
		effects.healthy = new Set(["green"]);
		const result = await compensatePromotion(
			effects,
			history,
			"recovering reopen crash",
			true,
		);
		expect(result.status).toBe("compensated");
		expect(effects.events.indexOf("admission:close")).toBeLessThan(
			effects.events.indexOf("backend:stop:green"),
		);
		expect(result.history.current?.color).toBe("blue");
		expect(effects.healthy).toEqual(new Set(["blue"]));
	});

	test("rollback uses the previous immutable release and inactive color", async () => {
		const current: ReleaseRecord = {
			manifest: newManifest,
			color: "green",
			promotedAt: "2026-09-02T00:00:00.000Z",
		};
		const effects = new FakeEffects();
		effects.healthy = new Set(["green"]);
		const result = await rollback(effects, {
			version: 1,
			current,
			previous: oldRecord,
			pending: null,
		});
		expect(result.status).toBe("complete");
		expect(result.history.current?.manifest.commit).toBe(
			oldRecord.manifest.commit,
		);
		expect(result.history.current?.color).toBe("blue");
		expect(result.history.previous?.manifest.commit).toBe(newManifest.commit);
	});

	test("bootstrap commits only after the target is publicly verified", async () => {
		const effects = new FakeEffects();
		effects.healthy.clear();
		const result = await promote(effects, emptyReleaseHistory(), newManifest);
		expect(result.status).toBe("complete");
		expect(result.history.current?.color).toBe("blue");
		expect(effects.events.indexOf("public:blue")).toBeLessThan(
			effects.events.indexOf("persist:commit-history"),
		);
	});
});
