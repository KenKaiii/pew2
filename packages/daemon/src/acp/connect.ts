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

/**
 * A session-level selector advertised by the agent: model, thinking level, mode.
 * pew2 never hardcodes model names — each agent reports its own, so connecting a
 * new app automatically brings its models and reasoning levels with it.
 * https://agentclientprotocol.com/protocol/v1/session-config-options
 */
export interface ConfigOption {
  id: string;
  name: string;
  description?: string;
  /** 'model' | 'thought_level' | 'mode' | 'model_config', or a custom '_' name. */
  category?: string;
  type: string;
  currentValue: string | boolean;
  options?: { value: string; name: string; description?: string }[];
}

/**
 * Agents differ on the identifier field: ACP v1 uses `id`, the v2 draft uses
 * `configId`. Accept either so a mixed-version fleet works, and emit `id`.
 */
function normaliseConfigOptions(raw: unknown): ConfigOption[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    const option = entry as Record<string, unknown>;
    const id = (option.id ?? option.configId) as string | undefined;
    if (!id || typeof option.name !== "string") return [];
    return [
      {
        id,
        name: option.name,
        description: option.description as string | undefined,
        category: (option.category ?? undefined) as string | undefined,
        type: typeof option.type === "string" ? option.type : "select",
        currentValue: option.currentValue as string | boolean,
        options: Array.isArray(option.options)
          ? (option.options as ConfigOption["options"])
          : undefined,
      },
    ];
  });
}

export interface AcpSessionHandle {
  connection: ClientConnection;
  child: ChildProcessWithoutNullStreams;
  /** The agent's own session id, returned by `session/new`. */
  sessionId: string;
  /** Selectors the agent advertised. Empty when it offers none. */
  configOptions: ConfigOption[];
  prompt(text: string): Promise<unknown>;
  cancel(): Promise<void>;
  setConfigOption(configId: string, value: string | boolean): Promise<ConfigOption[]>;
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

  // A missing executable surfaces asynchronously as an 'error' event. Without a
  // listener Node treats it as unhandled and takes the whole daemon down, so one
  // uninstalled provider would kill every other session. Convert it to a
  // rejection of this call instead.
  const spawned = new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", (error: NodeJS.ErrnoException) => {
      reject(
        error.code === "ENOENT"
          ? new Error(
              `'${provider.command}' was not found on PATH. Install it, or point the manifest at an absolute path.`,
            )
          : error,
      );
    });
  });
  await spawned;

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
    clientCapabilities: {
      fs: { readTextFile: false, writeTextFile: false },
      terminal: false,
      // Opt in to boolean selectors; agents must not send them otherwise.
      session: { configOptions: { boolean: {} } },
    },
    clientInfo: { name: "pew2", title: "pew2", version: "0.1.0" },
  });

  const created = (await connection.agent.request("session/new", {
    cwd,
    mcpServers: [],
  })) as {
    sessionId: string;
    configOptions?: ConfigOption[];
    modes?: {
      currentModeId: string;
      availableModes: { id: string; name: string; description?: string }[];
    };
  };

  // `modes` is the deprecated predecessor of `configOptions`. Normalise it so
  // the app only ever deals with one shape.
  const configOptions: ConfigOption[] = created.configOptions
    ? normaliseConfigOptions(created.configOptions)
    : (created.modes
      ? [
          {
            id: "mode",
            name: "Mode",
            category: "mode",
            type: "select",
            currentValue: created.modes.currentModeId,
            options: created.modes.availableModes.map((mode) => ({
              value: mode.id,
              name: mode.name,
              description: mode.description,
            })),
          },
        ]
      : []);

  return {
    connection,
    child,
    sessionId: created.sessionId,
    configOptions,
    async setConfigOption(configId: string, value: string | boolean) {
      try {
        const result = (await connection.agent.request("session/set_config_option", {
          sessionId: created.sessionId,
          configId,
          ...(typeof value === "boolean" ? { type: "boolean" } : {}),
          value,
        })) as { configOptions?: unknown };
        // The agent replies with the complete list, so trust it over local state.
        return normaliseConfigOptions(result?.configOptions);
      } catch (error) {
        // JSON-RPC errors surface as a bare "Internal error", which says nothing
        // about which option failed. Name it so the log is actionable.
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`Could not set '${configId}' to '${String(value)}': ${detail}`);
      }
    },
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
