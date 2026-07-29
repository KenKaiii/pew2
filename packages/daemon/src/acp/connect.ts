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
import { humanError } from "../errors.js";

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

/**
 * The `models` block `session/new` may return, alongside or instead of
 * `configOptions`. Claude Code's adapter reports its live model list this way —
 * the set is whatever that install currently offers, so it tracks agent updates
 * on its own and pew2 must never carry a model list of its own.
 */
interface SessionModelState {
  availableModels?: { modelId: string; name: string; description?: string }[];
  currentModelId?: string;
}

/** Present the agent's `models` block as the same selector shape as the rest. */
function modelsAsConfigOption(models: SessionModelState | undefined): ConfigOption[] {
  const available = models?.availableModels;
  if (!Array.isArray(available) || available.length === 0) return [];
  return [
    {
      id: MODEL_CONFIG_ID,
      name: "Model",
      category: "model",
      type: "select",
      currentValue: models?.currentModelId ?? available[0]!.modelId,
      options: available.map((model) => ({
        value: model.modelId,
        name: model.name,
        description: model.description,
      })),
    },
  ];
}

/**
 * Synthetic id for the selector built from `models`.
 *
 * That block has no config id of its own, so setting it routes to
 * `session/set_model` rather than `session/set_config_option`.
 */
export const MODEL_CONFIG_ID = "__acp_model";

/**
 * A conversation the agent already has on disk.
 *
 * Coding agents keep their own history, so a phone should see the work started
 * at the desk, not just what it started itself.
 * https://agentclientprotocol.com/protocol/v1/session-listing
 */
export interface AgentSession {
  sessionId: string;
  cwd: string;
  title?: string;
  /** ISO 8601 timestamp of last activity, when the agent tracks one. */
  updatedAt?: string;
}

export interface AcpSessionHandle {
  connection: ClientConnection;
  child: ChildProcessWithoutNullStreams;
  /** The agent's own session id, returned by `session/new`. */
  sessionId: string;
  /** Selectors the agent advertised. Empty when it offers none. */
  configOptions: ConfigOption[];
  /** True when the agent can replay a past session via `session/load`. */
  canLoadSession: boolean;
  /**
   * The agent's own stored conversations, newest first.
   *
   * Empty when the agent does not advertise `session/list` — not every agent
   * persists history, and asking one that doesn't is an error, not an empty list.
   */
  listSessions(): Promise<AgentSession[]>;
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
  /**
   * Resume one of the agent's own sessions instead of starting a fresh one.
   *
   * `session/load` replays the whole conversation through `onUpdate` before it
   * resolves, which is how a phone picks up a thread started at the desk.
   */
  loadSessionId?: string;
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

  const initialized = (await connection.agent.request("initialize", {
    protocolVersion: 1,
    clientCapabilities: {
      fs: { readTextFile: false, writeTextFile: false },
      terminal: false,
      // Opt in to boolean selectors; agents must not send them otherwise.
      session: { configOptions: { boolean: {} } },
    },
    clientInfo: { name: "pew2", title: "pew2", version: "0.1.0" },
  })) as {
    agentCapabilities?: {
      loadSession?: boolean;
      sessionCapabilities?: { list?: unknown };
    };
  };

  const caps = initialized.agentCapabilities;
  const canLoadSession = caps?.loadSession === true;
  // Asking an agent that never advertised `session/list` is a protocol error,
  // not an empty list, so the capability is checked rather than the call tried.
  const canListSessions = caps?.sessionCapabilities?.list !== undefined;

  type NewSessionResult = {
    sessionId: string;
    configOptions?: ConfigOption[];
    models?: SessionModelState;
    modes?: {
      currentModeId: string;
      availableModes: { id: string; name: string; description?: string }[];
    };
  };

  // Resuming replays the agent's own history through `onUpdate` before it
  // resolves, so the conversation is on screen by the time this returns.
  const created: NewSessionResult = options.loadSessionId
    ? {
        ...((await connection.agent.request("session/load", {
          sessionId: options.loadSessionId,
          cwd,
          mcpServers: [],
        })) as Omit<NewSessionResult, "sessionId">),
        sessionId: options.loadSessionId,
      }
    : ((await connection.agent.request("session/new", {
        cwd,
        mcpServers: [],
      })) as NewSessionResult);

  // Three shapes, all live in the wild, and an agent may send more than one.
  // Claude Code returns `models` + `modes` and no `configOptions` at all, so
  // reading only the last of these silently dropped its entire model list.
  const advertised = normaliseConfigOptions(created.configOptions);
  const modes: ConfigOption[] = created.modes
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
    : [];

  // An explicit `configOptions` entry always wins: it is the current protocol,
  // so it must not be shadowed by the legacy block describing the same thing.
  const has = (category: string) =>
    advertised.some((option) => option.category === category);
  const configOptions: ConfigOption[] = [
    ...advertised,
    ...(has("model") ? [] : modelsAsConfigOption(created.models)),
    ...(has("mode") ? [] : modes),
  ];

  return {
    connection,
    child,
    sessionId: created.sessionId,
    configOptions,
    canLoadSession,

    async listSessions() {
      if (!canListSessions) return [];
      const result = (await connection.agent.request("session/list", {})) as {
        sessions?: AgentSession[];
      };
      const sessions = Array.isArray(result?.sessions) ? result.sessions : [];
      // Newest first: the thread you were just working on is the one you want.
      return [...sessions].sort((a, b) =>
        (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""),
      );
    },
    async setConfigOption(configId: string, value: string | boolean) {
      try {
        // The selector synthesised from `models` has no config id the agent
        // knows, so it routes to the dedicated model method instead.
        if (configId === MODEL_CONFIG_ID) {
          await connection.agent.request("session/set_model", {
            sessionId: created.sessionId,
            modelId: String(value),
          });
          // That method returns nothing useful, so reflect the change locally.
          return configOptions.map((option) =>
            option.id === MODEL_CONFIG_ID ? { ...option, currentValue: value } : option,
          );
        }

        const result = (await connection.agent.request("session/set_config_option", {
          sessionId: created.sessionId,
          configId,
          ...(typeof value === "boolean" ? { type: "boolean" } : {}),
          value,
        })) as { configOptions?: unknown };
        // The agent replies with the complete list, so trust it over local state.
        return normaliseConfigOptions(result?.configOptions);
      } catch (error) {
        // The agent's real reason travels in the JSON-RPC `data`, so reading
        // `.message` here would substitute a bare "Internal error" and throw
        // the explanation away before anyone could see it.
        const detail = humanError(error);
        // Name the option only when the agent's own wording does not, so the
        // message stays one short sentence instead of saying it twice.
        throw new Error(
          detail.includes(configId) ? detail : `Could not set '${configId}': ${detail}`,
        );
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
