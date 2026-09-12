export type ReleaseColor = "blue" | "green";

export interface ComposeReleaseConfig {
	readonly color: ReleaseColor;
	readonly commit: string;
	readonly publicGatewayUrl: string;
	readonly images: {
		readonly backend: string;
		readonly gateway: string;
		readonly frontend: string;
	};
	readonly ports: {
		readonly backend: number;
		readonly gateway: number;
		readonly frontend: number;
	};
}

export interface ReleaseManifest {
	commit: string;
	backend: string;
	gateway: string;
	frontend: string;
}

export interface ReleaseRecord {
	manifest: ReleaseManifest;
	color: ReleaseColor;
	promotedAt: string;
}

export const pendingOperationPhases = [
	"preflight",
	"warm-edge",
	"close-admission",
	"drain-backend",
	"stop-active-backend",
	"start-target-backend",
	"switch-caddy",
	"verify-public",
	"commit-history",
	"open-admission",
	"admission-opened",
	"stop-old-edge",
	"compensate",
	"failed-closed",
] as const;

export type PendingOperationPhase = (typeof pendingOperationPhases)[number];

export interface PendingOperation {
	id: string;
	kind: "promote" | "rollback";
	phase: PendingOperationPhase;
	from: ReleaseRecord | null;
	to: ReleaseRecord;
	startedAt: string;
	updatedAt: string;
	error?: string;
}

export interface ReleaseHistory {
	version: 1;
	current: ReleaseRecord | null;
	previous: ReleaseRecord | null;
	pending: PendingOperation | null;
}

export interface ReleasePlan {
	activeColor: ReleaseColor | null;
	targetColor: ReleaseColor;
	bootstrap: boolean;
}

export interface MigrationFile {
	path: string;
	contents: string;
}

export interface MigrationDecision {
	forwardSafe: boolean;
	rollbackSafe: boolean;
	added: string[];
	modified: string[];
	removed: string[];
	unsafe: string[];
}

const digestPattern = /^[^\s@]+@sha256:[a-f0-9]{64}$/;
const commitPattern = /^[a-f0-9]{40}$/;
const expansionMarker = /^\s*--\s*fast-deploy:\s*expansion-safe\s*$/m;
const releasePortsByColor = {
	blue: { backend: 3201, gateway: 3202, frontend: 3400 },
	green: { backend: 3211, gateway: 3212, frontend: 3410 },
} as const;
const operationPhases = new Set<PendingOperationPhase>(pendingOperationPhases);

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertKeys(
	value: Record<string, unknown>,
	keys: readonly string[],
	label: string,
): void {
	const actual = Object.keys(value).sort();
	const expected = [...keys].sort();
	if (
		actual.length !== expected.length ||
		actual.some((key, index) => key !== expected[index])
	) {
		throw new Error(`${label} must contain exactly: ${expected.join(", ")}`);
	}
}

function assertString(value: unknown, label: string): string {
	if (typeof value !== "string" || value.length === 0) {
		throw new Error(`${label} must be a non-empty string`);
	}
	return value;
}

export function releasePorts(
	color: ReleaseColor,
): ComposeReleaseConfig["ports"] {
	return { ...releasePortsByColor[color] };
}

