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
import { findOnPath, type LoadedProvider } from "../providers/registry.js";
import { humanError } from "../errors.js";
import type { StoredAttachment } from "../attachments.js";
import { promptBlocks, type PromptCapabilities } from "./promptBlocks.js";
import { SESSION_HISTORY_LIMIT } from "../session-history.js";
import { hydrateMessageCounts } from "./messageCounts.js";
import { foldProjects, type AgentProject } from "../projects.js";
import { DETACH_CHILDREN, registerChild, terminateChild, unregisterChild } from "../children.js";

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
 * Synthetic id for the selector built from `modes`.
 *
 * Same story as the model: the legacy `modes` block carries no config id, so
 * setting it routes to `session/set_mode`. Sending `session/set_config_option`
 * for an id the agent never advertised is silently accepted and does nothing —
 * which is exactly what "I picked a mode and nothing happened" looks like.
 */
export const MODE_CONFIG_ID = "__acp_mode";

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
  /** Number of message rows the app will render before this session is opened. */
  messageCount?: number;
}

/**
 * What one `session/list` call yields.
 *
 * Three views of the same answer because they serve different screens: the
 * capped `sessions` are the drawer's recent history (the only ones whose
 * message counts are worth reading from disk up front), `projects` is the
 * complete set of places this agent has worked, and `all` is kept so choosing
 * one of those projects can be answered without asking the agent again.
 */
export interface AgentSessionList {
  sessions: AgentSession[];
  projects: AgentProject[];
  all: AgentSession[];
}

/** A slash command the agent offers, as advertised over ACP. */
export interface AvailableCommand {
  name: string;
  description: string;
  /** Placeholder for the argument it expects, when it takes one. */
  hint?: string;
}

/**
 * Normalise an `available_commands_update` payload.
 *
 * Nothing is filtered here: which commands make sense on a phone is a client
 * decision, and the daemon also serves clients that are not this app.
 */
function readAvailableCommands(raw: unknown): AvailableCommand[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((command: any) => typeof command?.name === "string" && command.name.trim())
    .map((command: any) => ({
      name: command.name.trim(),
      description: typeof command.description === "string" ? command.description : "",
      ...(typeof command.input?.hint === "string" ? { hint: command.input.hint } : {}),
    }));
}

export interface AcpSessionHandle {
  connection: ClientConnection;
  child: ChildProcessWithoutNullStreams;
  /** The session prompts currently target. Changes when `adopt` opens another. */
  readonly sessionId: string;
  /** Selectors for the current session. Empty when it offers none. */
  readonly configOptions: ConfigOption[];
  /**
   * Slash commands the agent advertised for the current session.
   *
   * Sent as a notification shortly after `session/new`, not as part of its
   * result, so this fills in a moment after the session opens. The set depends
   * on the project's own `commands/` directories, so it is per session rather
   * than a property of the agent.
   */
  readonly availableCommands: AvailableCommand[];
  /** True when the agent can replay a past session via `session/load`. */
  canLoadSession: boolean;
  /**
   * The agent's own stored conversations, newest first.
   *
   * Empty when the agent does not advertise `session/list` — not every agent
   * persists history, and asking one that doesn't is an error, not an empty list.
   */
  listSessions(): Promise<AgentSessionList>;
  /**
   * Open another session on this same agent process.
   *
   * Booting the process is the expensive part of a connection — GG Coder
   * takes ~5s while `session/load` itself answers in ~30ms — so the daemon
   * keeps a warm handle per provider and adopts it for the next conversation
   * instead of spawning again.
   */
  adopt(options: AdoptOptions): Promise<void>;
  /**
   * What this agent accepts in a prompt besides text.
   *
   * Undefined when it advertised nothing, which means text only: sending an
   * image block to an agent that never claimed `image` is a protocol error,
   * not a graceful degradation.
   */
  readonly promptCapabilities?: PromptCapabilities;
  prompt(text: string, attachments?: readonly StoredAttachment[]): Promise<unknown>;
  cancel(): Promise<void>;
  setConfigOption(configId: string, value: string | boolean): Promise<ConfigOption[]>;
  answerPermission(requestId: string, optionId: string): boolean;
  close(): void;
}

