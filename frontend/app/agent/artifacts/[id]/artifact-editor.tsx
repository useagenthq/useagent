"use client";

import {
  decodeWorkpieceResult,
  type ArtifactDescriptor,
  type ArtifactWorkpieceResult,
} from "@skynet/agent-client";
import { RiArrowLeftLine, RiSaveLine } from "@remixicon/react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { backendFetch } from "@/lib/backend-fetch";

function stateText(result: ArtifactWorkpieceResult): string | null {
  if (!result.state) return null;
  return result.workpiece.kind === "spreadsheet"
    ? "csv" in result.state
      ? result.state.csv
      : null
    : "text" in result.state
      ? result.state.text
      : null;
}

export function ArtifactEditor({ artifact }: { artifact: ArtifactDescriptor }) {
  const workpiece = artifact.workpiece;
  const [revision, setRevision] = useState(workpiece?.state_revision ?? 0);
  const [value, setValue] = useState("");
  const [savedValue, setSavedValue] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!workpiece) return;
    setLoading(true);
    setError(null);
    try {
      const stateResponse = await backendFetch(workpiece.state_url, { cache: "no-store" });
      if (!stateResponse.ok) throw new Error(`state request failed (${stateResponse.status})`);
      const result = decodeWorkpieceResult(await stateResponse.json());
      if (!result) throw new Error("state response was invalid");
      const persisted = stateText(result);
      let text = persisted;
      if (text === null) {
        const sourceResponse = await backendFetch(artifact.preview_url, { cache: "no-store" });
        if (!sourceResponse.ok) {
          throw new Error(`source request failed (${sourceResponse.status})`);
        }
        text = await sourceResponse.text();
      }
      setRevision(result.workpiece.state_revision);
      setValue(text);
      setSavedValue(text);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The workpiece could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, [artifact.preview_url, workpiece]);

  useEffect(() => {
    void load();
  }, [load]);

  async function save() {
    if (!workpiece) return;
    setSaving(true);
    setError(null);
    const state = workpiece.kind === "spreadsheet" ? { csv: value } : { text: value };
    try {
      const response = await backendFetch(workpiece.state_url, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expected_revision: revision, state }),
      });
      const result = decodeWorkpieceResult(await response.json());
      if (response.status === 409 && result) {
        const latest = stateText(result) ?? "";
        setRevision(result.workpiece.state_revision);
        setValue(latest);
        setSavedValue(latest);
        setError("A newer edit was saved. The latest revision has been loaded.");
        return;
      }
      if (!response.ok || !result) throw new Error(`save failed (${response.status})`);
      setRevision(result.workpiece.state_revision);
      setSavedValue(value);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The workpiece could not be saved.");
    } finally {
      setSaving(false);
    }
  }

  if (!workpiece) return null;
  const label = workpiece.kind === "spreadsheet" ? "Spreadsheet source" : "Document source";

  return (
    <main className="mx-auto flex min-h-0 w-full max-w-[1120px] flex-1 flex-col px-6 py-8 sm:px-10 sm:py-10">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <Link
            href="/agent/artifacts"
            className="inline-flex items-center gap-1.5 text-label-sm text-text-sub-600 outline-none hover:text-text-strong-950 focus-visible:underline"
          >
            <RiArrowLeftLine aria-hidden className="size-4" />
            Artifacts
          </Link>
          <h1 className="mt-3 text-display-sm text-text-strong-950">{artifact.name}</h1>
          <p className="mt-1 text-paragraph-sm text-text-sub-600">
            {label} · revision {revision}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void save()}
          disabled={loading || saving || value === savedValue}
          className="inline-flex h-9 items-center gap-2 rounded-lg bg-bg-strong-950 px-4 text-label-sm text-text-white-0 outline-none hover:opacity-90 focus-visible:ring-2 focus-visible:ring-stroke-strong-950 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <RiSaveLine aria-hidden className="size-4" />
          {saving ? "Saving…" : "Save"}
        </button>
      </div>

      {error && (
        <p role="alert" className="mt-5 rounded-lg border border-error-base bg-error-lighter px-4 py-3 text-paragraph-sm text-error-base">
          {error}
        </p>
      )}

      <label htmlFor="workpiece-source" className="mt-6 text-label-sm text-text-strong-950">
        {label}
      </label>
      <textarea
        id="workpiece-source"
        value={value}
        onChange={(event) => setValue(event.currentTarget.value)}
        disabled={loading}
        spellCheck={workpiece.kind !== "spreadsheet"}
        className="mt-2 min-h-[520px] w-full flex-1 resize-y rounded-xl border border-stroke-soft-200 bg-bg-white-0 p-4 font-mono text-paragraph-sm text-text-strong-950 outline-none focus:border-stroke-strong-950 focus:ring-2 focus:ring-stroke-soft-200 disabled:opacity-50"
      />
    </main>
  );
}
