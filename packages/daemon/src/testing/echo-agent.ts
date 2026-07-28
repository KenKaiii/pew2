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

const app = agent({ name: "pew2-echo" })
  .onRequest("initialize", async () => ({
    protocolVersion: 1,
    agentCapabilities: { loadSession: false, promptCapabilities: { image: false } },
    agentInfo: { name: "pew2-echo", title: "Echo", version: "0.1.0" },
    authMethods: [],
  }))
  .onRequest("session/new", async () => {
    const sessionId = `echo_${++counter}`;
    sessions.add(sessionId);
    return { sessionId };
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
