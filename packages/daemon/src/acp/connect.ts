/**
 * Spawns a provider process and speaks ACP to it over stdio.
 *
 * Everything the agent emits is funnelled into a single ordered callback so the
 * session log stays the one source of truth. Permission requests are surfaced
 * the same way, and resolved later by id when the phone answers.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { client, ndJsonStream, type ClientConnection } from "@agentclientprotocol/sdk";
import type { LoadedProvider } from "../providers/registry.js";

export interface AcpSessionHandle {
  connection: ClientConnection;
  child: ChildProcessWithoutNullStreams;
  /** The agent's own session id, returned by `session/new`. */
  sessionId: string;
  prompt(text: string): Promise<unknown>;
  cancel(): Promise<void>;
  answerPermission(requestId: string, optionId: string): boolean;
  close(): void;
}

export interface ConnectOptions {
  provider: LoadedProvider;
  cwd: string;
  /** Called for every ACP `session/update` notification, in arrival order. */
  onUpdate: (payload: unknown) => void;
  /**
   * Called when the agent asks the user to approve something. Resolve the
   * returned promise by calling `answerPermission` with one of the option ids.
   */
  onPermissionRequest: (request: { requestId: string; params: unknown }) => void;
  onStderr?: (line: string) => void;
  onExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
}

/**
 * Node child streams -> Web streams, which is what `ndJsonStream` expects.
 *
 * The double cast is needed because Node's `ReadableStream` generic and the DOM
 * lib's differ structurally, even though the runtime objects are identical.
 */
function toWebStreams(child: ChildProcessWithoutNullStreams) {
  return {
    input: Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>,
    output: Writable.toWeb(child.stdin) as unknown as WritableStream<Uint8Array>,
  };
}

export async function connectProvider(options: ConnectOptions): Promise<AcpSessionHandle> {
  const { provider, cwd } = options;

  const child = spawn(provider.command, provider.args, {
    cwd,
    // ACP mandates stdout carry only protocol messages, so logs go to stderr.
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env,
  }) as ChildProcessWithoutNullStreams;

  child.on("exit", (code, signal) => options.onExit?.(code, signal));

  if (options.onStderr) {
    let buffer = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) if (line.trim()) options.onStderr!(line);
    });
  }

  const pending = new Map<string, (optionId: string) => void>();
  let permissionCounter = 0;

  const { input, output } = toWebStreams(child);
  const stream = ndJsonStream(output, input);

  const app = client({ name: "pew2-daemon" })
    .onNotification("session/update", async (ctx: { params: unknown }) => {
      options.onUpdate(ctx.params);
    })
    .onRequest("session/request_permission", async (ctx: { params: unknown }) => {
      const requestId = `perm_${++permissionCounter}`;
      // Register the resolver *before* notifying, otherwise a caller that answers
      // synchronously finds no pending entry and the agent waits forever.
      const answered = new Promise<string>((resolve) => {
        pending.set(requestId, resolve);
      });
      options.onPermissionRequest({ requestId, params: ctx.params });
      const optionId = await answered;
      return { outcome: { outcome: "selected", optionId } };
    });

  const connection = app.connect(stream);

  await connection.agent.request("initialize", {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    clientInfo: { name: "pew2", title: "pew2", version: "0.1.0" },
  });

  const created = (await connection.agent.request("session/new", {
    cwd,
    mcpServers: [],
  })) as { sessionId: string };

  return {
    connection,
    child,
    sessionId: created.sessionId,
    prompt: (text: string) =>
      connection.agent.request("session/prompt", {
        sessionId: created.sessionId,
        prompt: [{ type: "text", text }],
      }),
    cancel: () =>
      connection.agent.notify("session/cancel", { sessionId: created.sessionId }),
    answerPermission(requestId, optionId) {
      const resolve = pending.get(requestId);
      if (!resolve) return false;
      pending.delete(requestId);
      resolve(optionId);
      return true;
    },
    close() {
      connection.close();
      child.kill();
    },
  };
}
