import { describe, expect, it } from "bun:test";
import {
  applyCommand,
  isOfferedCommand,
  offeredCommands,
  readAvailableCommands,
  splitCommand,
} from "./slashCommands";

const commandsUpdate = (names: { name: string; hint?: string }[]) => ({
  update: {
    sessionUpdate: "available_commands_update",
    availableCommands: names.map(({ name, hint }) => ({
      name,
      description: `Does ${name}`,
      ...(hint ? { input: { hint } } : {}),
    })),
  },
});

describe("isOfferedCommand", () => {
  it("hides what the pills already own", () => {
    expect(isOfferedCommand("model")).toBe(false);
    expect(isOfferedCommand("mode")).toBe(false);
  });

  it("hides what a phone cannot honour", () => {
    expect(isOfferedCommand("quit")).toBe(false);
    expect(isOfferedCommand("exit")).toBe(false);
    expect(isOfferedCommand("clear")).toBe(false);
  });

  it("hides what the drawer already owns", () => {
    // Starting and switching conversations is the drawer's job; an agent-side
    // equivalent would fork the transcript away from the one on screen.
    expect(isOfferedCommand("session")).toBe(false);
    expect(isOfferedCommand("new")).toBe(false);
    expect(isOfferedCommand("branches")).toBe(false);
  });

  it("keeps project commands, which are the point", () => {
    expect(isOfferedCommand("commit")).toBe(true);
    expect(isOfferedCommand("create_plan")).toBe(true);
  });

  it("matches regardless of case or a leading slash", () => {
    expect(isOfferedCommand("/QUIT")).toBe(false);
  });
});

describe("readAvailableCommands", () => {
  it("reads the agent's list and drops the hidden ones", () => {
    const commands = readAvailableCommands(
      commandsUpdate([{ name: "commit" }, { name: "quit" }, { name: "model" }]),
    );
    expect(commands?.map((c) => c.name)).toEqual(["commit"]);
  });

  it("keeps the argument hint, so the composer can prompt for it", () => {
    const commands = readAvailableCommands(
      commandsUpdate([{ name: "review", hint: "a file path" }]),
    );
    expect(commands?.[0]?.hint).toBe("a file path");
  });

  it("ignores every other payload, so the last list survives a turn", () => {
    expect(readAvailableCommands({ update: { sessionUpdate: "agent_message_chunk" } })).toBe(
      undefined,
    );
    expect(readAvailableCommands(undefined)).toBe(undefined);
  });

  it("survives a malformed entry rather than dropping the menu", () => {
    const commands = readAvailableCommands({
      update: {
        sessionUpdate: "available_commands_update",
        availableCommands: [{ name: "" }, { nope: true }, { name: "commit" }],
      },
    });
    expect(commands?.map((c) => c.name)).toEqual(["commit"]);
  });
});

describe("applyCommand", () => {
  it("leaves the caret past a space, ready for instructions", () => {
    expect(applyCommand({ name: "review", description: "", hint: "a path" })).toBe(
      "/review ",
    );
  });

  it("does the same for a command that declares no argument", () => {
    // Most still accept context, and a space is easier to delete than to add.
    expect(applyCommand({ name: "commit", description: "" })).toBe("/commit ");
  });
});

describe("splitCommand", () => {
  it("splits the command from the instructions after it", () => {
    expect(splitCommand("/review src/ui carefully")).toEqual({
      command: "/review",
      rest: " src/ui carefully",
    });
  });

  it("handles a namespaced name", () => {
    expect(splitCommand("/minimal-claude:candy now")?.command).toBe(
      "/minimal-claude:candy",
    );
  });

  it("is undefined for prose, so ordinary text is not decorated", () => {
    expect(splitCommand("look at src/ui")).toBe(undefined);
    expect(splitCommand("")).toBe(undefined);
  });

  it("only matches at the very start", () => {
    // A path mid-sentence is not a command, and highlighting it would promise
    // behaviour that will not happen.
    expect(splitCommand("see packages/app /review")).toBe(undefined);
  });

  it("treats a bare slash as no command yet", () => {
    expect(splitCommand("/")).toBe(undefined);
  });

  it("waits for the space, so a name being typed is not split mid-word", () => {
    // The composer moves a split command into its badge and rejoins later
    // keystrokes after a space, so splitting early would assemble `/h elp`.
    expect(splitCommand("/h")).toBe(undefined);
    expect(splitCommand("/help")).toBe(undefined);
    expect(splitCommand("/help ")?.command).toBe("/help");
  });

  it("accepts a command that ends settled text, which arrives trimmed", () => {
    // A sent turn has no trailing space, and must still render as a command.
    expect(splitCommand("/commit", { settled: true })).toEqual({
      command: "/commit",
      rest: "",
    });
  });
});

describe("offeredCommands", () => {
  it("accepts the daemon's already-flattened hint", () => {
    // The probe path sends `hint` directly; the session path nests it under
    // `input`. Both feed this, and the sheet must not care which arrived.
    expect(offeredCommands([{ name: "review", description: "", hint: "a path" }])).toEqual([
      { name: "review", description: "", hint: "a path" },
    ]);
  });

  it("applies the same hiding rules as the session path", () => {
    // Otherwise the menu would change contents the moment the first prompt
    // replaced the probe's list with the session's own.
    expect(offeredCommands([{ name: "quit", description: "" }])).toEqual([]);
  });

  it("treats a missing list as no commands, not a crash", () => {
    expect(offeredCommands(undefined)).toEqual([]);
  });
});
