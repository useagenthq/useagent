import { describe, expect, test } from "bun:test";
import { RemoteHost, type SshPromotionConfig } from "./ssh-promotion-effects";

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
});
