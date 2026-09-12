import { describe, expect, test } from "bun:test";
import {
	adoptLegacyCaddyUpstreams,
	advanceOperation,
	beginOperation,
	classifyMigrations,
	commitOperation,
	composeReleaseEnv,
	emptyReleaseHistory,
	finishOperation,
	nextInactiveColor,
	productionComposeReleaseConfig,
	type ReleaseManifest,
	renderCaddyTemplate,
	rewriteCaddyUpstreams,
	validateReleaseHistory,
	validateReleaseManifest,
} from "./release-config";

const digest = (name: string) => `${name}@sha256:${"a".repeat(64)}`;
const manifest: ReleaseManifest = {
	commit: "9ddcc082257e687b9be51b951f6f0dbbda8cc0ef",
	backend: digest("registry.example/backend"),
	gateway: digest("registry.example/gateway"),
	frontend: digest("registry.example/frontend"),
};
const validCompose = {
	USEAGENT_RELEASE_COLOR: "green",
	USEAGENT_RELEASE_COMMIT: manifest.commit,
	USEAGENT_GATEWAY_PUBLIC_URL: "https://gateway.useagent.example",
	USEAGENT_BACKEND_IMAGE: manifest.backend,
	USEAGENT_GATEWAY_IMAGE: manifest.gateway,
	USEAGENT_FRONTEND_IMAGE: manifest.frontend,
	USEAGENT_BACKEND_PORT: "3211",
	USEAGENT_GATEWAY_PORT: "3212",
	USEAGENT_FRONTEND_PORT: "3410",
} as const;

