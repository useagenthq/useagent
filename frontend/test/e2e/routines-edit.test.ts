import { expect, test } from "bun:test";
import { type BrowserContext, chromium } from "playwright-core";
import type { ApiBot, ApiRoutine } from "../../components/bots/types";

// Run with a local dev app and at least one bot:
// USEAGENT_E2E_ORIGIN=http://localhost:3400 bun test test/e2e/routines-edit.test.ts
// USEAGENT_E2E_BROWSER selects the installed browser channel (defaults to chrome).
const origin = process.env.USEAGENT_E2E_ORIGIN;

test.skipIf(!origin)("open a routine with saved values, save a change, and cancel without changes", async () => {
  const browser = await chromium.launch({ channel: process.env.USEAGENT_E2E_BROWSER ?? "chrome", headless: true });
  let context: BrowserContext | undefined;
  let routinesUrl: string | undefined;
  let routineId: string | undefined;
  try {
    context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, timezoneId: "UTC" });
    const response = await context.request.get(`${origin}/api/bots`);
    expect(response.ok()).toBe(true);
    const { bots } = await response.json() as { bots: ApiBot[] };
    const bot = bots[0];
    if (!bot) throw new Error("Create a bot in the local app before running this test.");
    routinesUrl = `${origin}/api/bots/${bot.id}/routines`;
    const original = {
      name: `Edit test ${crypto.randomUUID()}`,
      prompt: "Write a short summary.",
      cron: "0 * * * *",
      timezone: "Europe/Bratislava",
      enabled: false,
    };
    const created = await context.request.post(routinesUrl, { data: original });
    expect(created.ok()).toBe(true);
    routineId = (await created.json() as { routine: ApiRoutine }).routine.id;
    const page = await context.newPage();
    await page.goto(`${origin}/bots/${bot.id}`);
    await page.getByRole("button", { name: "Bot details", exact: true }).click();
    const section = page.locator("section").filter({ has: page.getByRole("heading", { name: "Routines", exact: true }) });
    const edit = section.getByRole("button", { name: `Edit ${original.name}`, exact: true });
    await edit.click();
    const name = section.getByLabel("Name", { exact: true });
    const instruction = section.getByRole("textbox", { name: /^Instruction/ });
    const cron = section.getByLabel("Cron expression", { exact: true });
    expect(await name.inputValue()).toBe(original.name);
    expect(await instruction.inputValue()).toBe(original.prompt);
    expect(await cron.inputValue()).toBe(original.cron);

    await name.fill("");
    await instruction.fill("");
    await cron.fill("");
    await section.getByRole("button", { name: "Save changes", exact: true }).click();
    await section.getByText("Give the routine a name.", { exact: true }).waitFor();
    await section.getByText("Say what it should do.", { exact: true }).waitFor();
    await section.getByText("Pick a cadence or enter a cron expression.", { exact: true }).waitFor();

    const updated = { name: `${original.name} updated`, prompt: "Write a daily summary.", cron: "0 10 * * *" };
    await name.fill(updated.name);
    await instruction.fill(updated.prompt);
    await cron.fill(updated.cron);
    const savedResponse = page.waitForResponse((result) => result.url().endsWith(`/routines/${routineId}`) && result.request().method() === "PATCH");
    await section.getByRole("button", { name: "Save changes", exact: true }).click();
    expect((await savedResponse).ok()).toBe(true);
    await section.getByText(updated.name, { exact: true }).waitFor();
    const listed = await context.request.get(routinesUrl);
    const saved = (await listed.json() as { routines: ApiRoutine[] }).routines.filter((routine) => routine.id === routineId);
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ ...updated, enabled: false, timezone: original.timezone });

    await page.reload();
    await page.getByRole("button", { name: "Bot details", exact: true }).click();
    const updatedEdit = section.getByRole("button", { name: `Edit ${updated.name}`, exact: true });
    await updatedEdit.click();
    expect(await name.inputValue()).toBe(updated.name);
    expect(await instruction.inputValue()).toBe(updated.prompt);
    expect(await cron.inputValue()).toBe(updated.cron);
    await name.fill("Unsaved change");
    await instruction.fill("Unsaved instruction");
    await cron.fill("0 11 * * *");
    await section.getByRole("button", { name: "Cancel", exact: true }).click();
    await updatedEdit.click();
    expect(await name.inputValue()).toBe(updated.name);
    expect(await instruction.inputValue()).toBe(updated.prompt);
    expect(await cron.inputValue()).toBe(updated.cron);
  } finally {
    try {
      if (context && routineId) await context.request.delete(`${routinesUrl}/${routineId}`);
    } finally {
      await browser.close();
    }
  }
}, 120_000);
