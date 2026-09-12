import { describe, expect, test } from "bun:test";
import {
	backendScratchPreparationCommands,
	RemoteHost,
	type SshPromotionConfig,
} from "./ssh-promotion-effects";
import type { ReleaseRecord } from "./release-config";

const config: SshPromotionConfig = {
	sshHost: "root@example.test",
	sshKey: null,
	sshConfig: null,
	sshControlPath: "/tmp/useagent-promote-test.sock",
	appDomain: "app.example.test",
	gatewayDomain: "gateway.example.test",
	publicGatewayUrl: "https://gateway.example.test",
	backendEnvFile: "/etc/useagent/backend.env",
	gatewayEnvFile: "/etc/useagent/gateway.env",
	remoteRoot: "/var/lib/useagent",
	historyPath: "/var/lib/useagent/release-history.json",
	caddyConfigPath: "/etc/caddy/Caddyfile",
	caddyEnvFile: "/etc/useagent/caddy.env",
	composeSource: "/workspace/compose.prod.yaml",
	caddyTemplateSource: "/workspace/deploy/compose/Caddyfile",
	crashAfter: null,
};

describe("SSH promotion transport", () => {
	test("reuses one task-scoped SSH connection without a global socket", () => {
		const args = new RemoteHost(config).sshArgs();
		expect(args).toContain("ControlMaster=auto");
		expect(args).toContain("ControlPersist=60");
		expect(args).toContain("ControlPath=/tmp/useagent-promote-test.sock");
		expect(args).not.toContain("ControlPath=none");
	});

	test("repairs and probes the disk-backed backend scratch mount before cutover", () => {
		const record: ReleaseRecord = {
			color: "green",
			promotedAt: "2026-09-04T00:00:00.000Z",
			manifest: {
				commit: "a".repeat(40),
				backend: `registry.example/backend@sha256:${"b".repeat(64)}`,
				gateway: `registry.example/gateway@sha256:${"c".repeat(64)}`,
				frontend: `registry.example/frontend@sha256:${"d".repeat(64)}`,
			},
		};
		const commands = backendScratchPreparationCommands(config, record);

		expect(commands).toHaveLength(2);
		expect(commands[0]).toContain('install -d -o "$uid" -g "$gid" -m 0770');
		expect(commands[0]).toContain("'/var/lib/useagent/scratch/green'");
		expect(commands[1]).toContain("run --rm --no-deps --entrypoint sh backend");
		expect(commands[1]).toContain("/var/lib/useagent/scratch/green/.useagent-scratch-");
	});
});
