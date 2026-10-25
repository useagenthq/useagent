"use client";

import { RiDeleteBinLine, RiFileCopyLine } from "@remixicon/react";
import { useCallback, useEffect, useState } from "react";
import { Avatar } from "@/components/base/avatar/avatar";
import { Chip } from "@/components/base/badges/chip";
import { Button } from "@/components/base/buttons/button";
import { IconButton } from "@/components/base/buttons/icon-button";
import { Input } from "@/components/base/input/input";
import * as Modal from "@/components/base/modal/modal";
import { Select, SelectItem } from "@/components/base/select/select";
import { ROLE_LABEL, useAuthConfig, useSession } from "@/lib/auth";
import { AVATAR_GRADIENT } from "./general-card";
import { relativeTime } from "@/utils/format";
import {
  type AccessRequest,
  allowAccessRequest,
  cancelInvitation,
  canManageTeam,
  denyAccessRequest,
  fetchTeam,
  invitationHref,
  inviteMember,
  type MemberRole,
  type PendingInvitation,
  removeMember,
  resendInvitation,
  type Team,
  type TeamMember,
  updateMemberRole,
} from "./team-api";

/**
 * Team section: the organisation's members and pending invitations from
 * better-auth's organization plugin. Owners and admins invite, change roles
 * and remove; members see the list. An invitation is always available as a
 * link, and goes out as an email when the deployment delivers mail.
 */

const AVATAR_COLORS = ["neutral", "blue", "pink"] as const;

/** Which roles the acting person may hand out: only an owner makes owners. */
export function assignableRoles(myRole: MemberRole | null): readonly MemberRole[] {
  return myRole === "owner" ? ["owner", "admin", "member"] : ["admin", "member"];
}

/** Whether the acting person may change or remove this member. Nobody edits
 * themselves here, and only an owner touches another owner. */
export function canEditMember(
  myRole: MemberRole | null,
  me: string | null,
  target: TeamMember,
): boolean {
  if (!canManageTeam(myRole) || target.userId === me) return false;
  return target.role !== "owner" || myRole === "owner";
}

function expiryText(iso: string): string {
  const days = Math.max(0, Math.ceil((Date.parse(iso) - Date.now()) / 86_400_000));
  return days <= 1 ? "expires within a day" : `expires in ${days} days`;
}

