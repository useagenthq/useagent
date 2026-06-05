"use client";

import { useEffect, useState } from "react";
import { Avatar } from "@/components/base/avatar/avatar";
import { Chip } from "@/components/base/badges/chip";
import { backendFetch } from "@/lib/backend-fetch";
import { AVATAR_GRADIENT } from "./general-card";

/**
 * Team section - the REAL workspace roster from better-auth's organization
 * plugin (list -> list-members). No local mock data and no invite form:
 * invitations need configured email delivery, so until that exists this
 * surface only reports the truth.
 */

interface MemberRow {
  id: string;
  name: string;
  email: string;
  role: string;
}

const AVATAR_COLORS = ["neutral", "blue", "pink"] as const;

async function fetchMembers(): Promise<MemberRow[]> {
  const orgsRes = await backendFetch("/api/auth/organization/list");
  if (!orgsRes.ok) return [];
  const orgs = (await orgsRes.json()) as { id: string }[] | null;
  const orgId = orgs?.[0]?.id;
  if (!orgId) return [];
  const res = await backendFetch(
    `/api/auth/organization/list-members?organizationId=${encodeURIComponent(orgId)}`,
  );
  if (!res.ok) return [];
  const data = (await res.json()) as {
    members?: {
      id: string;
      role: string;
      user?: { name?: string | null; email?: string | null };
    }[];
  };
  return (data.members ?? []).map((m) => ({
    id: m.id,
    name: m.user?.name?.trim() || m.user?.email || "Member",
    email: m.user?.email ?? "",
    role: m.role,
  }));
}

export function TeamCard() {
  const [members, setMembers] = useState<MemberRow[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchMembers().then((rows) => {
      if (!cancelled) setMembers(rows);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (members === null) {
    return <p className="py-2.5 text-caption-1-regular text-text-tertiary">Loading members...</p>;
  }
  if (members.length === 0) {
    return (
      <p className="py-2.5 text-caption-1-regular text-text-tertiary">
        No members visible for this workspace.
      </p>
    );
  }
  return (
    <div className="flex flex-col">
      {members.map((row, index) => {
        const owner = row.role === "owner";
        return (
          <div
            key={row.id}
            className="flex items-center gap-3 border-b border-separator-border py-2.5 last:border-b-0"
          >
            <Avatar
              size="md"
              color={AVATAR_COLORS[index % AVATAR_COLORS.length]}
              className={owner ? AVATAR_GRADIENT : undefined}
              initials={(row.name.charAt(0) || "?").toUpperCase()}
            />
            <div className="min-w-0 flex-1">
              <p className="truncate text-body-2-medium text-text-primary">{row.name}</p>
              <p className="truncate text-caption-1-regular text-text-secondary">{row.email}</p>
            </div>
            <Chip variant="caption" color={owner ? "purple" : "soft"}>
              {owner ? "Owner" : row.role.charAt(0).toUpperCase() + row.role.slice(1)}
            </Chip>
          </div>
        );
      })}
    </div>
  );
}