export interface AdoptOptions {
  /** Resume this stored session; a fresh one is created when omitted. */
  loadSessionId?: string;
  /**
   * The project this conversation opens in.
   *
   * Required, and not optional with a fallback: a warm process was spawned for
   * whatever workspace the capability probe happened to use, which under
   * launchd is the home directory. Reusing that for a session the user opened
   * against a chosen project is what made the agent report the wrong `cwd` —
   * so every adopt has to say where it is going.
   */
  cwd: string;
  /** As on {@link ConnectOptions}: skip the replay, keep the agent context. */
  haveHistory?: boolean;
  onUpdate: (payload: unknown) => void;
  onPermissionRequest: (request: { requestId: string; params: unknown }) => void;
  onConfigOptions?: (options: ConfigOption[]) => void;
  onExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
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
  /**
   * The agent changed the session's selectors on its own.
   *
   * Not every change comes from `setConfigOption`: the option set is
   * model-dependent, so switching model adds or removes the thinking-level
   * selector, and `/model` typed as a prompt changes it with no request at all.
   * Without this the pills keep describing the model that was current when the
   * session opened.
   */
  onConfigOptions?: (options: ConfigOption[]) => void;
  onStderr?: (line: string) => void;
  onExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
  /**
   * Resume one of the agent's own sessions instead of starting a fresh one.
   *
   * `session/load` replays the whole conversation through `onUpdate` before it
   * resolves, which is how a phone picks up a thread started at the desk.
   */
  loadSessionId?: string;
  /**
   * The caller already has this conversation's history and does not want it
   * replayed — only the agent-side context back.
   *
   * Set when the daemon painted the thread from its own cache, which it does
   * for every provider. Without it the agent replays a transcript the user is
   * already looking at, and the daemon drops every message of it: 8,354
   * notifications and 938ms, measured against GG Coder, to arrive at the screen
   * that was already drawn.
   *
   * Only a hint. An agent that does not advertise `session/resume` still gets a
   * `session/load`, and the duplicate replay is still discarded as before.
   */
  haveHistory?: boolean;
  /**
   * How long to wait for the agent to answer `initialize`.
   *
   * Overridable mainly so tests do not have to wait out the real budget.
   */
  handshakeTimeoutMs?: number;
}

/**
 * How long an agent may take to answer `initialize` before we give up.
 *
 * Deliberately generous. An `npx` provider downloads its package on first run,
 * which is genuinely minutes on a slow link for a large agent, and killing a
 * working install because it was cold would be the worse failure. This exists to
 * catch the case that never ends — a corrupt npx cache, an agent prompting for
 * login on stdin nobody is reading — not to make slow things fast.
 */
const HANDSHAKE_TIMEOUT_MS = 180_000;

/**
 * Marks a timeout, so it is not re-wrapped as a startup failure below.
 *
 * A shared constant rather than a literal in two places: the two failures give
 * deliberately different advice — "it is stuck" versus "it died, here is what it
 * said" — and rewording one copy would silently start reporting hung agents as
 * crashed ones, pointing the user at a problem they never had.
 */
export const HANDSHAKE_TIMEOUT_MARKER = "did not respond to the ACP handshake";

/**
 * Which ACP method reopens a stored conversation.
 *
 * `session/load` replays the whole transcript through the update handler before
 * it resolves. `session/resume` restores the same agent-side context and sends
 * nothing. They are otherwise equivalent: same session id, same capabilities.
 *
 * Measured against GG Coder on one real conversation:
 *
 *   session/load     941ms   8,457 update notifications
 *   session/resume   418ms       0 update notifications
 *
 * The daemon paints every thread from its own cache before the agent is even
 * attached, so those 8,457 messages were being decoded and then dropped. Asking
 * for them was more than half the cost of reopening a conversation — which is
 * the cost the whole idle-session reaper trades against.
 *
 * @param haveHistory The caller already has the transcript on screen.
 * @param canResumeSession The agent advertised `session/resume`.
 */
