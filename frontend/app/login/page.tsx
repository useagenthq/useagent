import type { Metadata } from "next";

import { AuthForm } from "./auth-form";

export const metadata: Metadata = {
  title: "Sign in - useAgent",
  description: "Sign in to your useAgent workspace.",
};

export default function LoginPage() {
  return <AuthForm />;
}