export function productionComposeReleaseConfig(
	env: Readonly<Record<string, string | undefined>>,
): ComposeReleaseConfig {
	const color = env.USEAGENT_RELEASE_COLOR;
	if (color !== "blue" && color !== "green") {
		throw new Error("USEAGENT_RELEASE_COLOR must be blue or green");
	}
	const commit = env.USEAGENT_RELEASE_COMMIT?.trim() ?? "";
	if (!commitPattern.test(commit)) {
		throw new Error("USEAGENT_RELEASE_COMMIT must be an exact Git commit");
	}
	const rawPublicGatewayUrl = env.USEAGENT_GATEWAY_PUBLIC_URL?.trim() ?? "";
	let publicGatewayUrl: URL;
	try {
		publicGatewayUrl = new URL(rawPublicGatewayUrl);
	} catch {
		throw new Error(
			"USEAGENT_GATEWAY_PUBLIC_URL must be an absolute HTTPS origin",
		);
	}
	if (
		publicGatewayUrl.protocol !== "https:" ||
		publicGatewayUrl.username ||
		publicGatewayUrl.password ||
		publicGatewayUrl.pathname !== "/" ||
		publicGatewayUrl.search ||
		publicGatewayUrl.hash
	) {
		throw new Error(
			"USEAGENT_GATEWAY_PUBLIC_URL must be an absolute HTTPS origin",
		);
	}
	const image = (name: "BACKEND" | "GATEWAY" | "FRONTEND"): string => {
		const value = env[`USEAGENT_${name}_IMAGE`]?.trim() ?? "";
		if (!digestPattern.test(value)) {
			throw new Error(
				`USEAGENT_${name}_IMAGE must be an immutable sha256 reference`,
			);
		}
		return value;
	};
	const expectedPorts = releasePortsByColor[color];
	const port = (name: "BACKEND" | "GATEWAY" | "FRONTEND"): number => {
		const value = Number(env[`USEAGENT_${name}_PORT`]);
		const expected =
			expectedPorts[name.toLowerCase() as keyof typeof expectedPorts];
		if (value !== expected) {
			throw new Error(`USEAGENT_${name}_PORT must be ${expected} for ${color}`);
		}
		return value;
	};
	return {
		color,
		commit,
		publicGatewayUrl: publicGatewayUrl.origin,
		images: {
			backend: image("BACKEND"),
			gateway: image("GATEWAY"),
			frontend: image("FRONTEND"),
		},
		ports: {
			backend: port("BACKEND"),
			gateway: port("GATEWAY"),
			frontend: port("FRONTEND"),
		},
	};
}

export function validateReleaseManifest(value: unknown): ReleaseManifest {
	if (!isObject(value)) throw new Error("release manifest must be an object");
	assertKeys(
		value,
		["commit", "backend", "gateway", "frontend"],
		"release manifest",
	);

	const commit = assertString(value.commit, "release manifest commit");
	if (!commitPattern.test(commit)) {
		throw new Error(
			"release manifest commit must be an exact 40-character lowercase git hash",
		);
	}

	const manifest: ReleaseManifest = {
		commit,
		backend: assertString(value.backend, "release manifest backend image"),
		gateway: assertString(value.gateway, "release manifest gateway image"),
		frontend: assertString(value.frontend, "release manifest frontend image"),
	};
	for (const [service, image] of Object.entries(manifest).filter(
		([key]) => key !== "commit",
	)) {
		if (!digestPattern.test(image)) {
			throw new Error(
				`release manifest ${service} image must be pinned by sha256 digest`,
			);
		}
	}
	return Object.freeze(manifest);
}

export function emptyReleaseHistory(): ReleaseHistory {
	return { version: 1, current: null, previous: null, pending: null };
}

function validateTimestamp(value: unknown, label: string): string {
	const timestamp = assertString(value, label);
	const parsed = new Date(timestamp);
	if (Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== timestamp) {
		throw new Error(`${label} must be an ISO timestamp`);
	}
	return timestamp;
}

export function validateReleaseRecord(
	value: unknown,
	label = "release record",
): ReleaseRecord {
	if (!isObject(value)) throw new Error(`${label} must be an object`);
	assertKeys(value, ["manifest", "color", "promotedAt"], label);
	if (value.color !== "blue" && value.color !== "green") {
		throw new Error(`${label} color must be blue or green`);
	}
	return {
		manifest: validateReleaseManifest(value.manifest),
		color: value.color,
		promotedAt: validateTimestamp(value.promotedAt, `${label} promotedAt`),
	};
}