export function restoreMethodFor(
  haveHistory: boolean,
  canResumeSession: boolean,
): "session/load" | "session/resume" {
  // Both conditions, and neither is optional. Without the transcript the replay
  // is the only way to draw the thread; without the capability, asking is a
  // protocol error rather than a graceful no-op.
  return haveHistory && canResumeSession ? "session/resume" : "session/load";
}

/**
 * Reject with `onTimeout()` if `promise` has not settled in `ms`.
 *
 * The message is built lazily so it can describe what was on stderr by the time
 * we gave up, rather than what was there when the wait started — which is
 * usually nothing at all.
 *
 * The timer is cleared on both paths: an un-cleared timer holds the event loop
 * open, which for a daemon means it never exits cleanly.
 */
export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  onTimeout: () => Error,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(onTimeout()), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        // Re-rejecting with the original reason, not a wrapped Error: ACP
        // failures are JSON-RPC objects whose `data` field carries the only
        // useful explanation, and `humanError` downstream reads it. Wrapping
        // would throw that away to satisfy the rule.
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
        reject(error);
      },
    );
  });
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

/**
 * The selector list after an update the agent sent unprompted, or undefined
 * when this notification does not carry one.
 *
 * Two shapes, because two protocol generations are live. `config_option_update`
 * resends the whole list and so replaces it — an option can legitimately
 * disappear, which is exactly what happens to the thinking level on a model
 * that does not support one. The legacy `current_mode_update` carries only an
 * id, so the selector synthesised from the `modes` block is edited in place.
 */
function applyConfigUpdate(
  currentOptions: ConfigOption[],
  update: { sessionUpdate?: string; configOptions?: unknown; currentModeId?: unknown } | undefined,
): ConfigOption[] | undefined {
  if (update?.sessionUpdate === "config_option_update") {
    const announced = normaliseConfigOptions(update.configOptions);
    // An empty list is a malformed notification, not "this session has no
    // selectors": treating it as truth would blank every pill.
    return announced.length > 0 ? announced : undefined;
  }
  if (update?.sessionUpdate === "current_mode_update" && typeof update.currentModeId === "string") {
    const modeId = update.currentModeId;
    // Agents that advertise a real `configOptions` mode entry announce it via
    // `config_option_update` above; this only touches the synthetic one, so
    // nothing changes when the session has none.
    if (!currentOptions.some((option) => option.id === MODE_CONFIG_ID)) return undefined;
    return currentOptions.map((option) =>
      option.id === MODE_CONFIG_ID ? { ...option, currentValue: modeId } : option,
    );
  }
  return undefined;
}

/**
 * Characters cmd.exe treats as syntax rather than text — including the space,
 * which is why a path can be escaped instead of quoted.
 *
 * Taken from cross-spawn, which is the de-facto implementation of this problem
 * and has had a decade of Windows bug reports filed against it.
 */
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

/**
 * One argument, as the target program's C runtime will parse it back.
 *
 * Two layers, and they are not the same layer. First MSVCRT quoting, which is
 * what the receiving program applies: a backslash is literal *except* directly
 * before a quote, so those runs are doubled and the quote escaped. Then cmd's
 * own layer on top, since with `windowsVerbatimArguments` this text reaches
 * cmd.exe unaltered — including the quotes we just added, which have to be
 * `^`-escaped or cmd eats them as delimiters.
 */
function escapeArgument(arg: string): string {
  const quoted = `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1")}"`;
  return quoted.replace(CMD_META, "^$1");
}

/**
 * How to actually launch what `findOnPath` found.
 *
 * On POSIX, unchanged: the command is spawned as given.
 *
 * On Windows, two things are true that are not true anywhere else. The command
 * has to be resolved to a real file first — libuv only ever appends `.com` and
 * `.exe`, so a bare `npx` never finds the `npx.cmd` that npm actually installed.
 * And since CVE-2024-27980 (Node 18.20.2 / 20.12.2 / 21.7.3) spawning a `.cmd`
 * or `.bat` without a shell is refused outright with EINVAL, because argument
 * quoting for those is a command-injection surface.
 *
 * So a batch shim goes through `cmd.exe` explicitly — never `shell: true`, which
 * hands an unescaped line to a parser and is the vulnerability itself.
 *
 * The escaping is not optional decoration. Passing the parts as ordinary argv
 * entries looks right and is wrong: Node quotes them MSVCRT-style, then `/s`
 * strips the *first and last* quote of everything after `/c` — which unquotes
 * the program path. `C:\Program Files\nodejs\npx.cmd`, the default location of
 * the launcher five bundled providers run through, would split at the space and
 * fail with a syntax error nobody could act on. So the line is built here,
 * escaped for both parsers, and handed over verbatim — the same shape npm,
 * nodemon and cross-spawn all settled on.
 */
