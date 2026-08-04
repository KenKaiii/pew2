/**
 * What `pew2 setup` shows.
 *
 * The bug this screen exists to fix was not a crash. It was tone: a machine with
 * one agent installed and four not printed five failures and three errors, and
 * the person running it reasonably concluded pew2 was broken. Everything here
 * asserts the *classification* rather than the layout, because that is what
 * decides whether a normal machine looks healthy.
 */
import { expect, test } from "bun:test";
import {
  agentSections,
  bucketFor,
  group,
  isAuthFailure,
  outroFor,
  type AgentState,
} from "./setup-view.js";
import { glyphs, stripAnsi, styler } from "./ui.js";

const plain = { style: styler(0), glyph: glyphs(true) };

function agent(overrides: Partial<AgentState> = {}): AgentState {
  return { id: "x", name: "X", missingEnv: [], notInstalled: false, ...overrides };
}

test("an agent you have not installed is not a failure", () => {
  // The whole point. Most people will install one or two agents; the rest are
  // facts about the computer, not problems with it.
  expect(bucketFor(agent({ notInstalled: true }))).toBe("not-installed");

  const text = stripAnsi(
    agentSections([agent({ id: "codex", name: "Codex", notInstalled: true })], plain).join("\n"),
  );

  expect(text).toContain("Also available");
  // No alarm language anywhere near it.
  expect(text).not.toContain("✗");
  expect(text).not.toMatch(/error|fail|cannot start|not on PATH/i);
  // And no instruction to delete a file, which was the old advice and is
  // nonsense for someone who installed a binary and has no checkout.
  expect(text).not.toMatch(/delete/i);
});

test("needing a sign-in reads as a small task, not a breakage", () => {
  // "Run qwen to log in" is thirty seconds of work. Showing it beside a real
  // crash makes both look equally hopeless.
  const qwen = agent({
    id: "qwen-code",
    name: "Qwen Code",
    install: "npm install -g @qwen-code/qwen-code",
    command: "npx",
    verify: { status: "failed", detail: "Authentication required: Use Qwen Code CLI to authenticate first." },
  });

  expect(bucketFor(qwen)).toBe("signin");

  const text = stripAnsi(agentSections([qwen], plain).join("\n"));
  expect(text).toContain("Just needs a sign-in");
  expect(text).not.toContain("✗");

  // The agent's own words, not a guessed command. Most manifests launch through
  // `npx`, so the recorded command is literally "npx", and the real login binary
  // differs per agent - a confidently wrong instruction is worse than none.
  expect(text).toContain("Use Qwen Code CLI to authenticate");
  expect(text).not.toContain("npx");
  // And never the install command: it is already installed, so that reads as
  // though the install failed.
  expect(text).not.toContain("npm install");
});

test("a real breakage is still called out, and only that", () => {
  // The one section that gets a cross. It has to keep working, or the screen
  // becomes uniformly reassuring and therefore useless.
  const broken = agent({ id: "goose", name: "goose", verify: { status: "failed", detail: "Internal error" } });

  expect(bucketFor(broken)).toBe("broken");

  const text = stripAnsi(agentSections([broken], plain).join("\n"));
  expect(text).toContain("Not working");
  expect(text).toContain("✗");
  // With the command that investigates it.
  expect(text).toContain("pew2 providers verify goose");
});

test("auth failures are recognised across the wordings agents actually use", () => {
  // None of them return a machine-readable code, so this matches on text. These
  // are the real strings observed from the agents pew2 ships with.
  expect(isAuthFailure("Authentication required: Call authenticate before starting a session")).toBe(true);
  expect(isAuthFailure("Authentication required: Use Qwen Code CLI to authenticate first.")).toBe(true);
  expect(isAuthFailure("Please log in first")).toBe(true);
  expect(isAuthFailure("401 Unauthorized")).toBe(true);
  expect(isAuthFailure("Missing API key")).toBe(true);

  // Being wrong in this direction is the expensive one: it sends someone to run
  // a login command that works fine, and leaves them stuck on the real problem.
  expect(isAuthFailure("Internal error")).toBe(false);
  expect(isAuthFailure("ECONNREFUSED 127.0.0.1:8080")).toBe(false);
  expect(isAuthFailure("spawn ENOENT")).toBe(false);
  expect(isAuthFailure(undefined)).toBe(false);
});

test("not being installed outranks every other state", () => {
  // An agent that is not on the machine cannot have an auth problem, and saying
  // it does would be nonsense.
  expect(
    bucketFor(agent({ notInstalled: true, missingEnv: ["KEY"], verify: { status: "failed", detail: "authenticate" } })),
  ).toBe("not-installed");
});

test("working agents come first, and absent ones are one quiet line", () => {
  // Order is the message: the answer to "did this work" should be the first
  // thing on screen, and a list of things you do not have should not be the
  // biggest.
  const text = stripAnsi(
    agentSections(
      [
        agent({ id: "a", name: "Alpha" }),
        agent({ id: "b", name: "Bravo", notInstalled: true }),
        agent({ id: "c", name: "Charlie", notInstalled: true }),
      ],
      plain,
    ).join("\n"),
  );

  expect(text.indexOf("Ready to use")).toBeLessThan(text.indexOf("Also available"));
  // Both absent agents on a single line, not one section each.
  expect(text).toContain("Bravo, Charlie");
});

test("the closing line says what to do next, never a problem count", () => {
  const ready = [agent({ id: "a", name: "Alpha" })];

  expect(stripAnsi(outroFor(ready, true, plain).join(" "))).toContain("pew2 pair");

  // Not ready, but something works: still tells them what they have.
  const mixed = [...ready, agent({ id: "b", name: "Bravo", verify: { status: "failed", detail: "log in" } })];
  const partial = stripAnsi(outroFor(mixed, false, plain).join(" "));
  expect(partial).toContain("1 agent ready");
  expect(partial).not.toMatch(/\d+ (problems?|errors?|failures?)/i);

  // Nothing at all: the one case where the next step is to install something.
  const none = stripAnsi(outroFor([agent({ notInstalled: true })], false, plain).join(" "));
  expect(none).toContain("No agents yet");
});

test("sections are skipped entirely when empty", () => {
  // A machine where everything works should print one section, not five headings
  // with nothing under them.
  const text = stripAnsi(agentSections([agent({ id: "a", name: "Alpha" })], plain).join("\n"));

  expect(text).toContain("Ready to use");
  expect(text).not.toContain("Also available");
  expect(text).not.toContain("Not working");
  expect(text).not.toContain("Needs an API key");
});

test("the rail degrades to ASCII without losing structure", () => {
  // A Windows console renders box drawing as replacement boxes, and this is the
  // first screen a new user sees.
  const ascii = { style: styler(0), glyph: glyphs(false) };
  const text = agentSections([agent({ id: "a", name: "Alpha" })], ascii).join("\n");

  expect(/[\u2500-\u257f\u25c6\u25c7]/.test(text)).toBe(false);
  expect(stripAnsi(text)).toContain("Ready to use");
});

test("grouping is stable and alphabetical within a section", () => {
  // So a re-run does not reshuffle the list and make it look like something
  // changed when nothing did.
  const buckets = group([
    agent({ id: "z", name: "Zulu" }),
    agent({ id: "a", name: "Alpha" }),
    agent({ id: "m", name: "Mike" }),
  ]);

  expect(buckets.ready.map((a) => a.name)).toEqual(["Alpha", "Mike", "Zulu"]);
});
