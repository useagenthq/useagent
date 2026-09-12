import { describe, expect, test } from "bun:test";
import { writableMountOwnershipCommand } from "./ssh-systemd-adoption-effects";

describe("Compose adoption writable mounts", () => {
	test("repairs an existing bind mount with the immutable image identity", () => {
		const command = writableMountOwnershipCommand(
			"registry.example/backend@sha256:" + "a".repeat(64),
			[{ host: "/var/lib/useagent/artifacts" }],
		);

		expect(command).toContain("docker run --rm --entrypoint id");
		expect(command).toContain("backend image returned a non-numeric uid/gid");
		expect(command).toContain('install -d -o "$uid" -g "$gid" -m 0770');
		expect(command).toContain('chown -R "$uid:$gid" \'/var/lib/useagent/artifacts\'');
		expect(command).not.toContain("useagent:useagent");
	});
});