export function launchSpec(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): { command: string; args: string[]; windowsVerbatimArguments?: boolean } {
  // Same override the resolver honours, so the Windows path is reachable from a
  // Linux CI run — the only reason this behaviour is testable at all.
  const windows = env.PEW2_FAKE_PLATFORM
    ? env.PEW2_FAKE_PLATFORM === "win32"
    : process.platform === "win32";
  if (!windows) return { command, args };

  // Falls back to the bare name so the spawn still happens and still produces a
  // real ENOENT: refusing here would report "not installed" for a command the
  // user may have added to PATH since the registry last looked.
  const resolved = findOnPath(command, env) ?? command;
  const lower = resolved.toLowerCase();
  if (!lower.endsWith(".cmd") && !lower.endsWith(".bat")) {
    return { command: resolved, args };
  }

  // The program is `^`-escaped rather than quoted, so a space in the path is
  // literal without opening a quote that `/s` would later strip.
  const line = [resolved.replace(CMD_META, "^$1"), ...args.map(escapeArgument)].join(" ");

  // `/d` skips AutoRun commands from the registry — without it, whatever a user
  // or their IT department set there runs before every agent. `/s` makes the
  // outer quotes mean exactly "strip these two", which is what the line is
  // built to expect.
  return {
    command: env.COMSPEC ?? "cmd.exe",
    args: ["/d", "/s", "/c", `"${line}"`],
    windowsVerbatimArguments: true,
  };
}

