"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/base/buttons/button";
import * as Modal from "@/components/base/modal/modal";
import { backendFetch } from "@/lib/backend-fetch";
import { type ApiBot, apiErrorText, OFFLINE_MESSAGE } from "./types";

/** null on success, else the message to show. */
async function setArchived(bot: ApiBot, archived: boolean): Promise<string | null> {
  try {
    const response = await backendFetch(`/api/bots/${bot.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ archived }),
    });
    if (response.ok) return null;
    const data = await response.json().catch(() => ({}));
    return apiErrorText(data, archived ? "Unable to archive the bot. Try again." : "Unable to restore the bot. Try again.");
  } catch {
    return OFFLINE_MESSAGE;
  }
}

/**
 * Foot of the details drawer. Archiving spells out the consequence before it
 * happens; an archived bot's page offers the way back.
 */
export function ArchiveBotButton({ bot }: { bot: ApiBot }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const apply = async (archived: boolean) => {
    if (busy) return;
    setBusy(true);
    const failure = await setArchived(bot, archived);
    setBusy(false);
    setError(failure);
    if (failure) return;
    setConfirming(false);
    if (archived) router.push("/bots");
    router.refresh();
  };

  return (
    <div className="flex flex-col items-start gap-2 border-t border-border-button-default pt-5">
      {bot.archived ? (
        <Button variant="secondary" size="small" className="rounded-full" onClick={() => void apply(false)}>
          {busy ? "Restoring…" : "Restore bot"}
        </Button>
      ) : (
        <Button variant="secondary" size="small" className="rounded-full" onClick={() => setConfirming(true)}>
          Archive bot
        </Button>
      )}
      {error && !confirming && (
        <p role="alert" className="text-caption-1-regular text-text-error-primary">
          {error}
        </p>
      )}
      <Modal.Root open={confirming} onOpenChange={setConfirming}>
        <Modal.Content className="max-w-[400px] rounded-2xl border border-border-button-default bg-background-primary-default shadow-dropdown">
          <Modal.Header
            title={`Archive ${bot.name}?`}
            description="Its thread stays readable, it stops appearing in @mentions and the roster."
          />
          <Modal.Footer>
            <span role="alert" className="text-caption-1-regular text-text-error-primary">
              {error ?? ""}
            </span>
            <div className="flex items-center gap-2">
              <Modal.Close asChild>
                <Button variant="secondary" size="small">
                  Cancel
                </Button>
              </Modal.Close>
              <Button variant="primary" size="small" onClick={() => void apply(true)}>
                {busy ? "Archiving…" : "Archive bot"}
              </Button>
            </div>
          </Modal.Footer>
        </Modal.Content>
      </Modal.Root>
    </div>
  );
}
