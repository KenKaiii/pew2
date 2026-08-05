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
  providerList,
  bucketFor,
  group,
  needsSetup,
  outroFor,
  type AgentState,
} from "./setup-view.js";
import { glyphs, stripAnsi, styler } from "./ui.js";

// Width is pinned rather than inherited: `terminalWidth()` falls back to
// $COLUMNS, which most shells export, so a fixture that omits it wraps to
// whatever window the suite happened to be run from.
const plain = { style: styler(0), glyph: glyphs(true), columns: 80 };

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

test("an unfinished setup reads as a small task, not a breakage", () => {
  // Logging in is thirty seconds of work. Showing it beside a real crash makes
  // both look equally hopeless, which is what the old flat list did.
  const qwen = agent({
    id: "qwen-code",
    name: "Qwen Code",
    install: "npm install -g @qwen-code/qwen-code",
    command: "npx",
    verify: { status: "failed", detail: "Authentication required: Use Qwen Code CLI to authenticate first." },
  });

  expect(bucketFor(qwen)).toBe("needs-setup");

  const text = stripAnsi(agentSections([qwen], plain).join("\n"));
  expect(text).toContain("Available if you want them");
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
  expect(needsSetup("Authentication required: Call authenticate before starting a session")).toBe(true);
  expect(needsSetup("Authentication required: Use Qwen Code CLI to authenticate first.")).toBe(true);
  expect(needsSetup("Please log in first")).toBe(true);
  expect(needsSetup("401 Unauthorized")).toBe(true);
  expect(needsSetup("Missing API key")).toBe(true);

  // Being wrong in this direction is the expensive one: it sends someone to run
  // a login command that works fine, and leaves them stuck on the real problem.
  // goose reports this, and it is a setup step rather than a crash: the older
  // code showed the JSON-RPC wrapper ("Internal error") and buried this in the
  // `data` field, turning one command into an unexplained failure.
  expect(needsSetup("Failed to resolve provider: Configuration value not found: GOOSE_PROVIDER")).toBe(true);

  expect(needsSetup("Internal error")).toBe(false);
  expect(needsSetup("ECONNREFUSED 127.0.0.1:8080")).toBe(false);
  expect(needsSetup("spawn ENOENT")).toBe(false);
  expect(needsSetup(undefined)).toBe(false);
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

  const done = stripAnsi(outroFor(ready, true, plain).join(" "));
  expect(done).toContain("pew2 pair");
  // One agent is the whole requirement, and the closing line has to say so:
  // nobody signs in to all thirteen, so anything left unconfigured is a choice
  // rather than an outstanding chore.
  expect(done).toContain("That is all you need");

  // Not ready, but something works: lead with what they have, not what they do
  // not. Counting the good ones is the difference between "you are set up" and
  // "you have one problem".
  const mixed = [
    ...ready,
    agent({ id: "b", name: "Bravo", verify: { status: "failed", detail: "Please log in first" } }),
  ];
  const partial = stripAnsi(outroFor(mixed, false, plain).join(" "));
  expect(partial).toContain("1 agent ready");
  expect(partial).not.toMatch(/\d+ (problems?|errors?|failures?)/i);

  // Same when the blocker is a genuine breakage rather than a sign-in, since
  // both routes reach this line and only one was covered before.
  const withBroken = [
    ...ready,
    agent({ id: "c", name: "Charlie", verify: { status: "failed", detail: "Internal error" } }),
  ];
  expect(stripAnsi(outroFor(withBroken, false, plain).join(" "))).toContain("1 agent ready");

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
  expect(text).not.toContain("Available with a key");
});

test("the rail degrades to ASCII without losing structure", () => {
  // A Windows console renders box drawing as replacement boxes, and this is the
  // first screen a new user sees.
  const ascii = { style: styler(0), glyph: glyphs(false) };
  const text = agentSections([agent({ id: "a", name: "Alpha" })], ascii).join("\n");

  expect(/[\u2500-\u257f\u25c6\u25c7]/.test(text)).toBe(false);
  expect(stripAnsi(text)).toContain("Ready to use");
});

