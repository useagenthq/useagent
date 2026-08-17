import { RiKey2Line } from "@remixicon/react";
import type { Metadata } from "next";
import { AppShell } from "@/components/shell/app-shell";
import { LibrarySidebar } from "@/components/shell/library-sidebar";
import { fetchSecrets } from "./secrets-api";
import type { SecretMeta } from "./secrets-data";
import { SecretsManager } from "./secrets-manager";

export const metadata: Metadata = {
  title: "Secrets",
  description: "Encrypted org secrets injected into every sandbox this workspace boots.",
};

export default async function SecretsPage() {
  // SSR the real secret list when the backend is up. A failed fetch becomes
  // `initialError` (a distinct, retryable state) - never swallowed into an empty
  // list, so an outage never reads as "no secrets yet".
  let initial: SecretMeta[] = [];
  let initialError = false;
  try {
    initial = await fetchSecrets();
  } catch {
    initialError = true;
  }

  return (
    <AppShell sidebar={<LibrarySidebar active="secrets" />}>
      <div className="mx-auto w-full max-w-[880px] px-6 py-8 sm:px-10 sm:py-10">
        <div className="flex items-start gap-2.5">
          <RiKey2Line aria-hidden className="mt-0.5 size-5 text-text-strong-950" />
          <div className="flex flex-col gap-0.5">
            <h1 className="text-display-sm text-text-strong-950">Secrets</h1>
            <p className="text-paragraph-sm text-text-sub-600">
              Encrypted values injected into every sandbox this workspace boots - as env vars or
              files
            </p>
          </div>
        </div>

        <div className="mt-8">
          <SecretsManager initial={initial} initialError={initialError} />
        </div>
      </div>
    </AppShell>
  );
}