export function TeamCard() {
  const { session, loading: sessionLoading } = useSession();
  const config = useAuthConfig();
  const [team, setTeam] = useState<Team | null>(null);
  const [failed, setFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [inviting, setInviting] = useState(false);

  const me = session?.user.id ?? null;

  const load = useCallback(async () => {
    // Without a session (the open dev org) the list still loads, read-only.
    try {
      setTeam(await fetchTeam({ userId: me }));
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [me]);

  useEffect(() => {
    if (!sessionLoading) void load();
  }, [load, sessionLoading]);

  const myRole = team?.myRole ?? null;
  const manage = canManageTeam(myRole);

  const act = async (key: string, work: () => Promise<void>) => {
    setBusy(key);
    setError(null);
    try {
      await work();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(null);
    }
  };

  if (failed) {
    return (
      <p className="py-2.5 text-caption-1-regular text-text-error-primary">
        Could not load the team.
      </p>
    );
  }
  if (team === null) {
    return <p className="py-2.5 text-caption-1-regular text-text-tertiary">Loading members...</p>;
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-caption-1-regular text-text-tertiary">
          {team.members.length} {team.members.length === 1 ? "member" : "members"}
          {team.invitations.length > 0 ? `, ${team.invitations.length} invited` : ""}
        </p>
        {manage && (
          <Button variant="secondary" size="small" onClick={() => setInviting(true)}>
            Invite
          </Button>
        )}
      </div>

      {error && (
        <p role="alert" className="text-caption-1-regular text-text-error-primary">
          {error}
        </p>
      )}

      <div className="flex flex-col">
        {team.members.map((row, index) => {
          const editable = canEditMember(myRole, me, row);
          return (
            <div
              key={row.id}
              data-testid="team-member"
              className="flex items-center gap-3 border-b border-separator-border py-2.5 last:border-b-0"
            >
              <Avatar
                size="md"
                color={AVATAR_COLORS[index % AVATAR_COLORS.length]}
                className={row.role === "owner" ? AVATAR_GRADIENT : undefined}
                src={row.image ?? undefined}
                alt={row.name}
                initials={(row.name.charAt(0) || "?").toUpperCase()}
              />
              <div className="min-w-0 flex-1">
                <p className="truncate text-body-2-medium text-text-primary">
                  {row.name}
                  {row.userId === me ? <span className="text-text-tertiary"> (you)</span> : null}
                </p>
                <p className="truncate text-caption-1-regular text-text-secondary">
                  {row.email} · joined {relativeTime(row.joinedAt)}
                </p>
              </div>
              {editable ? (
                <>
                  <Select
                    aria-label={`Role of ${row.name}`}
                    selectedKey={row.role}
                    isDisabled={busy !== null}
                    onSelectionChange={(key) => {
                      const role = String(key) as MemberRole;
                      if (role !== row.role)
                        void act(row.id, () => updateMemberRole(team.organizationId, row.id, role));
                    }}
                  >
                    {assignableRoles(myRole).map((role) => (
                      <SelectItem key={role} id={role} textValue={ROLE_LABEL[role]}>
                        {ROLE_LABEL[role]}
                      </SelectItem>
                    ))}
                  </Select>
                  <IconButton
                    icon={RiDeleteBinLine}
                    size="small"
                    aria-label={`Remove ${row.name}`}
                    disabled={busy !== null}
                    onClick={() => {
                      if (window.confirm(`Remove ${row.name} from this workspace?`)) {
                        void act(row.id, () => removeMember(team.organizationId, row.id));
                      }
                    }}
                  />
                </>
              ) : (
                <Chip variant="caption" color={row.role === "owner" ? "purple" : "soft"}>
                  {ROLE_LABEL[row.role]}
                </Chip>
              )}
            </div>
          );
        })}
      </div>

      {team.requests.length > 0 && (
        <div className="flex flex-col gap-2">
          <p className="text-caption-1-regular text-text-tertiary">Asking to join from Slack</p>
          <div className="flex flex-col">
            {team.requests.map((row) => (
              <AccessRequestRow
                key={row.id}
                request={row}
                busy={busy === row.id}
                onAllow={(email) =>
                  act(row.id, () => allowAccessRequest(team.organizationId, row.id, email))
                }
                onDeny={() => act(row.id, () => denyAccessRequest(team.organizationId, row.id))}
              />
            ))}
          </div>
        </div>
      )}

      {team.invitations.length > 0 && (
        <div className="flex flex-col gap-2">
          <p className="text-caption-1-regular text-text-tertiary">Invited</p>
          <div className="flex flex-col">
            {team.invitations.map((row) => (
              <InvitationRow
                key={row.id}
                invitation={row}
                manage={manage}
                canResend={assignableRoles(myRole).includes(row.role)}
                mailed={config?.invitationEmail ?? null}
                busy={busy === row.id}
                onResend={() => act(row.id, () => resendInvitation(team.organizationId, row))}
                onCancel={() => act(row.id, () => cancelInvitation(team.organizationId, row.id))}
              />
            ))}
          </div>
        </div>
      )}

      {manage && (
        <InviteDialog
          open={inviting}
          onOpenChange={setInviting}
          organizationId={team.organizationId}
          roles={assignableRoles(myRole)}
          emailDelivery={config?.invitationEmail ?? null}
          onInvited={() => void load()}
        />
      )}
    </div>
  );
}

function InvitationRow({
  invitation,
  manage,
  canResend,
  mailed,
  busy,
  onResend,
  onCancel,
}: {
  invitation: PendingInvitation;
  manage: boolean;
  /** Resending repeats the invited role, which only an owner may do for an owner invitation. */
  canResend: boolean;
  /** Whether a resend sends mail; when it certainly does not, the action only renews the link. */
  mailed: boolean | null;
  busy: boolean;
  onResend: () => void;
  onCancel: () => void;
}) {
  return (
    <div
      data-testid="team-invitation"
      className="flex items-center gap-3 border-b border-separator-border py-2.5 last:border-b-0"
    >
      <div className="min-w-0 flex-1">
        <p className="truncate text-body-2-medium text-text-primary">{invitation.email}</p>
        <p className="truncate text-caption-1-regular text-text-secondary">
          {ROLE_LABEL[invitation.role]}, {expiryText(invitation.expiresAt)}
        </p>
      </div>
      <CopyLinkButton href={invitationHref(invitation.id, window.location.origin)} />
      {manage && canResend && (
        <Button variant="ghost" size="xs" disabled={busy} onClick={onResend}>
          {mailed === false ? "Renew link" : "Resend"}
        </Button>
      )}
      {manage && (
        <Button variant="ghost" size="xs" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      )}
    </div>
  );
}

/** The address Allow will use: Slack's word when it has one (it may arrive while
 *  the row is on screen), else what the admin typed. */
export function decisionEmail(
  request: Pick<AccessRequest, "email" | "account">,
  typed: string,
): string | null {
  // An account the sender already owns here wins: Allow restores it whatever
  // Slack says now or an admin types.
  return request.account ?? request.email ?? (typed.trim() || null);
}

/** A Slack sender nobody has let in yet. When Slack shared their address, Allow
 *  lets them in at once. When it did not, the admin types an address and that
 *  person is invited; they are let in when they accept on the web. */
function AccessRequestRow({
  request,
  busy,
  onAllow,
  onDeny,
}: {
  request: AccessRequest;
  busy: boolean;
  onAllow: (email: string | null) => void;
  onDeny: () => void;
}) {
  const [email, setEmail] = useState(request.email ?? "");
  const known = request.email !== null || request.account !== null;
  const decision = decisionEmail(request, email);
  return (
    <div
      data-testid="team-access-request"
      className="flex flex-wrap items-center gap-3 border-b border-separator-border py-2.5 last:border-b-0"
    >
      <Avatar
        size="md"
        color="blue"
        src={request.image ?? undefined}
        alt={request.name}
        initials={(request.name.charAt(0) || "?").toUpperCase()}
      />
      <div className="min-w-0 flex-1">
        <p className="truncate text-body-2-medium text-text-primary">{request.name}</p>
        <p className="truncate text-caption-1-regular text-text-secondary">
          {request.account
            ? `previously let in as ${request.account}`
            : (request.email ?? "Email unknown")}{" "}
          · asked {relativeTime(request.createdAt)}
        </p>
      </div>
      {!known && (
        <Input
          aria-label={`Email for ${request.name}`}
          type="email"
          placeholder="name@company.com"
          value={email}
          onChange={setEmail}
          className="w-56"
        />
      )}
      <Button
        variant="primary"
        size="xs"
        disabled={busy || !decision}
        onClick={() => onAllow(decision)}
      >
        {known ? "Allow" : "Invite"}
      </Button>
      <Button variant="ghost" size="xs" disabled={busy} onClick={onDeny}>
        Deny
      </Button>
    </div>
  );
}

/** What to tell the inviter about the link: honest about mail when the server
 *  has said whether it sends any, neutral while that is unknown. */
export function deliveryCopy(email: string, delivery: boolean | null): string {
  if (delivery === true)
    return `Invitation ready for ${email}. It goes out by email when delivery works; this link works either way.`;
  if (delivery === false)
    return `This deployment does not send email. Share this link with ${email}.`;
  return `Invitation ready for ${email}. Share this link with them.`;
}

function CopyLinkButton({ href }: { href: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="ghost"
      size="xs"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(href);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          window.prompt("Copy the invitation link", href);
        }
      }}
    >
      <RiFileCopyLine className="size-3.5" aria-hidden />
      {copied ? "Copied" : "Copy link"}
    </Button>
  );
}