describe("release configuration", () => {
	test("maps durable runtime paths onto writable container mounts", async () => {
		const compose = await Bun.file(
			new URL("../../compose.prod.yaml", import.meta.url),
		).text();
		for (const contract of [
			"ARTIFACT_STORAGE_DIR: /app/backend/.artifacts",
			"RUNS_ROOT: /app/backend/.runs",
			"SLACK_UPLOAD_STAGING_ROOT: /app/backend/.slack-uploads",
			"SCRATCH_DIR: /tmp",
			"NODE_EXTRA_CA_CERTS: /etc/ssl/certs/ca-certificates.crt",
			"SSL_CERT_FILE: /etc/ssl/certs/ca-certificates.crt",
			"USEAGENT_HOST_CA_BUNDLE:-/etc/ssl/certs/ca-certificates.crt",
			"/var/lib/useagent/artifacts:/app/backend/.artifacts",
			"/var/lib/useagent/runs:/app/backend/.runs",
			"/var/lib/useagent/slack-uploads:/app/backend/.slack-uploads",
		]) {
			expect(compose).toContain(contract);
		}
		expect(compose).not.toContain(":/var/lib/skynet");
	});

	test("preserves the production Compose digest and fixed-port contract", () => {
		expect(productionComposeReleaseConfig(validCompose)).toEqual({
			color: "green",
			commit: manifest.commit,
			publicGatewayUrl: "https://gateway.useagent.example",
			images: {
				backend: manifest.backend,
				gateway: manifest.gateway,
				frontend: manifest.frontend,
			},
			ports: { backend: 3211, gateway: 3212, frontend: 3410 },
		});
		expect(() =>
			productionComposeReleaseConfig({
				...validCompose,
				USEAGENT_BACKEND_IMAGE: "registry.example/backend:main",
			}),
		).toThrow("immutable sha256 reference");
		expect(() =>
			productionComposeReleaseConfig({
				...validCompose,
				USEAGENT_RELEASE_COLOR: "blue",
			}),
		).toThrow("must be 3201 for blue");
	});

	test("accepts only flat digest-pinned manifests", () => {
		expect(validateReleaseManifest(manifest)).toEqual(manifest);
		expect(() =>
			validateReleaseManifest({
				...manifest,
				frontend: "registry.example/frontend:main",
			}),
		).toThrow("pinned by sha256 digest");
		expect(() =>
			validateReleaseManifest({ ...manifest, metadata: {} }),
		).toThrow("must contain exactly");
		expect(() =>
			validateReleaseManifest({ ...manifest, commit: "abc1234" }),
		).toThrow("exact 40-character");
	});

	test("bootstraps blue and otherwise selects the inactive color", () => {
		expect(nextInactiveColor(null)).toEqual({
			activeColor: null,
			targetColor: "blue",
			bootstrap: true,
		});
		expect(nextInactiveColor("blue")).toEqual({
			activeColor: "blue",
			targetColor: "green",
			bootstrap: false,
		});
		expect(nextInactiveColor("green")).toEqual({
			activeColor: "green",
			targetColor: "blue",
			bootstrap: false,
		});
	});

	test("creates a frozen compose environment from immutable image digests", () => {
		const env = composeReleaseEnv(manifest, "green");
		expect(env).toEqual({
			USEAGENT_RELEASE_COLOR: "green",
			USEAGENT_RELEASE_COMMIT: manifest.commit,
			USEAGENT_BACKEND_IMAGE: manifest.backend,
			USEAGENT_GATEWAY_IMAGE: manifest.gateway,
			USEAGENT_FRONTEND_IMAGE: manifest.frontend,
		});
		expect(Object.isFrozen(env)).toBe(true);
	});

	test("allows only additive migrations carrying the expansion marker", () => {
		const base = {
			path: "001-base.sql",
			contents: "create table accounts(id bigint);\n",
		};
		const active = [base];
		const safe = classifyMigrations(active, [
			...active,
			{
				path: "002-index.sql",
				contents:
					"-- fast-deploy: expansion-safe\ncreate index accounts_id on accounts(id);\n",
			},
		]);
		expect(safe).toEqual({
			forwardSafe: true,
			rollbackSafe: true,
			added: ["002-index.sql"],
			modified: [],
			removed: [],
			unsafe: [],
		});

		expect(
			classifyMigrations(active, [
				...active,
				{ path: "002.sql", contents: "drop table accounts;" },
			]).forwardSafe,
		).toBe(false);
		expect(
			classifyMigrations(active, [
				{ ...base, contents: "alter table accounts add email text;" },
			]).rollbackSafe,
		).toBe(false);
		expect(classifyMigrations(active, []).removed).toEqual(["001-base.sql"]);
	});

	test("renders every Caddy upstream deterministically and rejects unresolved tokens", () => {
		const template =
			"app {{APP_DOMAIN}}\ngateway-domain {{GATEWAY_DOMAIN}}\n" +
			"frontend {{FRONTEND_UPSTREAM}}\nbackend {{BACKEND_UPSTREAM}}\ngateway {{GATEWAY_UPSTREAM}}\n";
		const upstreams = {
			appDomain: "app.example.com",
			gatewayDomain: "gateway.example.com",
			frontend: "127.0.0.1:3401",
			backend: "127.0.0.1:3301",
			gateway: "127.0.0.1:3501",
		};
		expect(renderCaddyTemplate(template, upstreams)).toBe(
			"app app.example.com\ngateway-domain gateway.example.com\n" +
				"frontend 127.0.0.1:3401\nbackend 127.0.0.1:3301\ngateway 127.0.0.1:3501\n",
		);
		expect(renderCaddyTemplate(template, upstreams)).toBe(
			renderCaddyTemplate(template, upstreams),
		);
		expect(() =>
			renderCaddyTemplate(`${template}extra {{UNKNOWN}}`, upstreams),
		).toThrow("unresolved token");
	});

	test("rewrites only marked Caddy upstreams and preserves unrelated ingress", () => {
		const source = [
			"app.example.com {",
			"  # useagent-release: backend",
			"  reverse_proxy 127.0.0.1:3201",
			"  handle /oauth/callback { reverse_proxy 127.0.0.1:3300 }",
			"  # useagent-release: frontend",
			"  reverse_proxy 127.0.0.1:3400",
			"}",
			"gateway.example.com {",
			"  # useagent-release: gateway",
			"  reverse_proxy 127.0.0.1:3202",
			"}",
			"registry.example.com { reverse_proxy 127.0.0.1:5000 }",
		].join("\n");
		const rewritten = rewriteCaddyUpstreams(source, {
			backend: "127.0.0.1:3211",
			gateway: "127.0.0.1:3212",
			frontend: "127.0.0.1:3410",
		});
		expect(rewritten).toContain("reverse_proxy 127.0.0.1:3211");
		expect(rewritten).toContain("reverse_proxy 127.0.0.1:3212");
		expect(rewritten).toContain("reverse_proxy 127.0.0.1:3410");
		expect(rewritten).toContain(
			"handle /oauth/callback { reverse_proxy 127.0.0.1:3300 }",
		);
		expect(rewritten).toContain(
			"registry.example.com { reverse_proxy 127.0.0.1:5000 }",
		);
		expect(() =>
			rewriteCaddyUpstreams(
				source.replace("# useagent-release: gateway\n", ""),
				{
					backend: "127.0.0.1:3211",
					gateway: "127.0.0.1:3212",
					frontend: "127.0.0.1:3410",
				},
			),
		).toThrow("gateway release marker");
	});

	test("adopts the legacy production topology without changing unrelated Caddy directives", () => {
		const source = [
			"app.useagent.org, skynet.meow.gs {",
			'\theader { X-Content-Type-Options "nosniff" }',
			"\t@relay path /api/internal/codex-relay/*",
			"\thandle @relay {",
			"\t\treverse_proxy 127.0.0.1:3201",
			"\t}",
			"\t@oauth path /oauth/callback",
			"\thandle @oauth { reverse_proxy 127.0.0.1:3300 }",
			"\thandle {",
			"\t\treverse_proxy 127.0.0.1:3400",
			"\t}",
			"}",
			"gateway.sandbox.skynet.meow.gs {",
			"\treverse_proxy 127.0.0.1:3202",
			"}",
			"registry.sandbox.skynet.meow.gs { reverse_proxy 127.0.0.1:5000 }",
			"*.sandbox.skynet.meow.gs {",
			"\ttls internal",
			"\t@backend remote_ip 127.0.0.1 ::1",
			"\thandle @backend { reverse_proxy 127.0.0.1:18080 }",
			'\trespond "Forbidden" 403',
			"}",
			"",
		].join("\r\n");
		const rewritten = adoptLegacyCaddyUpstreams(
			source,
			{
				backend: "127.0.0.1:3201",
				frontend: "127.0.0.1:3400",
				gateway: "127.0.0.1:3202",
			},
			{
				backend: "127.0.0.1:3211",
				frontend: "127.0.0.1:3410",
				gateway: "127.0.0.1:3212",
			},
		);

		expect(rewritten.match(/# useagent-release: backend/g)).toHaveLength(2);
		expect(rewritten).toContain(
			"\t@useagent_api path /api/*\r\n\thandle @useagent_api {\r\n" +
				"\t\t# useagent-release: backend\r\n\t\treverse_proxy 127.0.0.1:3211",
		);
		expect(rewritten).toContain(
			"\t\t# useagent-release: frontend\r\n\t\treverse_proxy 127.0.0.1:3410",
		);
		expect(rewritten).toContain(
			"\t# useagent-release: gateway\r\n\treverse_proxy 127.0.0.1:3212",
		);
		for (const preserved of [
			'header { X-Content-Type-Options "nosniff" }',
			"handle @oauth { reverse_proxy 127.0.0.1:3300 }",
			"registry.sandbox.skynet.meow.gs { reverse_proxy 127.0.0.1:5000 }",
			"*.sandbox.skynet.meow.gs {",
			"handle @backend { reverse_proxy 127.0.0.1:18080 }",
			'respond "Forbidden" 403',
		]) {
			expect(rewritten).toContain(preserved);
		}
		expect(rewritten.endsWith("\r\n")).toBe(true);
		expect(
			adoptLegacyCaddyUpstreams(
				rewritten,
				{
					backend: "127.0.0.1:3201",
					frontend: "127.0.0.1:3400",
					gateway: "127.0.0.1:3202",
				},
				{
					backend: "127.0.0.1:3211",
					frontend: "127.0.0.1:3410",
					gateway: "127.0.0.1:3212",
				},
			),
		).toBe(rewritten);
	});

	test("legacy Caddy adoption preserves an existing direct API route", () => {
		const source = [
			"app.example.test {",
			"\t@relay path /api/internal/codex-relay/*",
			"\thandle @relay {",
			"\t\treverse_proxy 127.0.0.1:3201",
			"\t}",
			"\t@api path /api/*",
			"\thandle @api {",
			"\t\treverse_proxy 127.0.0.1:3201",
			"\t}",
			"\thandle {",
			"\t\treverse_proxy 127.0.0.1:3400",
			"\t}",
			"}",
			"gateway.example.test {",
			"\treverse_proxy 127.0.0.1:3202",
			"}",
		].join("\n");
		const rewritten = adoptLegacyCaddyUpstreams(
			source,
			{
				backend: "127.0.0.1:3201",
				frontend: "127.0.0.1:3400",
				gateway: "127.0.0.1:3202",
			},
			{
				backend: "127.0.0.1:3211",
				frontend: "127.0.0.1:3410",
				gateway: "127.0.0.1:3212",
			},
		);
		expect(rewritten.match(/# useagent-release: backend/g)).toHaveLength(2);
		expect(rewritten).toContain("@api path /api/*");
		expect(rewritten).not.toContain("@useagent_api");
	});

	test("legacy Caddy adoption fails closed on ambiguous or inconsistent topology", () => {
		const legacy = {
			backend: "127.0.0.1:3201",
			frontend: "127.0.0.1:3400",
			gateway: "127.0.0.1:3202",
		};
		const target = {
			backend: "127.0.0.1:3211",
			frontend: "127.0.0.1:3410",
			gateway: "127.0.0.1:3212",
		};
		const valid = [
			"reverse_proxy 127.0.0.1:3201",
			"reverse_proxy 127.0.0.1:3400",
			"reverse_proxy 127.0.0.1:3202",
		].join("\n");
		expect(() =>
			adoptLegacyCaddyUpstreams(
				`${valid}\nreverse_proxy 127.0.0.1:3400\n`,
				legacy,
				target,
			),
		).toThrow("frontend upstream is ambiguous");
		expect(() =>
			adoptLegacyCaddyUpstreams(
				valid.replace("reverse_proxy 127.0.0.1:3202", ""),
				legacy,
				target,
			),
		).toThrow("missing the gateway upstream");
		expect(() =>
			adoptLegacyCaddyUpstreams(
				`# useagent-release: frontend\n${valid}`,
				legacy,
				target,
			),
		).toThrow("existing frontend release marker is inconsistent");
		expect(() =>
			adoptLegacyCaddyUpstreams(
				`${valid}\n# useagent-release: backend\nreverse_proxy 127.0.0.1:9999`,
				legacy,
				target,
			),
		).toThrow("existing backend release marker is inconsistent");
		expect(() =>
			adoptLegacyCaddyUpstreams(valid, legacy, {
				...target,
				gateway: legacy.frontend,
			}),
		).toThrow("must identify one service");
	});

	test("persists exact operation phases and commits history only at cutover", () => {
		const target = {
			manifest,
			color: "blue" as const,
			promotedAt: "2026-09-02T00:00:00.000Z",
		};
		let history = beginOperation(
			emptyReleaseHistory(),
			"promote",
			target,
			"2026-09-02T00:00:00.000Z",
		);
		expect(history.current).toBeNull();
		expect(history.pending?.phase).toBe("preflight");
		history = advanceOperation(
			history,
			"warm-edge",
			"2026-09-02T00:00:01.000Z",
		);
		expect(history.pending?.phase).toBe("warm-edge");
		history = commitOperation(history, "2026-09-02T00:00:02.000Z");
		expect(history.current?.manifest.commit).toBe(manifest.commit);
		expect(history.pending?.phase).toBe("open-admission");
		history = advanceOperation(
			history,
			"admission-opened",
			"2026-09-02T00:00:03.000Z",
		);
		expect(finishOperation(history).pending).toBeNull();
	});

	test("validates durable history invariants instead of accepting ambiguous recovery state", () => {
		const target = {
			manifest,
			color: "blue" as const,
			promotedAt: "2026-09-02T00:00:00.000Z",
		};
		const history = beginOperation(
			emptyReleaseHistory(),
			"promote",
			target,
			"2026-09-02T00:00:00.000Z",
		);
		if (!history.pending)
			throw new Error("expected a pending release operation");
		expect(validateReleaseHistory(history)).toEqual(history);
		expect(() => validateReleaseHistory({ ...history, version: 2 })).toThrow(
			"version must be 1",
		);
		expect(() =>
			validateReleaseHistory({
				...history,
				pending: { ...history.pending, id: "promote:wrong:blue" },
			}),
		).toThrow("id does not match");
	});
});
