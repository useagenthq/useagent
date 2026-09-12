import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { makeBot } from "./bot-fixture";
import { botAssistantIdentity, botForThread, botReadOnlyMessage } from "./identity";

describe("bot identity for threads", () => {
  const nova = makeBot({ id: "nova", name: "Nova", homeThreadId: "home-nova", handoffThreadIds: ["deleg-1", "deleg-2"] });
  const atlas = makeBot({ id: "atlas", name: "Atlas", homeThreadId: "home-atlas" });

  test("a thread resolves to the bot whose home or delegated thread it is", () => {
    expect(botForThread([atlas, nova], "home-nova")?.id).toBe("nova");
    expect(botForThread([atlas, nova], "deleg-2")?.id).toBe("nova");
    expect(botForThread([atlas, nova], "home-atlas")?.id).toBe("atlas");
    expect(botForThread([atlas, nova], "plain-thread")).toBeNull();
    // No roster (bots off, or the lookup failed): a plain thread, never an error.
    expect(botForThread(null, "home-nova")).toBeNull();
  });

  test("the identity carries the bot's name and its own orb at turn-header size", () => {
    const identity = botAssistantIdentity(nova);
    expect(identity.name).toBe("Nova");
    const avatar = renderToStaticMarkup(<>{identity.avatar}</>);
    expect(avatar).toContain("size-5");
    expect(avatar).toContain("--orb-tone:hsl(var(--primary-base))");
  });

  test("an archived bot locks the composer with a way back; an active one does not", () => {
    expect(botReadOnlyMessage(makeBot({ name: "Racer", archived: true }))).toBe("Racer is archived. Restore it to send messages.");
    expect(botReadOnlyMessage(makeBot({ archived: false }))).toBeNull();
  });
});
