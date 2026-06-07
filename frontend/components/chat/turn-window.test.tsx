import { describe, expect, test } from "bun:test";
import { createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Turn } from "./conversation";
import { TurnWindow } from "./turn-window";

function turns(count: number): Turn[] {
  return Array.from({ length: count }, (_, index) => ({
    run: {
      id: `run-${index}`,
      status: "completed",
      summary: "done",
    },
    steps: [],
    status: "completed",
    summary: "done",
    live: false,
    liveText: "",
    liveReasoning: "",
  })) as unknown as Turn[];
}

function render(count: number): string {
  return renderToStaticMarkup(
    <TurnWindow
      turns={turns(count)}
      scrollRef={createRef<HTMLDivElement>()}
      renderTurn={(turn, _index, windowOwnsRunMarker) => (
        <div data-run-id={windowOwnsRunMarker ? undefined : turn.run.id}>turn</div>
      )}
    />,
  );
}

describe("TurnWindow rail markers", () => {
  test("short-thread bypass emits exactly one data-run-id per turn", () => {
    const html = render(30);
    expect(html.match(/data-run-id=/g)?.length).toBe(30);
  });

  test("windowed rows emit exactly one data-run-id per turn", () => {
    const html = render(31);
    expect(html.match(/data-run-id=/g)?.length).toBe(31);
    for (let index = 0; index < 31; index++) {
      expect(html.match(new RegExp(`data-run-id="run-${index}"`, "g"))?.length).toBe(1);
    }
  });
});
