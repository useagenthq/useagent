import type { SandboxPreviewLink, SandboxProviderKind } from "@useagent/sandbox-contract";

/** The headers a preview link's token must travel in, per provider. */
export function previewAuthHeaders(token: string, kind: SandboxProviderKind): Record<string, string> {
  if (!token) return {};
  // Box: the hosted-port token is exchanged once for a port-auth cookie; that cookie is the token we keep.
  if (kind === "box") return { cookie: `_port_auth=${token}` };
  return kind === "daytona"
    ? { "x-daytona-preview-token": token }
    : {
        "cube-traffic-access-token": token,
        "e2b-traffic-access-token": token,
      };
}

/** What every preview consumer keeps from a link: origin, token, auth headers. */
export interface PreviewLinkBase {
  readonly baseUrl: string;
  readonly token: string;
  readonly headers: Readonly<Record<string, string>>;
}

export function previewLinkBase(link: SandboxPreviewLink, fallbackKind: SandboxProviderKind): PreviewLinkBase {
  const token = link.token ?? "";
  return { baseUrl: link.url.replace(/\/+$/, ""), token, headers: link.headers ?? previewAuthHeaders(token, fallbackKind) };
}
