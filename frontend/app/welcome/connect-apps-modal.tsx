"use client";

import { RiArrowRightUpLine } from "@remixicon/react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import * as Button from "@/components/ui/button";
import * as Modal from "@/components/ui/modal";
import { TerminalCard } from "./terminal-card";

/**
 * "Connect your apps" — a trigger button plus the AlignUI modal it opens. The
 * modal is a rounded card with a pastel gradient art header (holding a compact
 * terminal card), a short pitch, and a full-width "Explore" action that routes
 * to the apps marketplace.
 */
export function ConnectAppsModal() {
  const router = useRouter();
  const [open, setOpen] = useState(false);

  return (
    <Modal.Root open={open} onOpenChange={setOpen}>
      <Modal.Trigger asChild>
        <Button.Root className="rounded-full" variant="neutral" mode="stroke">
          Explore apps
          <Button.Icon as={RiArrowRightUpLine} />
        </Button.Root>
      </Modal.Trigger>

      <Modal.Content className="max-w-[380px] overflow-hidden">
        {/* Art header — pastel gradient with a compact terminal card. */}
        <div className="overflow-hidden bg-linear-135 from-pink-300 via-purple-300 to-sky-300 pl-6 pt-5">
          <TerminalCard
            size="compact"
            className="rounded-b-none rounded-tr-none border-b-0 border-r-0 shadow-regular-md"
          />
        </div>

        {/* Body */}
        <div className="flex flex-col gap-4 p-6">
          <div className="flex flex-col gap-1.5">
            <Modal.Title className="text-title-h6 text-text-strong-950">
              Connect your apps
            </Modal.Title>
            <Modal.Description className="text-paragraph-sm text-text-sub-600">
              Link your apps to unify data and automate work across your day
            </Modal.Description>
          </div>
          <Button.Root
            className="rounded-full w-full"
            onClick={() => {
              setOpen(false);
              router.push("/apps");
            }}
          >
            Explore
          </Button.Root>
        </div>
      </Modal.Content>
    </Modal.Root>
  );
}