export function InviteDialog({
  open,
  onOpenChange,
  organizationId,
  roles,
  emailDelivery,
  onInvited,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  organizationId: string;
  roles: readonly MemberRole[];
  emailDelivery: boolean | null;
  onInvited: () => void;
}) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<MemberRole>("member");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<PendingInvitation | null>(null);

  const close = (next: boolean) => {
    if (!next) {
      setEmail("");
      setRole("member");
      setError(null);
      setCreated(null);
    }
    onOpenChange(next);
  };

  const submit = async () => {
    const address = email.trim();
    if (!address.includes("@")) {
      setError("Enter an email address.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      setCreated(await inviteMember(organizationId, address, role));
      onInvited();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not send the invitation.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal.Root open={open} onOpenChange={close}>
      <Modal.Content className="max-w-[440px] rounded-2xl border border-border-button-default bg-background-primary-default shadow-dropdown">
        <Modal.Header>
          <Modal.Title className="text-title-3-medium text-text-primary">
            Invite to the workspace
          </Modal.Title>
        </Modal.Header>
        <Modal.Body className="flex flex-col gap-4 pt-2">
          {created ? (
            <>
              <p className="text-body-2-regular text-text-primary">
                {deliveryCopy(created.email, emailDelivery)}
              </p>
              <div className="flex items-center gap-2 rounded-lg border border-border-button-default px-3 py-2">
                <code className="min-w-0 flex-1 truncate text-caption-1-regular text-text-secondary">
                  {invitationHref(created.id, window.location.origin)}
                </code>
                <CopyLinkButton href={invitationHref(created.id, window.location.origin)} />
              </div>
              <p className="text-caption-1-regular text-text-tertiary">
                They sign in with that email address. The link {expiryText(created.expiresAt)}.
              </p>
            </>
          ) : (
            <>
              <Input
                label="Email"
                placeholder="name@company.com"
                type="email"
                value={email}
                onChange={setEmail}
                isInvalid={error !== null}
                hint={error ?? undefined}
              />
              <div className="flex flex-col gap-1.5">
                <span className="text-body-2-medium text-text-primary">Role</span>
                <Select
                  aria-label="Role"
                  selectedKey={role}
                  onSelectionChange={(key) => setRole(String(key) as MemberRole)}
                >
                  {roles.map((option) => (
                    <SelectItem key={option} id={option} textValue={ROLE_LABEL[option]}>
                      {ROLE_LABEL[option]}
                    </SelectItem>
                  ))}
                </Select>
                <p className="text-caption-1-regular text-text-tertiary">
                  Admins manage people, secrets and machines. Members run work.
                </p>
              </div>
            </>
          )}
        </Modal.Body>
        <Modal.Footer>
          <Modal.Close asChild>
            <Button variant="secondary" size="small">
              {created ? "Done" : "Cancel"}
            </Button>
          </Modal.Close>
          {!created && (
            <Button variant="primary" size="small" disabled={busy} onClick={() => void submit()}>
              {busy ? "Inviting..." : "Send invite"}
            </Button>
          )}
        </Modal.Footer>
      </Modal.Content>
    </Modal.Root>
  );
}