export function validatePendingOperation(value: unknown): PendingOperation {
	if (!isObject(value))
		throw new Error("pending release operation must be an object");
	assertKeys(
		value,
		value.error === undefined
			? ["id", "kind", "phase", "from", "to", "startedAt", "updatedAt"]
			: [
					"id",
					"kind",
					"phase",
					"from",
					"to",
					"startedAt",
					"updatedAt",
					"error",
				],
		"pending release operation",
	);
	if (value.kind !== "promote" && value.kind !== "rollback") {
		throw new Error(
			"pending release operation kind must be promote or rollback",
		);
	}
	if (
		typeof value.phase !== "string" ||
		!operationPhases.has(value.phase as PendingOperationPhase)
	) {
		throw new Error("pending release operation phase is invalid");
	}
	const from =
		value.from === null
			? null
			: validateReleaseRecord(value.from, "pending from release");
	const to = validateReleaseRecord(value.to, "pending target release");
	if (from?.color === to.color)
		throw new Error("pending target must use the inactive release color");
	const operation: PendingOperation = {
		id: assertString(value.id, "pending release operation id"),
		kind: value.kind,
		phase: value.phase as PendingOperationPhase,
		from,
		to,
		startedAt: validateTimestamp(
			value.startedAt,
			"pending release operation startedAt",
		),
		updatedAt: validateTimestamp(
			value.updatedAt,
			"pending release operation updatedAt",
		),
		...(value.error === undefined
			? {}
			: {
					error: assertString(value.error, "pending release operation error"),
				}),
	};
	if (operation.id !== `${operation.kind}:${to.manifest.commit}:${to.color}`) {
		throw new Error("pending release operation id does not match its target");
	}
	return operation;
}

export function validateReleaseHistory(value: unknown): ReleaseHistory {
	if (!isObject(value)) throw new Error("release history must be an object");
	assertKeys(
		value,
		["version", "current", "previous", "pending"],
		"release history",
	);
	if (value.version !== 1) throw new Error("release history version must be 1");
	const current =
		value.current === null
			? null
			: validateReleaseRecord(value.current, "current release");
	const previous =
		value.previous === null
			? null
			: validateReleaseRecord(value.previous, "previous release");
	if (current && previous && current.color === previous.color) {
		throw new Error("current and previous releases must use different colors");
	}
	const pending =
		value.pending === null ? null : validatePendingOperation(value.pending);
	if (pending) {
		const committed =
			pending.phase === "open-admission" ||
			pending.phase === "admission-opened" ||
			pending.phase === "stop-old-edge";
		const recovering =
			pending.phase === "compensate" || pending.phase === "failed-closed";
		const currentCommit = current?.manifest.commit;
		const sourceCommit = pending.from?.manifest.commit;
		const targetCommit = pending.to.manifest.commit;
		if (
			(!recovering &&
				currentCommit !== (committed ? targetCommit : sourceCommit)) ||
			(recovering &&
				currentCommit !== sourceCommit &&
				currentCommit !== targetCommit)
		) {
			throw new Error(
				"pending release operation does not match the current release",
			);
		}
	}
	return { version: 1, current, previous, pending };
}

export function nextInactiveColor(active: ReleaseColor | null): ReleasePlan {
	return {
		activeColor: active,
		targetColor: active === "blue" ? "green" : "blue",
		bootstrap: active === null,
	};
}

export function planNextRelease(history: ReleaseHistory): ReleasePlan {
	return nextInactiveColor(history.current?.color ?? null);
}

export function composeReleaseEnv(
	manifest: ReleaseManifest,
	color: ReleaseColor,
): Readonly<Record<string, string>> {
	return Object.freeze({
		USEAGENT_RELEASE_COLOR: color,
		USEAGENT_RELEASE_COMMIT: manifest.commit,
		USEAGENT_BACKEND_IMAGE: manifest.backend,
		USEAGENT_GATEWAY_IMAGE: manifest.gateway,
		USEAGENT_FRONTEND_IMAGE: manifest.frontend,
	});
}

function migrationMap(files: readonly MigrationFile[]): Map<string, string> {
	const result = new Map<string, string>();
	for (const file of files) {
		if (!file.path || file.path.startsWith("/") || file.path.includes("..")) {
			throw new Error(`invalid migration path: ${file.path}`);
		}
		if (result.has(file.path))
			throw new Error(`duplicate migration path: ${file.path}`);
		result.set(file.path, file.contents.replaceAll("\r\n", "\n"));
	}
	return result;
}

