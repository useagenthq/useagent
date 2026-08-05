"use client";

import { RiMailLine, RiUserAddLine } from "@remixicon/react";
import { useState, type FormEvent } from "react";
import * as Avatar from "@/components/ui/avatar";
import * as Badge from "@/components/ui/badge";
import * as Button from "@/components/ui/button";
import * as Input from "@/components/ui/input";
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
  avatarColor: "gray" | "blue" | "purple";
  gradient: boolean;
};

const ROSTER: Row[] = [
  { key: "a", name: "Dev User", email: "you@example.com", initials: "A", roleLabel: "Owner", emphasizeRole: true, avatarColor: "gray", gradient: true },
  { key: "p", name: "Priya Nair", email: "priya@example.com", initials: "P", roleLabel: "Member", emphasizeRole: false, avatarColor: "blue", gradient: false },
  { key: "d", name: "Diego Fuentes", email: "diego@example.com", initials: "D", roleLabel: "Member", emphasizeRole: false, avatarColor: "purple", gradient: false },
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
            className="flex items-center gap-3 border-b border-stroke-soft-200 py-2.5 last:border-b-0"
          >
            <Avatar.Root
              size="32"
              color={row.avatarColor}
              className={row.gradient ? AVATAR_GRADIENT : undefined}
            >
              {row.initials}
            </Avatar.Root>
            <div className="min-w-0 flex-1">
              <p className="truncate text-label-sm text-text-strong-950">{row.name}</p>
              <p className="truncate text-paragraph-xs text-text-sub-600">{row.email}</p>
            </div>
            <Badge.Root variant="light" size="medium" color={row.emphasizeRole ? "purple" : "gray"}>
              {row.roleLabel}
            </Badge.Root>
          </div>
        ))}
      </div>

      <form className="flex items-center gap-2 pt-3" onSubmit={handleInvite} noValidate>
        <Input.Root size="small" className="min-w-0 flex-1">
          <Input.Wrapper>
            <Input.Icon as={RiMailLine} />
            <Input.Input
              aria-label="Invite teammate by email"
              type="email"
              placeholder="teammate@company.com"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </Input.Wrapper>
        </Input.Root>
        <Button.Root className="rounded-full" type="submit" variant="neutral" mode="stroke" size="small" disabled={pending || !email.trim()}>
          <Button.Icon as={RiUserAddLine} />
          Invite member
        </Button.Root>
      </form>

      {notice && <p className="pt-2 text-paragraph-xs text-text-sub-600">{notice}</p>}
    </>
  );
}
