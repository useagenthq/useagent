import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import * as Modal from "@/components/base/modal/modal";
import { TOUR_STEPS, TourOfferCard, TourStepCard } from "./product-tour-overlay";

const noop = () => {};

test("the invitation can be declined and explains how to reopen the tour", () => {
  const html = renderToStaticMarkup(<TourOfferCard onStart={noop} onDecline={noop} />);
  expect(html).toContain("Welcome to UseAgent");
  expect(html).toContain("Start tour");
  expect(html).toContain("Not now");
  expect(html).toContain("account menu");
  expect(html).not.toContain('aria-modal="true"');
});

test("the introduction has four steps and uses plain words", () => {
  expect(TOUR_STEPS).toHaveLength(4);
  for (const step of TOUR_STEPS) {
    expect(`${step.title} ${step.body}`).not.toMatch(/engine|artifacts|sandbox|write-only|—/i);
  }
});

test("Back appears after the first step and settings is offered only at the end", () => {
  const render = (index: number) => renderToStaticMarkup(
    <Modal.Root open>
      <TourStepCard index={index} onBack={noop} onNext={noop} onSettings={noop} />
    </Modal.Root>,
  );
  const first = render(0);
  expect(first).toContain("1 of 4");
  expect(first).toContain(">Next<");
  expect(first).not.toContain(">Back<");
  expect(first).not.toContain("Open settings");
  const last = render(3);
  expect(last).toContain("4 of 4");
  expect(last).toContain(">Back<");
  expect(last).toContain(">Done<");
  expect(last).toContain("Open settings");
  expect(last).toContain("Provided by this deployment");
});
