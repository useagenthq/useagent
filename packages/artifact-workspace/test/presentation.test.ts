import { describe, expect, test } from "bun:test";
import {
  coerceDeck,
  coercePresentationState,
  DEFAULT_DECK_THEME,
  deckToSlides,
  isArtifactWorkpieceState,
  migrateSlidesToDeck,
  normalizeDeck,
  PRESENTATION_SCHEMA_VERSION,
  primaryBodyBlock,
  primaryHeadingBlock,
  resolveBlockColor,
  resolveSlideBackground,
  type ArtifactPresentationSlide,
} from "../src";

// A control character the state validator must reject in any text field.
const BELL = String.fromCharCode(7);

describe("presentation v1 -> v2 migration", () => {
  const v1: ArtifactPresentationSlide[] = [
    { title: "Intro", body: "Body text", notes: "Speaker note" },
    { title: "Ask", body: "$25M" },
  ];

  test("migration is deterministic and produces a valid canonical deck", () => {
    const a = migrateSlidesToDeck(v1);
    const b = migrateSlidesToDeck(v1);
    expect(a).toEqual(b);
    expect(a.schemaVersion).toBe(PRESENTATION_SCHEMA_VERSION);
    expect(a.theme).toEqual(DEFAULT_DECK_THEME);
    expect(a.slides).toHaveLength(2);
    expect(a.slides[0]!.id).toBe("slide-1");
    expect(a.slides[0]!.notes).toBe("Speaker note");
    expect(a.slides[1]!.notes).toBeUndefined();
    // The canonical `{ deck }` state passes the shared type guard.
    expect(isArtifactWorkpieceState("presentation", { deck: a })).toBe(true);

    const heading = primaryHeadingBlock(a.slides[0]!);
    const body = primaryBodyBlock(a.slides[0]!);
    expect(heading?.type).toBe("heading");
    expect(heading?.content).toBe("Intro");
    expect(body?.type).toBe("text");
    expect(body?.content).toBe("Body text");
  });

  test("v1 -> v2 -> v1 round-trips losslessly for title/body/notes decks", () => {
    expect(deckToSlides(migrateSlidesToDeck(v1))).toEqual([
      { title: "Intro", body: "Body text", notes: "Speaker note" },
      { title: "Ask", body: "$25M" },
    ]);
  });
});

describe("coercePresentationState (upgrade on load)", () => {
  test("upgrades v1 { slides }, a bare array, and passes through a v2 deck", () => {
    const fromWrapped = coercePresentationState({ slides: [{ title: "T", body: "B" }] });
    expect(fromWrapped?.deck.schemaVersion).toBe(PRESENTATION_SCHEMA_VERSION);
    expect(deckToSlides(fromWrapped!.deck)).toEqual([{ title: "T", body: "B" }]);

    const fromArray = coercePresentationState([{ title: "T", body: "B" }]);
    expect(fromArray).toEqual(fromWrapped);

    const deck = migrateSlidesToDeck([{ title: "T", body: "B" }]);
    expect(coercePresentationState({ deck })).toEqual({ deck });
    // A bare deck object (no `deck` wrapper) is accepted too.
    expect(coerceDeck(deck)).toEqual(deck);
  });

  test("fails closed on unsafe or malformed input", () => {
    // Control characters in text fail closed.
    expect(coercePresentationState({ slides: [{ title: `Bad${BELL}ctrl`, body: "" }] })).toBeNull();
    // Wrong field types fail closed.
    expect(coercePresentationState({ slides: [{ title: 42, body: "" }] })).toBeNull();
    expect(coercePresentationState({ slides: "nope" })).toBeNull();
    expect(coercePresentationState(42)).toBeNull();
    // Invalid theme color fails the whole deck.
    const badTheme = {
      ...migrateSlidesToDeck([{ title: "T", body: "" }]),
      theme: {
        background: { type: "color", color: "red" },
        heading: "#fff",
        body: "#fff",
        accent: "#fff",
      },
    };
    expect(coerceDeck(badTheme)).toBeNull();
    // Unsafe image URL on a block fails closed.
    const deck = migrateSlidesToDeck([{ title: "T", body: "" }]);
    const withBadImage = {
      ...deck,
      slides: [{
        ...deck.slides[0]!,
        blocks: [{ id: "x", type: "image", x: 0, y: 0, w: 10, h: 10, content: "javascript:alert(1)" }],
      }],
    };
    expect(coerceDeck(withBadImage)).toBeNull();
  });

  test("normalizes a safe theme background color shorthand and rejects unsafe strings", () => {
    const deck = migrateSlidesToDeck([{ title: "T", body: "B" }]);
    const shorthand = {
      ...deck,
      theme: { ...deck.theme, background: "#F7F3EA" },
    };

    expect(coerceDeck(shorthand)?.theme.background).toEqual({
      type: "color",
      color: "#F7F3EA",
    });
    expect(coerceDeck({
      ...shorthand,
      theme: { ...shorthand.theme, background: "url(javascript:alert(1))" },
    })).toBeNull();
  });
});

describe("normalizeDeck", () => {
  const base = migrateSlidesToDeck([{ title: "T", body: "" }]);

  test("clamps out-of-range coordinates and drops unknown style keys", () => {
    const normalized = normalizeDeck({
      ...base,
      slides: [{
        id: "s1",
        blocks: [{
          id: "b1",
          type: "text",
          x: 999,
          y: -999,
          w: 0,
          h: 5,
          content: "hi",
          style: { fontSize: 5000, align: "center", bogus: true },
        }],
      }],
    });
    const block = normalized?.slides[0]!.blocks[0]!;
    expect(block!.x).toBe(120);
    expect(block!.y).toBe(-20);
    expect(block!.w).toBe(1);
    expect(block!.style?.fontSize).toBe(400);
    expect(block!.style?.align).toBe("center");
    expect(block!.style).not.toHaveProperty("bogus");
  });

  test("rejects a deck with the wrong schema version or a missing theme", () => {
    expect(normalizeDeck({ ...base, schemaVersion: 1 })).toBeNull();
    expect(normalizeDeck({ ...base, theme: null })).toBeNull();
  });
});

describe("deck render helpers", () => {
  const deck = migrateSlidesToDeck([{ title: "T", body: "B" }]);

  test("resolveBlockColor falls back to the theme role, slide background to the deck", () => {
    const heading = primaryHeadingBlock(deck.slides[0]!)!;
    const body = primaryBodyBlock(deck.slides[0]!)!;
    expect(resolveBlockColor(heading, deck.theme)).toBe(deck.theme.heading);
    expect(resolveBlockColor(body, deck.theme)).toBe(deck.theme.body);
    expect(resolveSlideBackground(deck, deck.slides[0]!)).toEqual(deck.theme.background);

    const override = { type: "color", color: "#123456" } as const;
    expect(resolveSlideBackground(deck, { ...deck.slides[0]!, background: override })).toEqual(
      override,
    );
  });
});
