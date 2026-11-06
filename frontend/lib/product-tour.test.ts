import {
  finishTour,
  offerTour,
  resetTourForTests,
  startTour,
  subscribeTour,
  tourSeen,
  tourSnapshot,
} from "./product-tour";

const globals = globalThis as { window?: unknown };
let store: Map<string, string>;

beforeEach(() => {
  resetTourForTests();
  store = new Map();
  globals.window = {
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
    },
  };
});

afterEach(() => {
  delete globals.window;
  resetTourForTests();
});

test("the offer is made once: declining is remembered for that person in this browser", () => {
  offerTour("u1");
  expect(tourSnapshot()).toEqual({ phase: "offer", userId: "u1" });
  finishTour("dismissed");
  expect(tourSnapshot()).toEqual({ phase: "idle" });
  expect(store.get("product-tour-seen:u1")).toBe("dismissed");
  expect(tourSeen("u1")).toBe(true);

  offerTour("u1");
  expect(tourSnapshot()).toEqual({ phase: "idle" });
  // Someone else on the same browser is still offered it.
  offerTour("u2");
  expect(tourSnapshot()).toEqual({ phase: "offer", userId: "u2" });
});

test("a browser that refuses storage still does not offer the tour twice on one page", () => {
  globals.window = {
    localStorage: {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    },
  };
  offerTour("u1");
  expect(() => finishTour("dismissed")).not.toThrow();
  offerTour("u1");
  expect(tourSnapshot()).toEqual({ phase: "idle" });
});

test("an offer never interrupts a tour that is already running", () => {
  startTour("u1");
  offerTour("u1");
  expect(tourSnapshot()).toMatchObject({ phase: "touring", userId: "u1" });
});

test("completion is remembered, but the account menu can start the tour again", () => {
  const phases: string[] = [];
  const stop = subscribeTour(() => phases.push(tourSnapshot().phase));
  startTour("u1");
  finishTour("completed");
  expect(store.get("product-tour-seen:u1")).toBe("completed");
  offerTour("u1");
  expect(tourSnapshot()).toEqual({ phase: "idle" });
  startTour("u1");
  stop();
  expect(phases).toEqual(["touring", "idle", "touring"]);
});

test("dismissal remains remembered after the in-memory store resets", () => {
  offerTour("u1");
  finishTour("dismissed");
  resetTourForTests();
  offerTour("u1");
  expect(tourSnapshot()).toEqual({ phase: "idle" });
});

test("a tour started from the menu while signed out remembers nothing and still closes", () => {
  startTour(null);
  finishTour("dismissed");
  expect(tourSnapshot()).toEqual({ phase: "idle" });
  expect(store.size).toBe(0);
});
