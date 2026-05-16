/**
 * Browser acceptance for a seeded safe-source artifact.
 *
 * Required environment:
 *   WORKPIECE_ARTIFACT_ID=<uuid> WORKPIECE_FRONTEND_URL=http://127.0.0.1:3500 \
 *     bun test/e2e/workpiece-browser-live.ts
 */
import { chromium } from "playwright-core";

const artifactId = process.env.WORKPIECE_ARTIFACT_ID;
if (!artifactId) throw new Error("WORKPIECE_ARTIFACT_ID is required");
const frontendUrl = process.env.WORKPIECE_FRONTEND_URL ?? "http://127.0.0.1:3500";

const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await browser.newPage();
  await page.context().addCookies([
    {
      name: "better-auth.session_token",
      value: "workpiece-browser-dev",
      url: frontendUrl,
    },
  ]);
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => consoleErrors.push(error.message));

  const response = await page.goto(`${frontendUrl}/agent/artifacts/${artifactId}`, {
    waitUntil: "networkidle",
  });
  const editor = page.locator("#workpiece-source");
  await editor.waitFor({ state: "visible" });
  const original = await editor.inputValue();
  const edited = "# Workpiece proof\n\nDurable browser edit.\n";
  await editor.fill(edited);
  await page.getByRole("button", { name: "Save" }).click();
  await page.getByText("Document source · revision 1").waitFor();

  await page.reload({ waitUntil: "networkidle" });
  await editor.waitFor({ state: "visible" });
  const reloaded = await editor.inputValue();
  const revisionVisible = await page
    .getByText("Document source · revision 1")
    .isVisible();

  await page.goto(`${frontendUrl}/agent/artifacts`, { waitUntil: "networkidle" });
  const editAction = await page.locator(`a[href="/agent/artifacts/${artifactId}"]`).count();

  const result = {
    pageStatus: response?.status() ?? null,
    original,
    reloaded,
    revisionVisible,
    editAction,
    consoleErrors,
  };
  console.log(JSON.stringify(result));

  if (response?.status() !== 200) throw new Error("editor page did not return HTTP 200");
  if (!original.includes("Original source.")) throw new Error("original source did not load");
  if (reloaded !== edited) throw new Error("saved state did not survive reload");
  if (!revisionVisible) throw new Error("saved revision was not visible after reload");
  if (editAction < 1) throw new Error("artifact gallery did not expose the edit action");
  if (consoleErrors.length > 0) throw new Error("browser emitted application errors");
} finally {
  await browser.close();
}
