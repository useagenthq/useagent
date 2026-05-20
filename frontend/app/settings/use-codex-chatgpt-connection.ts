"use client";

import { useCallback, useEffect, useState } from "react";
import { useOrgChanges } from "@/hooks/use-org-changes";
import {
  cancelCodexChatGptLogin,
  fetchCodexChatGptStatus,
  revokeCodexChatGptLogin,
  startCodexChatGptLogin,
} from "./provider-connections-api";
import type {
  CodexChatGptLogin,
  CodexChatGptStatus,
} from "./provider-connections-data";

const CODEX_STATUS_POLL_MS = 2_000;

type CodexConnectionAction = "connect" | "cancel" | "revoke" | "status";

export function useCodexChatGptConnection(onChanged: () => Promise<void>) {
  const [status, setStatus] = useState<CodexChatGptStatus | null>(null);
  const [login, setLogin] = useState<CodexChatGptLogin | null>(null);
  const [busy, setBusy] = useState<CodexConnectionAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const refreshStatus = useCallback(async () => {
    setBusy((current) => current ?? "status");
    try {
      const fresh = await fetchCodexChatGptStatus();
      setStatus(fresh);
      setError(null);
      if (fresh.account?.authMode === "chatgpt") {
        setLogin(null);
        await onChanged();
      }
    } catch {
      setError("Couldn't read the ChatGPT connection status.");
    } finally {
      setBusy((current) => (current === "status" ? null : current));
    }
  }, [onChanged]);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  useOrgChanges((change) => {
    if (change.type === "provider_connection") void refreshStatus();
  });

  useEffect(() => {
    if (!login) return;
    const timer = window.setInterval(() => {
      void refreshStatus();
    }, CODEX_STATUS_POLL_MS);
    return () => window.clearInterval(timer);
  }, [login, refreshStatus]);

  const startLogin = useCallback(async () => {
    setBusy("connect");
    setError(null);
    setCopied(false);
    try {
      setLogin(await startCodexChatGptLogin());
    } catch {
      setError("Couldn't start the trusted ChatGPT login flow.");
    } finally {
      setBusy(null);
    }
  }, []);

  const cancelLogin = useCallback(async () => {
    if (!login) return;
    setBusy("cancel");
    setError(null);
    try {
      await cancelCodexChatGptLogin({ loginId: login.loginId });
      setLogin(null);
      await refreshStatus();
    } catch {
      setError("Couldn't cancel the pending ChatGPT login.");
    } finally {
      setBusy(null);
    }
  }, [login, refreshStatus]);

  const revokeLogin = useCallback(async () => {
    setBusy("revoke");
    setError(null);
    try {
      await revokeCodexChatGptLogin();
      setStatus(null);
      setLogin(null);
      await onChanged();
      await refreshStatus();
    } catch {
      setError("Couldn't log out of the connected ChatGPT account.");
    } finally {
      setBusy(null);
    }
  }, [onChanged, refreshStatus]);

  const copyDeviceCode = useCallback(async () => {
    if (login?.type !== "chatgptDeviceCode") return;
    await navigator.clipboard?.writeText(login.userCode);
    setCopied(true);
  }, [login]);

  return {
    busy,
    cancelLogin,
    copied,
    copyDeviceCode,
    error,
    login,
    refreshStatus,
    revokeLogin,
    startLogin,
    status,
  };
}
