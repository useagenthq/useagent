import type { Metadata } from "next";
import { headers } from "next/headers";
import { safeAuthRedirect } from "@/components/auth/safe-redirect";
import { verificationNotice } from "@/components/auth/verification-notice";
import { AuthForm } from "../auth-form";

export async function generateMetadata({
  searchParams,
}: {
  searchParams: Promise<{
    ref?: string | string[];
    [key: string]: unknown;
  }>;
}): Promise<Metadata> {
  const params = await searchParams;
  const ref = Array.isArray(params.ref) ? params.ref[0] : params.ref;
  const isHacktoberfest =
    typeof ref === "string" && ref.toLowerCase() === "hacktoberfest";

  const title = "Sign in - UseAgent";
  const description = isHacktoberfest
    ? "Try UseAgent free with no API key."
    : "Sign in to your UseAgent workspace.";

  // Resolve the real host so the og:image URL works on localhost, tunnel, and production.
  const h = await headers();
  const proto = h.get("x-forwarded-proto") ?? "https";
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "app.useagent.org";
  const imageUrl = `${proto}://${host}/og/01-home.png`;

  return {
    title,
    description,
    openGraph: {
      title,
      description,
      images: [{ url: imageUrl, width: 1600, height: 900, alt: "UseAgent - one interface for every coding agent" }],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [imageUrl],
    },
  };
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{
    redirect_url?: string | string[];
    mode?: string | string[];
    verified?: string | string[];
    declined?: string | string[];
    error?: string | string[];
    ref?: string | string[];
  }>;
}) {
  const { redirect_url, mode, verified, declined, error } = await searchParams;
  return (
    <AuthForm
      callbackURL={safeAuthRedirect(typeof redirect_url === "string" ? redirect_url : null)}
      initialMode={mode === "signup" ? "signup" : "signin"}
      notice={verificationNotice({ verified, declined, error })}
    />
  );
}
