import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export function GET(): NextResponse {
  return NextResponse.json({
    status: "ok",
    release: {
      commit: process.env.NEXT_PUBLIC_USEAGENT_RELEASE_COMMIT ?? "dev",
    },
  });
}