test("long messages wrap instead of losing their ending", () => {
  // These messages *are* the instruction, and the actionable part is usually
  // last: "Configuration value not found: GOOSE_PROVIDER" names the exact thing
  // to set. Truncating puts an ellipsis exactly where the answer was.
  const detail = "Failed to resolve provider: Configuration value not found: GOOSE_PROVIDER";
  const lines = agentSections(
    [agent({ id: "goose", name: "goose", verify: { status: "failed", detail } })],
    { ...plain, columns: 60 },
  ).map(stripAnsi);

  expect(lines.join(" ")).toContain("GOOSE_PROVIDER");
  expect(lines.join("")).not.toContain("…");
  for (const line of lines) expect(line.length).toBeLessThanOrEqual(60);
});

test("a fresh machine's list of absent agents still fits the terminal", () => {
  // The first screen a new user sees: nothing installed, so every agent lands
  // in one section. Joined on a single line that is over 140 characters.
  const agents = Array.from({ length: 13 }, (_, i) =>
    agent({ id: `a${i}`, name: `Some Agent Number ${i}`, notInstalled: true }),
  );
  const lines = agentSections(agents, { ...plain, columns: 80 }).map(stripAnsi);

  for (const line of lines) expect(line.length).toBeLessThanOrEqual(80);
  // Still complete, just across more than one line.
  expect(lines.join(" ")).toContain("Some Agent Number 12");
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

test("the catalogue gives every absent agent its own row and install command", () => {
  // Where this differs from the setup screen on purpose. Setup compresses the
  // agents you do not have onto one line, because there the question is "am I
  // ready". This command answers "what else could I run", and a comma-separated
  // list cannot carry the command that makes it actionable.
  const lines = providerList(
    [
      agent({ id: "codex", name: "Codex", notInstalled: true, install: "npm install -g @openai/codex" }),
      agent({ id: "hermes", name: "Hermes", notInstalled: true, install: "pip install hermes-agent" }),
    ],
    plain,
  ).map(stripAnsi);

  const text = lines.join("\n");
  expect(text).toContain("Available to install");
  expect(text).toContain("npm install -g @openai/codex");
  expect(text).toContain("pip install hermes-agent");
  // Still not framed as a problem: no cross, no alarm words.
  expect(text).not.toContain("✗");
  expect(text).not.toMatch(/error|fail|cannot start/i);
});

test("the catalogue and the setup screen share one rail and one vocabulary", () => {
  // Two commands that look like two different tools is the thing being fixed
  // here, so the shared structure is worth pinning.
  const agents = [agent({ id: "a", name: "Alpha" })];
  const list = providerList(agents, plain).map(stripAnsi);
  const setup = agentSections(agents, plain).map(stripAnsi);

  expect(list.some((l) => l.startsWith("◇"))).toBe(true);
  expect(list.every((l) => l.startsWith("│") || l.startsWith("◇"))).toBe(true);
  // Same heading for the same state.
  expect(list.join("\n")).toContain("Ready to use");
  expect(setup.join("\n")).toContain("Ready to use");
});

test("a long description is cut to what the agent is, not what to worry about", () => {
  // Gemini's manifest runs to three lines about Google withdrawing OAuth. That
  // is right in the file and wrong against every row in a list.
  const lines = providerList(
    [
      agent({
        id: "gemini-cli",
        name: "Gemini CLI",
        summary: "Google's Gemini CLI",
        missingEnv: ["GEMINI_API_KEY"],
      }),
    ],
    plain,
  ).map(stripAnsi);

  const text = lines.join("\n");
  expect(text).toContain("needs GEMINI_API_KEY");
  expect(text).not.toContain("withdrew");
});
