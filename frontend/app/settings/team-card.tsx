"use client";

import { RiMailLine, RiUserAddLine } from "@remixicon/react";
import { useState, type FormEvent } from "react";
import { Avatar } from "@/components/base/avatar/avatar";
import { Chip } from "@/components/base/badges/chip";
import { Button } from "@/components/base/buttons/button";
import { InputBase } from "@/components/base/input/input";
import { AVATAR_GRADIENT } from "./general-card";

/**
 * Team section — a static workspace roster plus a local invite form (no auth
 * backend on this surface). Inviting simply flashes a confirmation; nothing is
 * persisted.
 */

type Row = {
  key: string;
  name: string;
  email: string;
  initials: string;
  roleLabel: string;
  emphasizeRole: boolean;
  avatarColor: "neutral" | "blue" | "pink";
  gradient: boolean;
};

const ROSTER: Row[] = [
  { key: "a", name: "Dev User", email: "you@example.com", initials: "A", roleLabel: "Owner", emphasizeRole: true, avatarColor: "neutral", gradient: true },
  { key: "p", name: "Priya Nair", email: "priya@example.com", initials: "P", roleLabel: "Member", emphasizeRole: false, avatarColor: "blue", gradient: false },
  { key: "d", name: "Diego Fuentes", email: "diego@example.com", initials: "D", roleLabel: "Member", emphasizeRole: false, avatarColor: "pink", gradient: false },
];

export function TeamCard() {
  const [email, setEmail] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  function handleInvite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const target = email.trim();
    if (!target || pending) return;
    setPending(true);
    setEmail("");
    setNotice(`Invitation sent to ${target}.`);
    setPending(false);
  }

  return (
    <>
      <div className="flex flex-col">
        {ROSTER.map((row) => (
          <div
            key={row.key}
            className="flex items-center gap-3 border-b border-separator-border py-2.5 last:border-b-0"
          >
            <Avatar
              size="md"
              color={row.avatarColor}
              className={row.gradient ? AVATAR_GRADIENT : undefined}
              initials={row.initials}
            />
            <div className="min-w-0 flex-1">
              <p className="truncate text-body-2-medium text-text-primary">{row.name}</p>
              <p className="truncate text-caption-1-regular text-text-secondary">{row.email}</p>
            </div>
            <Chip variant="caption" color={row.emphasizeRole ? "purple" : "soft"}>
              {row.roleLabel}
            </Chip>
          </div>
        ))}
      </div>

      <form className="flex items-center gap-2 pt-3" onSubmit={handleInvite} noValidate>
        <InputBase
          size="small"
          aria-label="Invite teammate by email"
          type="email"
          placeholder="teammate@company.com"
          leadingIcon={RiMailLine}
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          fieldClassName="min-w-0 flex-1"
        />
        <Button
          className="rounded-full"
          type="submit"
          variant="secondary"
          size="small"
          leadingIcon={RiUserAddLine}
          disabled={pending || !email.trim()}
        >
          Invite member
        </Button>
      </form>

      {notice && <p className="pt-2 text-caption-1-regular text-text-secondary">{notice}</p>}
    </>
  );
}
