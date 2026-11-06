/**
 * Names the control plane has already placed inside sandboxes: its private
 * state directory under the sandbox home, and the prefix of its process
 * sessions, runtime ids, markers and baked commands. Retained sandboxes, baked
 * images and recorded runtime state carry these exact values; a changed one
 * would strand a live thread or start a second copy of a resident process, so
 * they keep the product's first name (docs/architecture/legacy-identifiers.md).
 * Code names them by what they do and never repeats the value.
 */
export const SANDBOX_NAME_PREFIX = "skynet";

/** The plane's private directory under the sandbox home. The provider
 *  gateway's own files moved to `.useagent`, with links left here
 *  (provider-gateway/sandbox-config.ts). */
export const SANDBOX_STATE_DIR = `.${SANDBOX_NAME_PREFIX}`;

/** {@link SANDBOX_STATE_DIR} for the sandbox shell to expand. */
export const SANDBOX_STATE_HOME = `$HOME/${SANDBOX_STATE_DIR}`;