export async function connectProvider(options: ConnectOptions): Promise<AcpSessionHandle> {
  const { provider, cwd } = options;

  // Never with a faked platform: this one actually spawns, so simulating
  // Windows here would try to run cmd.exe on a Mac.
  const launch = launchSpec(provider.command, provider.args, {
    ...process.env,
    PEW2_FAKE_PLATFORM: undefined,
  });

  const child = spawn(launch.command, launch.args, {
    cwd,
    // Set only on the Windows batch-shim path, where the command line was
    // escaped by hand above. Letting Node re-quote it would undo that.
    windowsVerbatimArguments: launch.windowsVerbatimArguments,
    // ACP mandates stdout carry only protocol messages, so logs go to stderr.
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env,
    // Its own process group, so `kill` can address the whole tree. Five bundled
    // providers run through `npx`: signalling only the process we spawned kills
    // the launcher and reparents the real agent to pid 1, where it runs until
    // the machine reboots. Detaching also stops a terminal's Ctrl-C reaching
    // agents directly — the daemon's own handler closes them in order instead.
    // Never on Windows, where the same flag means "outlive the parent".
    detached: DETACH_CHILDREN,
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

  // Recorded so that a daemon which dies without running a handler — SIGKILL,
  // OOM, panic — can still be cleaned up after, by the next one to start.
  const pid = child.pid;
  if (pid !== undefined) {
    void registerChild({
      pid,
      providerId: provider.manifest.id,
      fallbackCommand: [provider.command, ...provider.args].join(" "),
    });
  }

  // The exit listener is re-pointed on `adopt`, so a reused process reports
  // its death to the session currently living on it, not the first one.
  let exitHandler = options.onExit;
  let exited = false;
  child.on("exit", (code, signal) => {
    exited = true;
    if (pid !== undefined) void unregisterChild(pid);
    exitHandler?.(code, signal);
  });

  /**
   * SIGTERM to the whole group, SIGKILL to whatever ignored it.
   *
   * @param graceMs Time between the two. Zero for a process already known to be
   * wedged, where the request is a formality.
   */
  const stop = (graceMs?: number) => {
    if (exited || pid === undefined) return;
    terminateChild(pid, () => exited, graceMs);
  };

  // Always read stderr, even with no `onStderr` listener. An agent that fails to
  // hand shake explains itself there and nowhere else — `npm error ENOENT` from a
  // corrupt npx cache, or a login prompt — and without it the only thing to
  // report is that nothing happened. Also drains the pipe: a child that fills
  // its stderr buffer with nobody reading blocks forever, which is itself a way
  // to hang the handshake.
  const stderrTail: string[] = [];
  {
    let buffer = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        options.onStderr?.(line);
        // Bounded: a chatty agent must not accumulate its whole log here.
        stderrTail.push(line);
        if (stderrTail.length > 12) stderrTail.shift();
      }
    });
  }

  const pending = new Map<string, (optionId: string) => void>();
  let permissionCounter = 0;

  const { input, output } = toWebStreams(child);
  const stream = ndJsonStream(output, input);

  // Updates and permission requests are routed per agent session: `adopt`
  // puts a second session on this connection, and the probe's throwaway must
  // never write into a live conversation. `pendingRoute` covers the window
  // inside `session/new`, whose id only exists once it resolves.
  const updateHandlers = new Map<string, (payload: unknown) => void>();
  const permissionHandlers = new Map<string, ConnectOptions["onPermissionRequest"]>();
  let pendingRoute:
    | { onUpdate: (payload: unknown) => void; onPermissionRequest: ConnectOptions["onPermissionRequest"] }
    | undefined;

  // Commands arrive as a notification after `session/new` resolves, so they
  // cannot be part of its result. Captured here rather than only forwarded,
  // because the capability probe throws its updates away and still needs them:
  // the app offers commands in the empty state, before a session exists.
  let availableCommands: AvailableCommand[] = [];

  // Assigned by the first `openSession` below. Initialised rather than left in
  // the temporal dead zone: `session/load` replays through the notification
  // handler *before* that assignment lands, and the config branch there reads
  // this — a bare `let` would throw mid-replay.
  let current: { sessionId: string; configOptions: ConfigOption[] } = {
    sessionId: "",
    configOptions: [],
  };
  const configHandlers = new Map<string, (options: ConfigOption[]) => void>();

  const app = client({ name: "pew2-daemon" })
    .onNotification("session/update", async (ctx: { params: unknown }) => {
      const params = ctx.params as {
        sessionId?: string;
        update?: {
          sessionUpdate?: string;
          availableCommands?: unknown;
          configOptions?: unknown;
          currentModeId?: unknown;
        };
      };
      if (params?.update?.sessionUpdate === "available_commands_update") {
        availableCommands = readAvailableCommands(params.update.availableCommands);
      }
      // The agent changing the session's selectors on its own. Scoped to the
      // session prompts actually target: one connection carries several — the
      // capability probe's throwaway, and whatever `adopt` opened before this —
      // and letting any of them write here would hand a live conversation the
      // wrong agent's model list.
      if (params?.sessionId && params.sessionId === current.sessionId) {
        const changed = applyConfigUpdate(current.configOptions, params.update);
        if (changed) {
          current = { ...current, configOptions: changed };
          configHandlers.get(params.sessionId)?.(changed);
        }
      }
      const sid = params?.sessionId;
      const handler = (sid ? updateHandlers.get(sid) : undefined) ?? pendingRoute?.onUpdate;
      handler?.(ctx.params);
    })
    .onRequest("session/request_permission", async (ctx: { params: unknown }) => {
      const requestId = `perm_${++permissionCounter}`;
      // Register the resolver *before* notifying, otherwise a caller that answers
      // synchronously finds no pending entry and the agent waits forever.
      const answered = new Promise<string>((resolve) => {
        pending.set(requestId, resolve);
      });
      const sid = (ctx.params as { sessionId?: string })?.sessionId;
      const handler =
        (sid ? permissionHandlers.get(sid) : undefined) ??
        pendingRoute?.onPermissionRequest ??
        options.onPermissionRequest;
      handler({ requestId, params: ctx.params });
      const optionId = await answered;
      return { outcome: { outcome: "selected", optionId } };
    });

  const connection = app.connect(stream);

  // How the agent was started, and whatever it said before failing. Both
  // failures below are otherwise unattributable: "ACP connection closed" does
  // not say which agent, what was run, or why it died.
  const failureContext = () => {
    const invocation = `It was started with: ${provider.command} ${provider.args.join(" ")}`;
    return stderrTail.length > 0 ? `${invocation}\n${stderrTail.join("\n")}` : invocation;
  };

  // Bounded, because this await is the one that used to hang forever. Nothing
  // downstream — the capability probe, the app's session list — has a timeout of
  // its own, so an agent that never answers left the phone on a loading skeleton
  // with no error, no log line and no way back except restarting the daemon.
  const handshake = withTimeout(
    connection.agent.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
        // Opt in to boolean selectors; agents must not send them otherwise.
        session: { configOptions: { boolean: {} } },
      },
      clientInfo: { name: "pew2", title: "pew2", version: "0.1.0" },
    }),
    options.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS,
    () => {
      // The process is wedged, not merely slow: leaving it running would leak a
      // child per attempt for as long as the user keeps tapping. No grace, since
      // it has already failed to answer for the whole handshake window — but by
      // group, or a wrapped agent survives the launcher it was started behind.
      stop(0);
      return new Error(
        `'${provider.manifest.name}' ${HANDSHAKE_TIMEOUT_MARKER}. ${failureContext()}`,
      );
    },
  );

  // An agent that dies immediately — bad arguments, missing config — already
  // rejects here promptly, but as a bare "ACP connection closed" that names
  // neither the agent nor the reason it printed on the way out.
  const initialized = (await handshake.catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes(HANDSHAKE_TIMEOUT_MARKER)) throw error;
    throw new Error(`'${provider.manifest.name}' failed to start: ${message}. ${failureContext()}`);
  })) as {
    agentCapabilities?: {
      loadSession?: boolean;
      promptCapabilities?: PromptCapabilities;
      sessionCapabilities?: { list?: unknown; resume?: unknown };
    };
  };

  const caps = initialized.agentCapabilities;
  const canLoadSession = caps?.loadSession === true;
  // `session/resume` reconnects to a stored conversation *without* replaying it.
  //
  // Worth a separate capability check because it is the difference between
  // reopening a conversation in 150ms and in 1.2s: measured against GG Coder, a
  // `session/load` of one long conversation pushed 8,354 update notifications
  // and blocked for 938ms — all of which the daemon then discarded, because it
  // had already painted the same history from its own cache.
  //
  // `{}` is how ACP says "supported" for a capability with no options of its
  // own, so presence is the test, not truthiness.
  const canResumeSession = caps?.sessionCapabilities?.resume !== undefined;
  // How an attachment may be sent to this agent: pixels inline, file text
  // inline, or a path it can open for itself.
  const promptCapabilities = caps?.promptCapabilities;
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

  // Three shapes, all live in the wild, and an agent may send more than one.
  // Claude Code returns `models` + `modes` and no `configOptions` at all, so
  // reading only the last of these silently dropped its entire model list.
  function buildConfigOptions(created: NewSessionResult): ConfigOption[] {
    const advertised = normaliseConfigOptions(created.configOptions);
    const modes: ConfigOption[] = created.modes
      ? [
          {
            id: MODE_CONFIG_ID,
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

    // An explicit `configOptions` entry always wins: it is the current
    // protocol, so it must not be shadowed by the legacy block describing the
    // same thing.
    const has = (category: string) =>
      advertised.some((option) => option.category === category);
    return [
      ...advertised,
      ...(has("model") ? [] : modelsAsConfigOption(created.models)),
      ...(has("mode") ? [] : modes),
    ];
  }

  // Resuming replays the agent's own history through the update handler before
  // it resolves, so the route must exist before the request is made.
  async function openSession(
    loadSessionId: string | undefined,
    /**
     * Where this session runs. Defaults to the directory the process was
     * spawned in, which is right for the first session on a cold connection
     * and wrong for every adopted one.
     */
    sessionCwd: string,
    route: {
      onUpdate: (payload: unknown) => void;
      onPermissionRequest: ConnectOptions["onPermissionRequest"];
      onConfigOptions?: (options: ConfigOption[]) => void;
    },
    /** The caller already has the transcript; see {@link ConnectOptions.haveHistory}. */
    haveHistory = false,
  ): Promise<{ sessionId: string; configOptions: ConfigOption[] }> {
    if (loadSessionId) {
      updateHandlers.set(loadSessionId, route.onUpdate);
      permissionHandlers.set(loadSessionId, route.onPermissionRequest);
      if (route.onConfigOptions) configHandlers.set(loadSessionId, route.onConfigOptions);
    }
    // Belongs to the session being replaced, and the next one may be a
    // different project entirely.
    availableCommands = [];
    pendingRoute = route;
    try {
      const restoreMethod = restoreMethodFor(haveHistory, canResumeSession);
      const created: NewSessionResult = loadSessionId
        ? {
            ...((await connection.agent.request(restoreMethod, {
              sessionId: loadSessionId,
              cwd: sessionCwd,
              mcpServers: [],
            })) as Omit<NewSessionResult, "sessionId">),
            sessionId: loadSessionId,
          }
        : ((await connection.agent.request("session/new", {
            cwd: sessionCwd,
            mcpServers: [],
          })) as NewSessionResult);
      updateHandlers.set(created.sessionId, route.onUpdate);
      permissionHandlers.set(created.sessionId, route.onPermissionRequest);
      if (route.onConfigOptions) configHandlers.set(created.sessionId, route.onConfigOptions);
      return { sessionId: created.sessionId, configOptions: buildConfigOptions(created) };
    } finally {
      pendingRoute = undefined;
    }
  }

  // Opening the first session is the last thing that can fail before the caller
  // gets a handle — and until it does, nothing else has a reference to this
  // process. So a failure here has to kill it: there is no `close()` to call
  // when the call you would have got it from is the one that threw.
  //
  // `pew2 setup` proved the cost. Every agent that answered the handshake and
  // then failed to open a session — the ordinary not-signed-in case — left a
  // live process behind, one per agent per run, until the machine was rebooted.
  //
  // Bounded for the same reason the handshake is: an agent that accepts
  // `session/new` and never answers used to hang this await for ever, with the
  // child parked on it.
  try {
    current = await withTimeout(
      openSession(
        options.loadSessionId,
        cwd,
        {
          onUpdate: options.onUpdate,
          onPermissionRequest: options.onPermissionRequest,
          onConfigOptions: options.onConfigOptions,
        },
        options.haveHistory,
      ),
      options.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS,
      () =>
        new Error(
          `'${provider.manifest.name}' answered the handshake but never opened a session. ${failureContext()}`,
        ),
    );
  } catch (error) {
    // No grace period: it either never answered, or answered with a refusal it
    // has already finished sending.
    stop(0);
    throw error;
  }

  return {
    connection,
    child,
    get sessionId() {
      return current.sessionId;
    },
    get configOptions() {
      return current.configOptions;
    },
    get availableCommands() {
      return availableCommands;
    },
    canLoadSession,

    async adopt(adoptOptions: AdoptOptions) {
      current = await openSession(
        adoptOptions.loadSessionId,
        adoptOptions.cwd,
        {
          onUpdate: adoptOptions.onUpdate,
          onPermissionRequest: adoptOptions.onPermissionRequest,
          onConfigOptions: adoptOptions.onConfigOptions,
        },
        adoptOptions.haveHistory,
      );
      exitHandler = adoptOptions.onExit;
    },

    async listSessions(): Promise<AgentSessionList> {
      if (!canListSessions) return { sessions: [], projects: [], all: [] };
      const result = (await connection.agent.request("session/list", {})) as {
        sessions?: (AgentSession & { _meta?: { messageCount?: unknown } })[];
      };
      const listed = Array.isArray(result?.sessions) ? result.sessions : [];
      // ACP keeps agent-specific list data in `_meta`. Promote the one field the
      // drawer understands so it survives the typed daemon/app wire boundary.
      const all: AgentSession[] = listed
        .map(({ _meta, ...session }) => {
          const messageCount = _meta?.messageCount;
          return {
            ...session,
            ...(typeof messageCount === "number" &&
            Number.isInteger(messageCount) &&
            messageCount >= 0
              ? { messageCount }
              : {}),
          };
        })
        // Newest first, so both the project fold and the cap below see the
        // list in the order the drawer renders it.
        .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));

      // Folded from the uncapped list deliberately: the cap below is a
      // recent-work window, and grouping *that* would offer only the projects
      // the user has touched this week as if they were all that existed.
      const projects = foldProjects(all);
      // Capped before counts are hydrated. This turns a provider with 600
      // archived chats into 30 small local reads instead of 600. The rows are
      // shared with `all`, so the newest ones carry their counts either way.
      const sessions = all.slice(0, SESSION_HISTORY_LIMIT);

      // Both agents have local indexes that are dramatically faster than
      // loading 30 transcripts one-by-one over ACP just to count visible rows.
      await hydrateMessageCounts(provider.manifest.id, sessions);

      // No per-session counting pass beyond that.
      //
      // There used to be one: for agents without a local index, every session
      // was opened with `session/load` purely to count the messages that came
      // back. Each load is a full transcript over a pipe — about 1.7s on GitHub
      // Copilot — so sixteen conversations took 28 seconds, and the drawer had
      // nothing to show for the whole time. What it bought was a subtitle.
      //
      // No ACP client does this. Zed, PostHog's desktop agent, qwen-code and
      // vscode-acp all return `session/list` as the agent gives it and page
      // with a cursor; the count is simply absent when the agent does not
      // supply one, which the app already renders as a plain title.

      return { sessions, projects, all };
    },
    async setConfigOption(configId: string, value: string | boolean) {
      try {
        // The selectors synthesised from `models` and `modes` have no config id
        // the agent knows, so each routes to its own dedicated method instead.
        const synthetic =
          configId === MODEL_CONFIG_ID
            ? { method: "session/set_model", key: "modelId" }
            : configId === MODE_CONFIG_ID
              ? { method: "session/set_mode", key: "modeId" }
              : undefined;

        if (synthetic) {
          await connection.agent.request(synthetic.method, {
            sessionId: current.sessionId,
            [synthetic.key]: String(value),
          });
          // Neither method returns anything useful, so reflect it locally.
          const updated = current.configOptions.map((option) =>
            option.id === configId ? { ...option, currentValue: value } : option,
          );
          current = { ...current, configOptions: updated };
          return updated;
        }

        const result = (await connection.agent.request("session/set_config_option", {
          sessionId: current.sessionId,
          configId,
          ...(typeof value === "boolean" ? { type: "boolean" } : {}),
          value,
        })) as { configOptions?: unknown };
        // The agent replies with the complete list, so trust it over local
        // state — but only when it actually sent one. Not every agent echoes the
        // list back, and treating a silent reply as "no options" wiped every
        // selector the session had: pick a model, lose the thinking level and
        // the mode with it.
        const echoed = normaliseConfigOptions(result?.configOptions);
        const updated =
          echoed.length > 0
            ? echoed
            : current.configOptions.map((option) =>
                option.id === configId ? { ...option, currentValue: value } : option,
              );
        current = { ...current, configOptions: updated };
        return updated;
      } catch (error) {
        // The agent's real reason travels in the JSON-RPC `data`, so reading
        // `.message` here would substitute a bare "Internal error" and throw
        // the explanation away before anyone could see it.
        const detail = humanError(error);
        // Name the option only when the agent's own wording does not, so the
        // message stays one short sentence instead of saying it twice.
        // `cause` keeps the agent's original error for anyone reading a stack
        // trace, while the message stays the short readable one.
        throw new Error(
          detail.includes(configId) ? detail : `Could not set '${configId}': ${detail}`,
          { cause: error },
        );
      }
    },
    promptCapabilities,
    prompt: (text: string, attachments: readonly StoredAttachment[] = []) =>
      connection.agent.request("session/prompt", {
        sessionId: current.sessionId,
        prompt: promptBlocks(text, attachments, promptCapabilities),
      }),
    cancel: () =>
      connection.agent.notify("session/cancel", { sessionId: current.sessionId }),
    answerPermission(requestId, optionId) {
      const resolve = pending.get(requestId);
      if (!resolve) return false;
      pending.delete(requestId);
      resolve(optionId);
      return true;
    },
    close() {
      connection.close();
      stop();
    },
  };
}
