import type { Metadata } from "next";
import { safeAuthRedirect } from "@/components/auth/safe-redirect";
import { verificationNotice } from "@/components/auth/verification-notice";
import { AuthForm } from "../auth-form";

export const metadata: Metadata = {
  title: "Sign in - UseAgent",
  description: "Sign in to your UseAgent workspace.",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{
    redirect_url?: string | string[];
    mode?: string | string[];
    verified?: string | string[];
    declined?: string | string[];
    error?: string | string[];
    via?: string | string[];
  }>;
}) {
  const { redirect_url, mode, verified, declined, error, via } = await searchParams;
  return (
    <AuthForm
      callbackURL={safeAuthRedirect(typeof redirect_url === "string" ? redirect_url : null)}
      initialMode={mode === "signup" ? "signup" : "signin"}
      notice={verificationNotice({ verified, declined, error, via })}
    />
  );
}
