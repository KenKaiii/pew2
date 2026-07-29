/**
 * Error readability rules.
 *
 * These encode the promise made to the phone: one short sentence, never a JSON
 * blob, for any agent — not just the ones we happened to test against.
 */
import { test, expect } from "bun:test";
import { humanError } from "./errors.js";

/** How the ACP SDK rejects a request: generic label, real cause in `data`. */
class RequestError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "RequestError";
  }
}

test("prefers the agent's reason over the generic JSON-RPC label", () => {
  const error = new RequestError(-32603, "Internal error", {
    details: "You've hit your session limit · resets 7:50pm (Asia/Kuala_Lumpur)",
  });

  expect(humanError(error)).toBe(
    "You've hit your session limit · resets 7:50pm (Asia/Kuala_Lumpur)",
  );
});

test("unwraps a cause that was serialised twice", () => {
  // Providers commonly stuff an upstream API response into `details` as text.
  const error = new RequestError(-32603, "Internal error", {
    details: JSON.stringify({ error: { message: "Rate limit exceeded", type: "rate_limit" } }),
  });

  expect(humanError(error)).toBe("Rate limit exceeded");
});

test("strips stacked generic prefixes", () => {
  expect(humanError(new Error("Internal error: Error: Model not available"))).toBe(
    "Model not available",
  );
});

test("never returns a JSON blob", () => {
  const error = new RequestError(-32603, "Internal error", {
    payload: { status: 500, headers: { retry: 3 } },
  });

  const message = humanError(error);
  expect(message).not.toContain("{");
  expect(message).toBe("The agent hit an internal error.");
});

test("falls back to the meaning of the code when there is no prose", () => {
  // Exactly how the SDK reports an unsupported method: a quoted label plus the
  // method name. Neither half is a sentence a user can act on.
  expect(
    humanError(
      new RequestError(-32601, '"Method not found": session/list', {
        method: "session/list",
      }),
    ),
  ).toBe("The agent does not support that.");
  expect(humanError(new RequestError(-32000, "Authentication required"))).toBe(
    "The agent needs you to sign in.",
  );
});

test("keeps plain errors and strings intact", () => {
  expect(humanError(new Error("Unknown session 'abc'"))).toBe("Unknown session 'abc'");
  expect(humanError("providerId required")).toBe("providerId required");
  // A single meaningful word is still a message; a slug or path is not.
  expect(humanError(new RequestError(-32603, "Unauthorized"))).toBe("Unauthorized");
  expect(humanError(new RequestError(-32603, "Internal error", { code: "rate_limit" }))).toBe(
    "The agent hit an internal error.",
  );
});

test("collapses whitespace and caps runaway output", () => {
  expect(humanError(new Error("Two   lines\n  joined"))).toBe("Two lines joined");

  const long = humanError(new Error("word ".repeat(200)));
  expect(long.length).toBeLessThanOrEqual(241);
  expect(long.endsWith("…")).toBe(true);
});

test("always says something", () => {
  // A thrown `undefined` must still reach the user as a sentence.
  for (const thrown of [undefined, null, {}, ""]) {
    expect(humanError(thrown)).toBe("Something went wrong.");
  }
});
