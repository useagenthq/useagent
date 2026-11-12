import { expect, test } from "bun:test";
import { NextRequest } from "next/server";
import { proxy } from "@/proxy";
import LoginPage from "./[[...login]]/page";

test("login preserves internal redirects and rejects malformed or external normalization", async () => {
  for (const [redirect_url, callbackURL] of [
    ["/agent/new?desktop=1", "/agent/new?desktop=1"],
    ["/agent/new?prompt=Make%20a%20to-do%20app", "/agent/new?prompt=Make%20a%20to-do%20app"],
    ["https://attacker.example/agent/new", "/"],
    ["//attacker.example/agent/new", "/"],
    ["/\\x//attacker.example", "/"],
    ["/\\[", "/"],
    ["/a/..//attacker.example", "/"],
  ]) {
    const page = await LoginPage({ searchParams: Promise.resolve({ redirect_url }) });
    expect(page.props).toMatchObject({ callbackURL });
  }
});

test("a signed-out visit signs in to exactly the page the proxy kept, link included", async () => {
  for (const path of ["/agent/new?prompt=Make%20a%20to-do%20app", "/session/run-1", "/settings?tab=keys"]) {
    const location = proxy(new NextRequest(`https://useagent.example.com${path}`)).headers.get("location");
    const redirect_url = new URL(location ?? "").searchParams.get("redirect_url") ?? undefined;
    const page = await LoginPage({ searchParams: Promise.resolve({ redirect_url }) });
    expect([path, page.props]).toMatchObject([path, { callbackURL: path }]);
  }
});
