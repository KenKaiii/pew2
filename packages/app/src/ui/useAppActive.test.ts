import { expect, mock, test } from "bun:test";

/** The three states that matter here; `AppState` reports others on Android. */
type Status = "active" | "inactive" | "background";

/**
 * `react-native` cannot be imported here — it ships Flow-typed source the test
 * runner cannot parse — so `AppState` is stubbed before the module under test
 * evaluates. Only the two members it touches are needed: the state it starts
 * from, and the change listener it registers.
 *
 * The stub keeps that listener, and every test below drives the store through
 * it. That is deliberately the real path rather than a test-only setter: a
 * setter would still pass if the module stopped subscribing to `AppState`
 * altogether, which in the app would freeze the answer at whatever it was on
 * launch and quietly leave every animation running in the background forever.
 */
let registered: ((next: Status) => void) | undefined;

// `void`: this returns a promise the linter insists on, and the module registry
// is populated synchronously — awaiting at the top level would be the only
// statement in the file that needs the suite to be async.
void mock.module("react-native", () => ({
  AppState: {
    currentState: "active",
    addEventListener: (event: string, handler: (next: Status) => void) => {
      if (event === "change") registered = handler;
      return { remove: () => {} };
    },
  },
}));

// Dynamic, so the stub is installed before this module evaluates; a static
// import would be hoisted above it.
const { isAppActive, subscribeAppActive } = await import("./useAppActive");

function setAppState(next: Status) {
  if (!registered) throw new Error("useAppActive registered no change listener");
  registered(next);
}

test("the store subscribes to AppState on import", () => {
  // Everything else here depends on this, and without it the store would report
  // the launch state forever.
  expect(registered).toBeDefined();
});

test("only `active` counts as active", () => {
  setAppState("active");
  expect(isAppActive()).toBe(true);
});

test("`inactive` counts as stopped, exactly like `background`", () => {
  // The app switcher, a system prompt, an incoming call. The app is either off
  // screen or not interactive, so there is nothing worth animating for.
  setAppState("active");
  setAppState("inactive");
  expect(isAppActive()).toBe(false);

  setAppState("active");
  setAppState("background");
  expect(isAppActive()).toBe(false);
});

test("a change in the answer notifies subscribers", () => {
  setAppState("active");
  let notifications = 0;
  const unsubscribe = subscribeAppActive(() => {
    notifications += 1;
  });

  setAppState("background");
  expect(notifications).toBe(1);

  setAppState("active");
  expect(notifications).toBe(2);

  unsubscribe();
});

test("a transition between two stopped states notifies nobody", () => {
  // The case the guard exists for: iOS passes through `inactive` on its way to
  // `background`, and both mean stopped. Without the guard that second step
  // would re-render every animated component in the app for a value each one
  // would read identically.
  setAppState("active");
  let notifications = 0;
  const unsubscribe = subscribeAppActive(() => {
    notifications += 1;
  });

  setAppState("inactive");
  expect(notifications).toBe(1);

  setAppState("background");
  expect(notifications).toBe(1);
  expect(isAppActive()).toBe(false);

  unsubscribe();
});

test("re-entering the state it is already in notifies nobody", () => {
  setAppState("active");
  let notifications = 0;
  const unsubscribe = subscribeAppActive(() => {
    notifications += 1;
  });

  setAppState("active");
  expect(notifications).toBe(0);

  unsubscribe();
});

test("an unsubscribed listener stops hearing about changes", () => {
  // `useSyncExternalStore` unsubscribes on unmount, and a leak here would mean
  // every screen ever opened still being woken on each foreground.
  setAppState("active");
  let notifications = 0;
  const unsubscribe = subscribeAppActive(() => {
    notifications += 1;
  });

  unsubscribe();
  setAppState("background");
  expect(notifications).toBe(0);
});
