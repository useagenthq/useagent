import { Daytona, type Sandbox } from "@daytona/sdk";

// ---------------------------------------------------------------------------
// SandboxProvider port — the ONE seam between Skynet and the sandbox substrate.
//
// Every engine/proxy/tool that talks to a cloud sandbox goes through this
// module; it is the ONLY file under backend/src that imports @daytona/sdk. That
// keeps the Daytona bet falsifiable (substrate-hedge, reference-class-speed plan
// amendment 11): swapping substrates means re-implementing this module, not
// editing a dozen call sites.
//
// The port is a THIN structural view over the SDK types (no delegation classes,
// no adapter tax). Two exports name the surface the backend actually uses:
//
//   SandboxProvider — the control-plane client: create / get / list only.
//   SandboxHandle   — a provisioned sandbox. The backend reaches into a wide
//                     slice of it (id, cpu, memory, state + labels via
//                     defensive casts, start, delete, getPreviewLink,
//                     process.{executeCommand,createSession,
//                     executeSessionCommand,getSessionCommandLogs,
//                     deleteSession}, fs.{getFileDetails,downloadFile}), so it
//                     re-exports the SDK Sandbox type rather than hand-mirroring
//                     that whole surface.
// ---------------------------------------------------------------------------

/** A provisioned sandbox. Aliased to the SDK's `Sandbox`: call sites use many of
 *  its members plus `state`/`labels` through defensive casts, so re-exporting the
 *  SDK type keeps the seam thin instead of hand-mirroring the full surface. */
export type SandboxHandle = Sandbox;

/** The sandbox control-plane client, narrowed to the three methods the backend
 *  calls. `Pick` sources the signatures from the SDK so the port cannot silently
 *  drift from the real client. */
export type SandboxProvider = Pick<Daytona, "create" | "get" | "list">;

/** The Daytona region target, defaulting to "us" (unchanged from every prior
 *  call site). Shared by the SDK client and the warm-pool control plane so both
 *  act on the same region. */
const daytonaTarget = (): string => process.env.DAYTONA_TARGET ?? "us";

/** The Daytona control-plane base URL, matching the SDK's own default resolution
 *  (`DAYTONA_API_URL` env, else app.daytona.io). Used by warm-pool.ts, which
 *  talks to the same REST endpoint the SDK client does. */
const daytonaApiUrl = (): string =>
  process.env.DAYTONA_API_URL?.trim() || "https://app.daytona.io/api";

/** Construct the configured sandbox provider. Centralizes the single
 *  `new Daytona(...)` construction for all of backend/src. */
export function daytonaProvider(apiKey: string): SandboxProvider {
  return new Daytona({ apiKey, target: daytonaTarget() });
}

/** Resolved Daytona connection parameters, shared through the port so the
 *  warm-pool module authenticates against the same endpoint/region as the
 *  sandbox client instead of re-deriving them. */
export interface DaytonaApiConfig {
  apiKey: string;
  apiUrl: string;
  target: string;
}

/** The Daytona connection for a given API key (endpoint + region resolved from
 *  the same env the SDK reads). Keeps all Daytona endpoint resolution inside the
 *  port module. */
export function daytonaApiConfig(apiKey: string): DaytonaApiConfig {
  return { apiKey, apiUrl: daytonaApiUrl(), target: daytonaTarget() };
}