export function classifyMigrations(
	activeFiles: readonly MigrationFile[],
	targetFiles: readonly MigrationFile[],
): MigrationDecision {
	const active = migrationMap(activeFiles);
	const target = migrationMap(targetFiles);
	const added = [...target.keys()].filter((path) => !active.has(path)).sort();
	const removed = [...active.keys()].filter((path) => !target.has(path)).sort();
	const modified = [...target.keys()]
		.filter((path) => active.has(path) && active.get(path) !== target.get(path))
		.sort();
	const unsafe = added.filter(
		(path) => !expansionMarker.test(target.get(path) ?? ""),
	);
	const safe =
		removed.length === 0 && modified.length === 0 && unsafe.length === 0;

	return {
		forwardSafe: safe,
		rollbackSafe: safe,
		added,
		modified,
		removed,
		unsafe,
	};
}

export interface CaddyUpstreams {
	appDomain: string;
	gatewayDomain: string;
	frontend: string;
	backend: string;
	gateway: string;
}

export function renderCaddyTemplate(
	template: string,
	upstreams: CaddyUpstreams,
): string {
	let rendered = template;
	for (const key of [
		"appDomain",
		"gatewayDomain",
		"frontend",
		"backend",
		"gateway",
	] as const) {
		const value = upstreams[key];
		if (!/^[a-zA-Z0-9_.:-]+$/.test(value)) {
			throw new Error(`invalid Caddy ${key}`);
		}
		const token = key.endsWith("Domain")
			? `{{${key.replace("Domain", "").toUpperCase()}_DOMAIN}}`
			: `{{${key.toUpperCase()}_UPSTREAM}}`;
		if (!rendered.includes(token))
			throw new Error(`Caddy template is missing ${token}`);
		rendered = rendered.replaceAll(token, value);
	}
	const unresolved = rendered.match(/{{[A-Z0-9_]+}}/g);
	if (unresolved)
		throw new Error(`Caddy template has unresolved token ${unresolved[0]}`);
	return rendered;
}

export function rewriteCaddyUpstreams(
	config: string,
	upstreams: Pick<CaddyUpstreams, "frontend" | "backend" | "gateway">,
): string {
	const lines = config.split("\n");
	for (const service of ["frontend", "backend", "gateway"] as const) {
		const value = upstreams[service];
		if (!/^[a-zA-Z0-9_.:-]+$/.test(value)) {
			throw new Error(`invalid Caddy ${service}`);
		}
		let replacements = 0;
		for (let index = 0; index < lines.length; index += 1) {
			if (lines[index]?.trim() !== `# useagent-release: ${service}`) continue;
			const proxyIndex = index + 1;
			const match = lines[proxyIndex]?.match(/^(\s*reverse_proxy\s+)\S+(.*)$/);
			if (!match) {
				throw new Error(
					`Caddy ${service} marker must be followed by reverse_proxy`,
				);
			}
			lines[proxyIndex] = `${match[1]}${value}${match[2]}`;
			replacements += 1;
		}
		if (replacements === 0) {
			throw new Error(`Caddy config is missing the ${service} release marker`);
		}
	}
	return lines.join("\n");
}

export function beginOperation(
	history: ReleaseHistory,
	kind: PendingOperation["kind"],
	to: ReleaseRecord,
	now: string,
): ReleaseHistory {
	if (history.pending)
		throw new Error(
			`release operation ${history.pending.id} is already pending`,
		);
	return {
		...history,
		pending: {
			id: `${kind}:${to.manifest.commit}:${to.color}`,
			kind,
			phase: "preflight",
			from: history.current,
			to,
			startedAt: now,
			updatedAt: now,
		},
	};
}

export function advanceOperation(
	history: ReleaseHistory,
	phase: PendingOperationPhase,
	now: string,
	error?: string,
): ReleaseHistory {
	if (!history.pending) throw new Error("no release operation is pending");
	return {
		...history,
		pending: {
			...history.pending,
			phase,
			updatedAt: now,
			...(error ? { error } : {}),
		},
	};
}

export function commitOperation(
	history: ReleaseHistory,
	now: string,
): ReleaseHistory {
	if (!history.pending) throw new Error("no release operation is pending");
	return {
		...history,
		current: { ...history.pending.to, promotedAt: now },
		previous: history.pending.from,
		pending: { ...history.pending, phase: "open-admission", updatedAt: now },
	};
}

export function finishOperation(history: ReleaseHistory): ReleaseHistory {
	if (!history.pending) throw new Error("no release operation is pending");
	return { ...history, pending: null };
}
