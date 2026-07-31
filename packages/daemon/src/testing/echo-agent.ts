#!/usr/bin/env bun
/**
 * A minimal, dependency-light ACP agent used as a test fixture.
 *
 * It needs no API key and no network, so `pew2 providers verify echo` exercises
 * the entire pipeline — spawn, initialize, session/new, prompt, streamed updates,
 * permission request — on any machine.
 *
 * It is also the reference for "hook up your own app": this file is roughly the
 * smallest thing that can legally call itself an ACP agent.
 */
import { agent, ndJsonStream } from "@agentclientprotocol/sdk";
import { Readable, Writable } from "node:stream";

const sessions = new Set<string>();
let counter = 0;

/**
 * Models and reasoning levels this agent offers. Real agents report their own;
 * this mirrors the shape so the picker can be exercised without an API key.
 * https://agentclientprotocol.com/protocol/v1/session-config-options
 */
const configOptions = [
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select" as const,
    currentValue: "echo-pro",
    options: [
      { value: "echo-mini", name: "Echo Mini" },
      { value: "echo-pro", name: "Echo Pro" },
      { value: "echo-max", name: "Echo Max" },
    ],
  },
  {
    id: "thought_level",
    name: "Thinking",
    category: "thought_level",
    type: "select" as const,
    currentValue: "think",
    options: [
      { value: "none", name: "None" },
      { value: "think", name: "Think" },
      { value: "think_hard", name: "Think Hard" },
    ],
  },
];

const app = agent({ name: "pew2-echo" })
  .onRequest("initialize", async () => ({
    protocolVersion: 1,
    agentCapabilities: {
      loadSession: true,
      sessionCapabilities: { list: {}, resume: {} },
      promptCapabilities: { image: false },
    },
    agentInfo: { name: "pew2-echo", title: "Echo", version: "0.1.0" },
    authMethods: [],
  }))
  .onRequest("session/new", async () => {
    const sessionId = `echo_${++counter}`;
    sessions.add(sessionId);
    return { sessionId, configOptions };
  })
  // A persisted conversation that exists before the phone opens it. It omits
  // optional count metadata so the daemon must inspect its replay, as it does
  // for existing GG Coder sessions.
  .onRequest("session/list", async (ctx: any) => ({
    sessions: [
      {
        sessionId: "echo_history_1",
        cwd: (ctx.params as { cwd?: string })?.cwd ?? process.cwd(),
        title: "Unopened echo session",
        updatedAt: "2026-07-31T12:00:00.000Z",
      },
    ],
  }))
  .onRequest("session/load", async (ctx: any) => {
    const { sessionId } = ctx.params as { sessionId: string };
    if (sessionId !== "echo_history_1") throw new Error(`Unknown session '${sessionId}'`);
    const replay = [
      ["user_message_chunk", "First question"],
      ["agent_message_chunk", "First answer"],
      ["user_message_chunk", "Second question"],
      ["agent_message_chunk", "Second answer"],
      ["user_message_chunk", "Third question"],
      ["agent_message_chunk", "Third answer"],
    ] as const;
    for (const [sessionUpdate, text] of replay) {
      await ctx.client.notify("session/update", {
        sessionId,
        update: { sessionUpdate, content: { type: "text", text } },
      });
    }
    return { configOptions };
  })
  .onRequest("session/set_config_option", async (ctx: any) => {
    const { configId, value } = ctx.params as { configId: string; value: string };
    const option = configOptions.find((entry) => entry.id === configId);
    if (!option) throw new Error(`Unknown config option '${configId}'`);
    // Reject values outside the advertised set, as a real agent would; silently
    // accepting anything would let a broken client pass its tests.
    if (!option.options.some((entry) => entry.value === value)) {
      throw new Error(`Invalid value '${value}' for '${configId}'`);
    }
    option.currentValue = value;
    // The spec requires replying with the complete list, not just the change.
    return { configOptions };
  })
  .onRequest("session/prompt", async (ctx: any) => {
    const { sessionId, prompt } = ctx.params as {
      sessionId: string;
      prompt: { type: string; text?: string }[];
    };
    const text = prompt.map((p) => p.text ?? "").join(" ").trim();

    await ctx.client.notify("session/update", {
      sessionId,
      update: {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "Thinking about it..." },
      },
    });

    // Stream the reply in chunks so clients can prove incremental rendering works.
    for (const word of `You said: ${text}`.split(" ")) {
      await ctx.client.notify("session/update", {
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: `${word} ` },
        },
      });
      await new Promise((r) => setTimeout(r, 40));
    }

    // Exercise the approval path on demand.
    if (text.toLowerCase().includes("permission")) {
      const result = (await ctx.client.request("session/request_permission", {
        sessionId,
        toolCall: { toolCallId: "echo_tool_1", title: "Do the risky thing" },
        options: [
          { optionId: "allow", name: "Allow", kind: "allow_once" },
          { optionId: "reject", name: "Reject", kind: "reject_once" },
        ],
      })) as { outcome?: { optionId?: string } };

      await ctx.client.notify("session/update", {
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: `\nYou chose: ${result?.outcome?.optionId}` },
        },
      });
    }

    return { stopReason: "end_turn" };
  });

app.connect(
  ndJsonStream(
    Writable.toWeb(process.stdout) as unknown as WritableStream<Uint8Array>,
    Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>,
  ),
);
