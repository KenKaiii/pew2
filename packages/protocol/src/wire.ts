/**
 * Wire protocol between daemon <-> relay <-> app.
 *
 * ACP itself only standardises stdio framing; Streamable HTTP is still a draft
 * proposal (https://agentclientprotocol.com/protocol/transports). The spec
 * explicitly permits custom transports so long as the JSON-RPC message format
 * and lifecycle are preserved — that is exactly what this envelope does.
 *
 * Design rules:
 *  - Every session event carries a monotonic `seq`, so a reconnecting client
 *    says "I have up to N" and the relay replays N+1.. from its log.
 *    This is what makes phone and desktop show the same conversation.
 *  - The relay treats `payload` as opaque. Under E2EE it is a ciphertext blob.
 */
import { z } from "zod";

/**
 * Bump only on breaking envelope changes.
 *
 * 2 introduced end-to-end encryption: every message except `hello`, `ready` and
 * a relay-generated `error` now travels inside an `Envelope`. A v1 peer cannot
 * read v2 traffic at all, so the mismatch has to be *reported* — left unchecked
 * it surfaces as a socket that connects and then shows nothing, which looks
 * exactly like a broken daemon.
 */
export const WIRE_VERSION = 2;

/**
 * The per-session cursors off a cleartext `hello`, ignoring anything malformed.
 *
 * A `hello` is read before the channel exists, so it is never schema-validated
 * as a whole: whatever the socket sent is a plain `unknown`. Both transports
 * answer these cursors with a catch-up replay, and both must reject junk the
 * same way — a negative or fractional seq here would make `since()` slice from
 * the wrong end and re-send a whole session.
 */
export function readCursors(value: unknown): Record<string, number> {
  if (typeof value !== "object" || value === null) return {};
  const cursors: Record<string, number> = {};
  for (const [sessionId, seq] of Object.entries(value as Record<string, unknown>)) {
    if (typeof seq !== "number" || !Number.isInteger(seq) || seq < 0) continue;
    cursors[sessionId] = seq;
  }
  return cursors;
}

/**
 * Whether a peer speaking `wire` can be talked to, and what to tell the user.
 *
 * Returns a sentence rather than a boolean so both sides say the same thing, and
 * so the side that is *behind* is named: "update the app" and "update pew2 on
 * your computer" are different actions, and guessing wrong wastes an evening.
 */
export function wireMismatch(peer: unknown): string | undefined {
  if (peer === WIRE_VERSION) return undefined;
  if (typeof peer !== "number" || !Number.isInteger(peer)) {
    return "This client did not say which protocol version it speaks. Update it and pair again.";
  }
  return peer < WIRE_VERSION
    ? `This app speaks protocol v${peer}, but this machine needs v${WIRE_VERSION}. Update the app and pair again.`
    : `This app speaks protocol v${peer}, but this machine only has v${WIRE_VERSION}. Update pew2 on your computer.`;
}

export const Role = z.enum(["daemon", "app"]);
export type Role = z.output<typeof Role>;

/**
 * Sent by both sides immediately after the socket opens.
 *
 * `wire` is *not* pinned to a literal here, and that is deliberate. Pinning it
 * would make a v1 `hello` fail schema validation and be discarded as malformed —
 * so the one client that most needs to be told "update the app" is the one that
 * could never receive the message. It is accepted as any integer and checked by
 * `wireMismatch`, which can then say something useful.
 */
export const Hello = z.object({
  t: z.literal("hello"),
  wire: z.number().int(),
  role: Role,
  deviceId: z.string().min(1),
  /** Highest seq the client already has, per session. Enables gap-free resume. */
  cursors: z.record(z.string(), z.number().int().nonnegative()).default({}),
  /**
   * An envelope proving the sender holds the pairing key.
   *
   * `hello` cannot itself be encrypted — it is what establishes the connection —
   * so possession is proved beside it. Without this, knowing the relay room id
   * would be enough to open a socket the daemon then does work for, and the room
   * id is precisely what the relay is given.
   *
   * Optional in the schema so a v1 `hello` still parses far enough to be told
   * *why* it was refused, rather than being dropped as malformed.
   */
  proof: z.unknown().optional(),
});

/**
 * Relay -> both sides, after `hello`.
 *
 * One of the few frames that stay in cleartext: it carries no user content, and
 * it must be readable by a peer that cannot decrypt anything yet — including one
 * about to be told its protocol version is wrong.
 */
export const Ready = z.object({
  t: z.literal("ready"),
  wire: z.literal(WIRE_VERSION),
  /** Server time, used by clients to detect clock skew in rendered timestamps. */
  now: z.number().int(),
});

/**
 * Daemon -> relay -> app. The list of providers this machine can launch,
 * derived from the manifests in `providers/`. This is how a newly added
 * provider "just shows up" on the phone: the daemon rescans and re-announces.
 */
export const ProviderAnnounce = z.object({
  t: z.literal("providers"),
  machine: z.object({ id: z.string(), name: z.string() }),
  providers: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      description: z.string(),
      transport: z.string(),
      color: z.string().optional(),
      requiresWorkspace: z.boolean(),
      /** False when a required env var is missing; app shows why. */
      available: z.boolean(),
      unavailableReason: z.string().optional(),
    }),
  ),
  /**
   * Daemon session ids that are open *right now*.
   *
   * Session ids are assigned per daemon process and die with it, but a client
   * keeps its list across restarts and reconnects — so without this it will
   * happily prompt an id the daemon has never heard of ("Unknown session").
   * Sent on every announcement, and `hello` triggers one, so a reconnecting
   * app learns which of its conversations still exist and resumes the rest by
   * `agentSessionId`.
   */
  activeSessions: z.array(z.string()).default([]),
  /**
   * A newer pew2 has been published and this machine is not running it yet.
   *
   * Absent is the normal state, and deliberately means two different things:
   * either there is nothing newer, or this daemon predates the field. Both are
   * "say nothing", which is why it is optional rather than a nullable object —
   * an older daemon must never make the app claim it is up to date.
   *
   * Only sent while that version is *not installed*. A daemon that can update
   * itself does so within hours and this disappears on its own; one that cannot
   * — no service registered, an unwritable install directory, a download that
   * keeps failing — keeps saying so, because then a human has to re-run the
   * install line. That is the whole reason this reaches the phone: the daemon
   * has no screen of its own, and the person who can act is looking at this one.
   */
  update: z
    .object({
      /** The published version, e.g. "0.9.22". */
      latest: z.string(),
      /**
       * Whether the daemon expects to install it without being asked.
       *
       * False is the actionable case, and it is what turns the notice from a
       * status line into an instruction.
       */
      automatic: z.boolean(),
    })
    .optional(),
});

/**
 * A selector the agent advertises: model, thinking level, permission mode.
 *
 * pew2 never stores model names of its own. The list is whatever the connected
 * app reports for its installed version, so upgrading that app changes the
 * options here with no release of pew2.
 */
export const ConfigOption = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  /** 'model' | 'thought_level' | 'mode' | 'model_config', or a custom '_' name. */
  category: z.string().optional(),
  type: z.string(),
  currentValue: z.union([z.string(), z.boolean()]),
  options: z
    .array(
      z.object({
        value: z.string(),
        name: z.string(),
        description: z.string().optional(),
      }),
    )
    .optional(),
});

/**
 * A conversation the agent already holds on disk, from `session/list`.
 *
 * These are not pew2's sessions. Coding agents keep their own history, so work
 * begun at the desk must be reachable from the phone.
 */
export const AgentSession = z.object({
  sessionId: z.string(),
  cwd: z.string(),
  title: z.string().optional(),
  /** ISO 8601 timestamp of last activity, when the agent tracks one. */
  updatedAt: z.string().optional(),
  /** Message rows available before the transcript is opened on the app. */
  messageCount: z.number().int().nonnegative().optional(),
});

/**
 * A project the agent has worked in, derived from its stored sessions.
 *
 * The drawer's history is capped at the newest conversations, so it is not a
 * list of projects: a busy week in one repo hides every other. This is folded
 * from the agent's *whole* `session/list` instead, which is why it carries its
 * own counts and its own last-activity stamp.
 */
export const AgentProject = z.object({
  /** Absolute path, and the identity of the project everywhere. */
  path: z.string(),
  /** Last path segment: the project as people say it. */
  name: z.string(),
  /** How many stored conversations live in it. */
  sessions: z.number().int().nonnegative(),
  /** ISO 8601 of the newest of those, when the agent dates them. */
  updatedAt: z.string().optional(),
});

/** One slash command an agent offers, e.g. from `.claude/commands`. */
export const SlashCommand = z.object({
  name: z.string(),
  description: z.string(),
  /** Placeholder for the argument it expects, when it takes one. */
  hint: z.string().optional(),
});

/** App -> daemon. What does this provider currently offer? */
export const ProviderCapabilitiesRequest = z.object({
  t: z.literal("provider.capabilities"),
  providerId: z.string(),
  /** Re-probe instead of answering from cache, e.g. after the agent updates. */
  refresh: z.boolean().optional(),
});

/**
 * Daemon -> app. What the provider offers, learned by asking the agent: its
 * live selectors and its own stored conversations. Sent before any session
 * exists so the empty state shows real options and real history.
 */
export const ProviderCapabilities = z.object({
  t: z.literal("provider.capabilities"),
  providerId: z.string(),
  configOptions: z.array(ConfigOption),
  sessions: z.array(AgentSession),
  /** Whether those sessions can be reopened, i.e. the agent supports load. */
  canResume: z.boolean(),
  /**
   * Slash commands the agent offers, learned from the probe session.
   *
   * Optional so a daemon older than this field still validates. They depend on
   * the project the agent opened, which is why they travel with capabilities
   * rather than being a fixed property of the provider.
   */
  commands: z.array(SlashCommand).optional(),
  /**
   * Every project this agent holds history for, newest first.
   *
   * Optional so an older daemon still validates; the app then falls back to
   * the projects it can see in `sessions`.
   */
  projects: z.array(AgentProject).optional(),
  /** GG Coder extensions this agent speaks; see `ProviderExtensions`. */
  extensions: z.lazy(() => ProviderExtensions).optional(),
});

/**
 * App -> daemon. The agent's conversations in one project.
 *
 * `sessions` above is the newest handful across everything, which is the wrong
 * list once a project is chosen — a repo touched last month has none of its
 * conversations in it. The daemon answers from the full list it already read.
 */
export const ProviderSessionsRequest = z.object({
  t: z.literal("provider.sessions"),
  providerId: z.string(),
  /** Absolute project path, as given in `AgentProject.path`. */
  cwd: z.string(),
});

/** Daemon -> app. Answer to `provider.sessions`. */
export const ProviderSessions = z.object({
  t: z.literal("provider.sessions"),
  providerId: z.string(),
  cwd: z.string(),
  sessions: z.array(AgentSession),
  /** Same gate as capabilities: rows that cannot be reopened are not listed. */
  canResume: z.boolean(),
});

/**
 * App -> daemon. Choose a selector before any session exists.
 *
 * A conversation is only created by its first prompt, so a model or mode picked
 * in the empty state has nothing to be applied to yet. The daemon remembers it
 * against the provider, and the session that prompt creates opens with it set.
 */
export const SetProviderConfig = z.object({
  t: z.literal("provider.config"),
  providerId: z.string(),
  configId: z.string(),
  value: z.union([z.string(), z.boolean()]),
});

/**
 * Daemon -> app. What a *new* session on this provider will open with.
 *
 * The same `t` in the other direction, exactly as `session.config` already
 * works: the app names a choice, the daemon answers with the resulting set.
 *
 * Broadcast rather than replied to, and sent for a change made anywhere —
 * including one made inside a live conversation, which the daemon also records
 * against the provider. Without it the empty state kept showing whichever
 * selectors the last conversation happened to hold, while the next prompt
 * opened at the remembered ones: a pill naming a model that was not the model
 * about to run. Two devices make that worse, since a choice at the desk moves
 * what the phone's next prompt will use.
 */
export const ProviderConfig = z.object({
  t: z.literal("provider.config"),
  providerId: z.string(),
  configOptions: z.array(ConfigOption),
});

/** App -> daemon. Reopen one of the agent's own past conversations. */
export const ResumeSession = z.object({
  t: z.literal("session.resume"),
  providerId: z.string(),
  /** The agent's session id, as reported by `session/list`. */
  agentSessionId: z.string(),
  cwd: z.string().optional(),
});

/**
 * App -> daemon. Find somewhere to work.
 *
 * The project list in the drawer is folded from an agent's own past sessions,
 * so a freshly installed agent offers nothing and cannot be started. The
 * directories are on the desktop, and a phone's file picker returns a handle
 * that machine cannot use — so the daemon looks and the phone renders.
 *
 * Omit `path` for the opening view: a scan for git checkouts, which is what
 * makes this usable on a touchscreen instead of a walk down from `/`.
 */
export const WorkspacesRequest = z.object({
  t: z.literal("workspaces"),
  requestId: z.string(),
  /** Browse this directory. Absent means "suggest repositories". */
  path: z.string().optional(),
  /** Also list the browsed directory's regular files (goal context). Absent = folders only. */
  files: z.boolean().optional(),
});

export const WorkspaceEntry = z.object({
  path: z.string(),
  name: z.string(),
  repo: z.boolean(),
  updatedAt: z.string().optional(),
  /** Absent means folder: older daemons never list files. Files are never browsable. */
  kind: z.enum(["folder", "file"]).optional(),
});

/** Daemon -> app. Answer to `workspaces`. */
export const Workspaces = z.object({
  t: z.literal("workspaces"),
  requestId: z.string(),
  /** The directory listed, absent for the suggestions view. */
  path: z.string().optional(),
  /** Where "up" goes, absent at a browsable root. */
  parent: z.string().optional(),
  entries: z.array(WorkspaceEntry),
  /**
   * The request named a path that is missing, not a directory, or outside the
   * roots browsing is allowed to reach. One flag rather than three: the client
   * shows the same "can't open that" either way, and distinguishing them tells
   * a caller holding a stolen token what exists on the disk.
   */
  refused: z.boolean().default(false),
});

/** App -> daemon. Start a new session with a provider. */
export const StartSession = z.object({
  t: z.literal("session.start"),
  /**
   * Echoed back on `session.started`, so a client can tell the session it asked
   * for from one another device started.
   *
   * `session.started` is broadcast to every paired client, and without this
   * none of them could tell which request a given one answered. Each assumed it
   * was its own: starting a conversation anywhere redirected every other device
   * to it, and — because the frame carries no transcript — redirected them to a
   * blank one.
   *
   * Optional because a client need not send one, and because requiring it would
   * reject every `session.start` from a client older than this field the moment
   * the daemon began validating against this schema.
   */
  requestId: z.string().optional(),
  providerId: z.string(),
  cwd: z.string().optional(),
});

/**
 * A file the phone is sending *to* the agent, inlined.
 *
 * The reverse direction of `ImageData`: that machine cannot see the phone's
 * camera roll any more than the phone can see its disk, so the bytes travel in
 * the prompt and the daemon writes them somewhere the agent can open.
 */
export const PromptAttachment = z.object({
  /** Display name only. The daemon sanitises it before it becomes a path. */
  name: z.string().min(1),
  mimeType: z.string(),
  /** Base64, no `data:` prefix. */
  data: z.string(),
});

/**
 * Ceilings for one prompt's attachments.
 *
 * Base64 inflates by a third, so 12MB of files is ~16MB on the wire — inside
 * the relay Durable Object's 32 MiB received-message limit, which is otherwise
 * hit as a socket that simply dies. Checked on the phone, where the reason can
 * be shown, *and* in the daemon, which cannot trust a client.
 */
export const MAX_ATTACHMENTS = 5;
export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
export const MAX_ATTACHMENTS_TOTAL_BYTES = 12 * 1024 * 1024;

/** App -> daemon. Send a prompt into an existing session. */
export const Prompt = z.object({
  t: z.literal("session.prompt"),
  sessionId: z.string(),
  text: z.string(),
  /** Defaulted, so a client older than attachments still validates. */
  attachments: z.array(PromptAttachment).default([]),
});

/** App -> daemon. Interrupt the current turn. */
export const Cancel = z.object({
  t: z.literal("session.cancel"),
  sessionId: z.string(),
});

/**
 * App -> daemon. Change a selector on a live session.
 *
 * The counterpart to {@link SetProviderConfig}, which is the same choice made
 * before any session exists. Both halves of that pair have to be described, or
 * validating inbound messages refuses every model switch made mid-conversation.
 */
export const SetSessionConfig = z.object({
  t: z.literal("session.config"),
  sessionId: z.string(),
  configId: z.string(),
  value: z.union([z.string(), z.boolean()]),
});

/** App -> daemon. Answer an outstanding permission request. */
export const PermissionReply = z.object({
  t: z.literal("session.permission"),
  sessionId: z.string(),
  requestId: z.string(),
  optionId: z.string(),
});

/**
 * App -> daemon. Fetch an image the agent referenced by path.
 *
 * Agents that generate or inspect images name a file on the *desktop*: a
 * `resource_link`, or plain markdown like `![](.gg/generated/x.png)`. The phone
 * cannot read that disk, so the picture is a blank box unless the daemon hands
 * the bytes over the same socket everything else uses.
 */
export const ImageRequest = z.object({
  t: z.literal("image.fetch"),
  /** Echoed back, so a client can match a reply to the view that asked. */
  requestId: z.string(),
  /** Which session's working directory relative paths resolve against. */
  sessionId: z.string().optional(),
  uri: z.string(),
});

/**
 * Daemon -> app. The image, inlined.
 *
 * Answered as a reply rather than a session event: this is bytes on demand for
 * one client's viewport, and putting megabytes of base64 into the replayable
 * log would make every reconnect re-download every picture ever shown.
 */
export const ImageData = z.object({
  t: z.literal("image"),
  requestId: z.string(),
  uri: z.string(),
  /** `data:<mime>;base64,...`, absent when `error` explains why not. */
  dataUri: z.string().optional(),
  mimeType: z.string().optional(),
  error: z.string().optional(),
});

/**
 * App -> daemon. Which project is this session in, and how dirty is it?
 *
 * The phone has no filesystem to look at, so the working directory and the
 * count of uncommitted files are the only context it can offer before a prompt
 * goes out. Asked on demand rather than streamed: it changes with the agent's
 * own edits, so the app re-asks whenever a turn ends.
 */
export const WorkspaceRequest = z.object({
  t: z.literal("workspace.status"),
  /** The open session, whose cwd is the project being described. */
  sessionId: z.string().optional(),
  /**
   * Fallback before a session exists: the agent's own last project, which is
   * where the daemon would open one. No arbitrary path is accepted from the
   * client — the daemon resolves the directory itself.
   */
  providerId: z.string().optional(),
  /**
   * A project the user picked, so the composer can name where the next prompt
   * will land before any session exists.
   *
   * Honoured only when it is one of the projects this daemon itself announced
   * for that provider; anything else falls back as if it were absent, so this
   * cannot be used to ask whether some other directory exists.
   */
  cwd: z.string().optional(),
});

/** Daemon -> app. The answer to `workspace.status`. */
export const Workspace = z.object({
  t: z.literal("workspace"),
  sessionId: z.string().optional(),
  cwd: z.string(),
  /** Last path segment: the project's name as people say it. */
  folder: z.string(),
  /** False when the directory is not inside a git working tree. */
  repo: z.boolean(),
  /** Changed, staged and untracked entries, as `git status` counts them. */
  uncommitted: z.number().int().nonnegative(),
});

/**
 * Daemon -> relay -> app. An ordered, append-only event for a session.
 * `payload` mirrors the ACP `session/update` notification so the app renders
 * agent output without pew2 inventing a second content model.
 */
export const SessionEvent = z.object({
  t: z.literal("session.event"),
  sessionId: z.string(),
  seq: z.number().int().nonnegative(),
  at: z.number().int(),
  payload: z.unknown(),
});

/** Relay -> app. Replayed history after a resume, oldest first. */
export const Replay = z.object({
  t: z.literal("session.replay"),
  sessionId: z.string(),
  events: z.array(SessionEvent),
  /** False for a progressive resume batch; omitted/true marks replay complete. */
  complete: z.boolean().optional(),
  /**
   * This batch is a reconnect catch-up, not history.
   *
   * The two arrive in the same frame but mean opposite things. A resume replay
   * is a transcript of work that finished long ago, so it must not light up the
   * activity line. A catch-up is the last few seconds of a turn that is *still
   * running* — the tool calls in it are what the agent is doing right now, and
   * dropping them is why a phone that lost its socket mid-turn showed nothing
   * until the agent happened to start another tool.
   */
  catchUp: z.boolean().optional(),
  /**
   * Whether a turn is still in flight, on a catch-up frame.
   *
   * `session.idle` is broadcast, not logged, so a turn that ended while the
   * client was away leaves no event to replay. Without this the app would stay
   * busy forever after catching up on a finished turn.
   */
  working: z.boolean().optional(),
  /**
   * Approval requests this session is still blocked on, on a catch-up frame.
   *
   * The one piece of a turn that a replayed event stream cannot carry. A
   * permission request *is* in the log, but the app deliberately ignores it
   * there: in a resumed transcript it was answered long ago, and raising it
   * again is a phantom approve sheet over finished history. So a phone that
   * dropped its signal at the wrong moment came back to a spinner, with the
   * agent on the desktop waiting on an answer nobody could give — no timeout on
   * either side, so the turn simply stopped.
   *
   * This is the daemon saying which requests are open *right now*, which only
   * it can know: the resolver lives with the ACP connection. Same shape as the
   * logged event's payload, so both paths render through one reader.
   */
  permissions: z.array(z.object({ requestId: z.string(), params: z.unknown() })).optional(),
  /**
   * Same rule for queued messages, open `ask_user` questions and goal state:
   * live state only the daemon holds. Absent = an older daemon said nothing;
   * `[]` = none. Defined after their schemas below (lazy, so order is free).
   */
  queued: z.lazy(() => z.array(QueuedMessage)).optional(),
  asks: z.lazy(() => z.array(AskRequest)).optional(),
  goal: z.lazy(() => GoalState).optional(),
  plan: z.lazy(() => PlanState).optional(),
  autopilot: z.lazy(() => AutopilotState).optional(),
});

/**
 * Daemon -> app. A turn finished; the agent is waiting on you again.
 *
 * Broadcast to every client, not just the one that prompted, because the phone
 * is very often not the device watching this session — and it is the only
 * signal a client has that a conversation it left running is done. The project
 * travels with it so a notification can name the work ("pew2") without the app
 * holding a path for every session it has ever seen.
 */
export const SessionIdle = z.object({
  t: z.literal("session.idle"),
  sessionId: z.string(),
  /** The agent that ran the turn, so a client can name it. */
  providerId: z.string().optional(),
  /** Last segment of the session's cwd: the project as people say it. */
  folder: z.string().optional(),
  /**
   * How the turn ended, when it was not a normal finish.
   *
   * `failed`: the agent rejected the prompt or crashed, so a banner must not
   * say "Finished". `cancelled`: someone pressed stop, so there is nothing to
   * announce. Absent = finished normally, which is also all an older daemon
   * could say, so an app reading this from one keeps announcing as before.
   */
  outcome: z.enum(["failed", "cancelled"]).optional(),
  /** Why a `failed` turn failed, in the words `humanError` produced. */
  reason: z.string().optional(),
});

/**
 * App -> daemon. Where to push when this phone is not listening.
 *
 * The local banner can only fire while the app's JavaScript is running, and iOS
 * suspends that within seconds of the app leaving the screen — so the one case
 * notifications exist for, a long turn landing while the phone is in a pocket,
 * is the exact case it could not cover. The turn was announced minutes late, on
 * reopening, when the socket came back and `session.idle` finally arrived.
 *
 * A remote push has to come from something still awake, which is the daemon.
 * This is how it learns where to send one.
 *
 * Travels sealed like every other post-handshake frame, so the relay never sees
 * the token. The relay is otherwise not involved: the desktop has internet and
 * calls the push service itself, which keeps the relay a dumb pipe that stores
 * nothing.
 *
 * Sent on every connect, because push tokens rotate.
 *
 * Deliberately not a `WIRE_VERSION` bump. A new message type is additive: a
 * daemon that predates it answers `unknown_message`, which the app treats as a
 * refusal and falls back to its local-only banners — exactly the behaviour it
 * had before. Bumping would instead refuse the connection outright and take
 * working sessions down to deliver a notification improvement.
 *
 * The daemon says nothing on success. Silence is acceptance; only a refusal is
 * spoken, so the app must not assume a token it holds is a token the daemon
 * kept.
 */
export const PushRegister = z.object({
  t: z.literal("app.push"),
  /**
   * An Expo push token (`ExponentPushToken[...]`).
   *
   * Not a bare APNs/FCM token: sending to those needs signing credentials, which
   * live in EAS and must not ship inside a daemon anyone can read the source of.
   */
  token: z.string().min(1),
  platform: z.enum(["ios", "android"]),
});

/**
 * App -> daemon. This phone can ring like a phone call: its PushKit (VoIP)
 * token, for a CallKit incoming call when Pew needs the user. Sent only by an
 * iPhone where CallKit is allowed (never in China) and once the user agreed
 * to voice calls; `token: null` withdraws it. The daemon sends rings through
 * the relay, which holds the Apple key; anything it can't ring this way gets
 * the time-sensitive banner as before. An older daemon answers
 * `unknown_message`, and the phone simply keeps getting banners.
 */
export const VoipRegister = z.object({
  t: z.literal("app.voip"),
  token: z
    .string()
    .regex(/^[0-9a-f]{64,200}$/)
    .nullable(),
  /** Which APNs a token belongs to: development builds get sandbox tokens. */
  env: z.enum(["sandbox", "production"]),
});

/**
 * App -> daemon. A short trace of what the phone saw during a call (audio
 * route changes, the mic opening and closing, Pew starting and stopping), for
 * the daemon's log: the only place a lock-screen call can be looked at after
 * the fact. No words from the call, ever; only states and times.
 *
 * Printable ASCII only and capped in size, because every line lands in a log
 * file verbatim: a newline or control character would let it forge log lines.
 * An older daemon answers `unknown_message`, which the phone ignores.
 */
export const AppDiag = z.object({
  t: z.literal("app.diag"),
  lines: z
    .array(
      z
        .string()
        .max(300)
        .regex(/^[\x20-\x7E]*$/),
    )
    .min(1)
    .max(60),
});

/**
 * Daemon -> every other client, when one of them says `hello`.
 *
 * The daemon is the only party that sees arrivals on both transports, so it is
 * the only party that can report them consistently. `pew2 pair` uses this to
 * turn a printed QR into a confirmed pairing; clients that do not care are
 * expected to ignore it.
 */
export const DeviceJoined = z.object({
  t: z.literal("device.joined"),
  deviceId: z.string(),
  at: z.number().int(),
});

// ── Queued messages ────────────────────────────────────────

/**
 * A message the user sent while a turn was running, waiting for the agent to
 * pick it up. Same affordance as GG Coder's desktop queue strip.
 *
 * The daemon owns the queue for *every* agent: an agent that advertises GG's
 * queue extension (`agentCapabilities._meta.gg.queue`) receives it mid-run and
 * folds it in at its next step; any other agent gets everything still queued
 * as its next turn the moment the current one ends. Ids are daemon-minted.
 */
export const QueuedMessage = z.object({
  id: z.string(),
  text: z.string(),
  /** How many files ride with it, for the strip's paperclip; absent means none. */
  attachments: z.number().int().nonnegative().optional(),
});

/**
 * Daemon -> app. A session's queue changed: broadcast, never logged.
 *
 * The full list every time (replace, never patch). A queued message that is
 * picked up leaves this list *and* appears in the log as an ordinary
 * `user_message` at the moment it reached the agent, so the transcript shows
 * it where the agent actually read it.
 */
export const SessionQueue = z.object({
  t: z.literal("session.queue"),
  sessionId: z.string(),
  queued: z.array(QueuedMessage),
  /**
   * Messages taken off the queue *unsent* because the turn was cancelled. GG
   * Coder hands these back to the composer rather than running them after a
   * stop; a client puts them back into an empty draft, and ignores them
   * otherwise. Absent on every other update.
   */
  returned: z.array(QueuedMessage).optional(),
});

/** App -> daemon. Withdraw one queued message before the agent reads it. */
export const QueueCancel = z.object({
  t: z.literal("session.queue.cancel"),
  sessionId: z.string(),
  id: z.string(),
});

// ── ask_user ───────────────────────────────────────────────

/** One selectable answer. `value` is what the agent gets back; `label` is UI. */
export const AskOption = z.object({
  label: z.string(),
  value: z.string().optional(),
  /** One short line under the label. */
  hint: z.string().optional(),
  /** The agent's recommendation: tagged in the UI, never preselected. */
  recommended: z.boolean().optional(),
});

export const AskQuestion = z.object({
  /** The key this question's answer comes back under. */
  id: z.string(),
  question: z.string(),
  kind: z.enum(["confirm", "choice", "multi", "text"]),
  detail: z.string().optional(),
  /** `confirm` without options means Yes / No. */
  options: z.array(AskOption).optional(),
  /** Whether a free-text answer is offered beside the options (default true; always on `text`). */
  allowOther: z.boolean().optional(),
});

/**
 * An open question from the agent (GG Coder's `ask_user` tool), relayed from
 * the ACP extension request `_gg/ask_user`.
 *
 * Logged as a session event with payload `{ kind: "ask_user", requestId,
 * questions }`, and — exactly like a permission — carried as live state in a
 * catch-up `Replay.asks`, because a logged question is history and must never
 * re-open a card over a finished transcript.
 *
 * When it stops being open — answered from any client, withdrawn or
 * superseded by the agent, or its session/connection closed — the daemon logs
 * `{ kind: "ask_user_closed", requestId }`, which closes the card everywhere.
 * An ask may outlive the turn that raised it.
 */
export const AskRequest = z.object({
  requestId: z.string(),
  questions: z.array(AskQuestion),
});

/** What the agent hears back. Mirrors GG Coder's `AskUserResult` subset. */
export const AskResult = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("answer"),
    /** Question id -> chosen value (or label when it has none), typed text, or several for `multi`. */
    answers: z.record(z.string(), z.union([z.string(), z.array(z.string())])),
  }),
  z.object({ action: z.literal("cancel") }),
]);

/** App -> daemon. Answer (or dismiss) an open question. */
export const AskReply = z.object({
  t: z.literal("session.ask"),
  sessionId: z.string(),
  requestId: z.string(),
  result: AskResult,
});

// ── Voice ("Ken on the line") ──────────────────────────────

/**
 * Voice calls with a cloud realtime model about the user's agents.
 *
 * The voice model is NOT the coding agent: it is a small realtime assistant
 * that reads the daemon's inbox of things waiting on the user and acts on them
 * through the daemon's existing methods (approve, answer, decide a plan,
 * prompt). Audio goes phone <-> provider directly over WebRTC; the relay never
 * carries it. The daemon holds the credentials, mints a short-lived client
 * secret per call, and executes every tool call (`voice.tool`), so behaviour
 * ships on the daemon's rail, not the App Store's.
 *
 * Credentials are found, not configured: an OpenAI login an agent on this
 * machine already holds (GG Coder, Codex) is used when present; only when none
 * exists does the user sign in from the phone (`voice.login`, device code).
 *
 * Every field is optional on arrival and an older daemon answers these with
 * `unknown_message`, which the app reads as "voice not available here".
 */

/** Where the daemon's voice credentials came from. */
export const VoiceSource = z.enum(["ggcoder", "codex", "pew2", "apikey"]);

/** A device-code sign-in in progress: the user opens `verificationUrl` and types `userCode`. */
export const VoiceLoginPending = z.object({
  userCode: z.string(),
  verificationUrl: z.string(),
  /** Epoch ms. */
  expiresAt: z.number().int().optional(),
});

/**
 * Daemon -> app. Whether a call can be placed, and why not.
 * Answer to `voice.status` / `voice.login` (with `requestId`), and broadcast
 * unprompted when it changes (a login completes, a token dies).
 */
export const VoiceStatus = z.object({
  t: z.literal("voice.status"),
  requestId: z.string().optional(),
  available: z.boolean(),
  source: VoiceSource.optional(),
  /** Account email or label for the settings row, when known. */
  account: z.string().optional(),
  /** One plain sentence when unavailable, e.g. "Sign in to OpenAI to use voice." */
  reason: z.string().optional(),
  /** True when signing in from the phone would fix `available: false`. */
  canLogin: z.boolean().optional(),
  login: VoiceLoginPending.optional(),
  /** The call policy's current settings. Absent from a daemon without the policy. */
  prefs: z.lazy(() => VoicePrefsValues).optional(),
  /** Sessions allowed to ring. Absent: an older daemon (it rings for any session in `onthego`). */
  armed: z.array(z.lazy(() => VoiceArmed)).optional(),
});

/**
 * When the daemon may reach the user about waiting items.
 *  - `off`: never (today's banners still arrive as before).
 *  - `notify`: today's banners, plus a "Talk" action on them.
 *  - `onthego`: batched calls: one "pew2 needs you · Talk" alert for everything
 *    that blocked within `batchSeconds`, at most one call at a time, then quiet
 *    for `cooldownMinutes` unless something has waited a long time.
 */
export const VoicePrefsValues = z.object({
  mode: z.enum(["off", "notify", "onthego"]),
  batchSeconds: z.number().int().min(0).max(600).optional(),
  cooldownMinutes: z.number().int().min(0).max(240).optional(),
  maxCallsPerHour: z.number().int().min(1).max(20).optional(),
  /**
   * Epoch ms when `onthego` switches itself back to `notify`; 0 = until the
   * user turns it off. A forgotten switch must never ring at 3 am.
   */
  ringUntil: z.number().int().min(0).optional(),
  /** No rings in this window (the banners still arrive). */
  quietHours: z.lazy(() => VoiceQuietHours).optional(),
  /** Arm every session the phone starts (see `voice.arm`). */
  armNewSessions: z.boolean().optional(),
  /**
   * Which chats may ring: every one ("all"), or only those armed with
   * `voice.arm` ("chosen"). Absent from an older daemon, which knows only
   * armed chats.
   */
  ringScope: z.enum(["all", "chosen"]).optional(),
});

/** A daily window, in the phone's own time zone, when rings become banners. */
export const VoiceQuietHours = z.object({
  on: z.boolean(),
  /** Minutes after local midnight. `from > to` wraps past midnight (22:00-08:00). */
  from: z.number().int().min(0).max(1439),
  to: z.number().int().min(0).max(1439),
  /** IANA time zone of the phone, e.g. "Europe/London". Absent: the computer's. */
  tz: z.string().max(64).optional(),
});

/**
 * App -> daemon. Let this session ring the user (`on`), or stop it. A session
 * rings only while armed; arming ends by itself when the session closes or
 * after 12 hours. Answered with a `voice.status` broadcast carrying `armed`.
 * An older app never arms anything, so a newer daemon never rings it.
 */
export const VoiceArm = z.object({
  t: z.literal("voice.arm"),
  sessionId: z.string().min(1).max(200),
  on: z.boolean(),
});

/** An armed session, as `voice.status` lists it. */
export const VoiceArmed = z.object({
  sessionId: z.string(),
  /** Epoch ms when arming ends by itself. */
  until: z.number().int(),
});

/** App -> daemon. Change the call policy; answered with a `voice.status` broadcast. */
export const VoicePrefs = z.object({
  t: z.literal("voice.prefs"),
  prefs: VoicePrefsValues.partial(),
});

/**
 * App -> daemon. Forget every voice thread (what was said on earlier calls,
 * kept per chat on the computer so the next call carries on). An older
 * daemon keeps none and ignores this.
 */
export const VoiceForget = z.object({
  t: z.literal("voice.forget"),
});

/** App -> daemon. Ask for `voice.status`. */
export const VoiceStatusRequest = z.object({
  t: z.literal("voice.status"),
  requestId: z.string(),
});

/**
 * App -> daemon. pew2's own OpenAI sign-in, used only when no agent's login exists.
 *  - `start`: begin a device-code login; the reply's `login` carries the code.
 *  - `cancel`: abandon a pending login.
 *  - `logout`: forget pew2's own login (never touches an agent's credentials).
 */
export const VoiceLogin = z.object({
  t: z.literal("voice.login"),
  requestId: z.string(),
  action: z.enum(["start", "cancel", "logout"]),
});

/** One thing an agent is stopped on, as the voice layer and the call policy see it. */
export const VoiceInboxItem = z.object({
  /** Stable for the life of the request: `${sessionId}:${kind}:${requestId}`. */
  id: z.string(),
  sessionId: z.string(),
  kind: z.enum(["approval", "question", "plan"]),
  /** The daemon's request id for the underlying permission / ask / plan generation. */
  requestId: z.string(),
  folder: z.string().optional(),
  agentName: z.string().optional(),
  /** One line: the tool to approve, the first question, or "Plan ready for review". */
  title: z.string(),
  /** Epoch ms when it started waiting. */
  since: z.number().int(),
  /**
   * A question's full questions, so the call screen can show the same card as
   * the chat and the user can tap an answer while Pew reads it out. Absent from
   * an older daemon (the call then stays voice-only) and on other kinds.
   */
  questions: z.array(AskQuestion).optional(),
  /** An approval's choices, for the same card. Absent: older daemon, or not an approval. */
  options: z
    .array(z.object({ optionId: z.string(), name: z.string(), kind: z.string().optional() }))
    .optional(),
  /** An approval's whole request, uncapped (`title` is one capped line). */
  detail: z.string().optional(),
});

/**
 * Daemon -> app. Everything waiting on the user, across every session.
 * Full list each time (replace, never patch); broadcast on change, never logged.
 * A phone in a call tells the voice model about items that appear mid-call, so
 * a second agent blocking while you're talking joins this call, not a new one.
 */
export const VoiceInbox = z.object({
  t: z.literal("voice.inbox"),
  items: z.array(VoiceInboxItem),
});

/**
 * One line of a session's live feed on the call screen.
 *  - `text`: the agent said something (its latest line of prose).
 *  - `tool`: the agent started a tool (its title, e.g. "Edit checkout/cart.tsx").
 *  - `result`: a tool finished; `text` is short ("42 passed", or the tool title).
 *  - `ask` / `perm`: the agent is now waiting on a question / an approval.
 *  - `pew`: what Pew (the voice assistant) typed into this session, verbatim.
 *  - `note`: something Pew did to it ("Approved once: npm publish").
 */
export const VoiceBoardLine = z.object({
  kind: z.enum(["text", "tool", "result", "ask", "perm", "pew", "note"]),
  text: z.string(),
  /** Epoch ms. */
  at: z.number().int(),
});

/** One agent session as Pew's call screen shows it. */
export const VoiceBoardSession = z.object({
  sessionId: z.string(),
  /** For the agent's brand colour, which the app already has from `providers`. */
  providerId: z.string().optional(),
  folder: z.string().optional(),
  agentName: z.string().optional(),
  /**
   * What it is doing. `done` = finished a turn since the call started (or in the
   * last 10 minutes) and waiting on nothing; `idle` = neither working nor recently done.
   */
  status: z.enum(["working", "asks", "needs", "done", "idle"]),
  /** Epoch ms the status last changed. */
  since: z.number().int(),
  /** Epoch ms Pew last acted on or briefed this session; 0 = never this call. */
  touchedAt: z.number().int(),
  /** Newest last, at most 12. */
  lines: z.array(VoiceBoardLine),
});

/**
 * Daemon -> app. The live board behind the call screen: every session worth
 * showing, most relevant first (touched by Pew, then waiting on the user, then
 * working, then recently done). Full list each time (replace, never patch),
 * broadcast while a call is open and throttled; never logged. The app shows
 * at most four and folds the rest. Absent from an older daemon: the app falls
 * back to lanes built from `voice.inbox`.
 */
export const VoiceBoard = z.object({
  t: z.literal("voice.board"),
  callId: z.string().optional(),
  sessions: z.array(VoiceBoardSession),
});

/**
 * App -> daemon. Mint a realtime session for a call.
 * `focus` names the item the user tapped (a push, a sheet); the briefing leads with it.
 */
export const VoiceSessionRequest = z.object({
  t: z.literal("voice.session"),
  requestId: z.string(),
  focus: z.string().optional(),
  /**
   * The conversation open on the phone when the call started: the project the
   * user most likely wants to talk about. Absent from an older app (Pew then
   * asks).
   */
  sessionId: z.string().max(200).optional(),
  /**
   * The project and agent on screen when no conversation exists yet (a new
   * chat with nothing sent): without them Pew knew nothing about where the
   * call came from. `cwd` is honoured only via `knownProject()`. Absent from
   * an older app.
   */
  cwd: z.string().max(4096).optional(),
  providerId: z.string().max(200).optional(),
});

/**
 * Daemon -> app, during a call. Something Pew should know now: a session it
 * prompted finished (and what it said), or started working. The app adds it
 * to the realtime conversation as a system message and, with `speak`, lets
 * Pew say it at the next pause. Composed on the daemon so what Pew hears
 * ships on the daemon's rail; an older app ignores it (Pew can still ask
 * `get_status`).
 */
export const VoiceNote = z.object({
  t: z.literal("voice.note"),
  callId: z.string(),
  text: z.string().max(4000),
  speak: z.boolean().optional(),
  /** The session's name as Pew says it, so the app can pace and de-duplicate news. Absent: an older daemon. */
  about: z.string().max(200).optional(),
});

/** Daemon -> app. A call is ready to connect, or why not. */
export const VoiceSession = z.object({
  t: z.literal("voice.session"),
  requestId: z.string(),
  ok: z.boolean(),
  error: z.string().optional(),
  /** "openai" for now. The app picks its transport by this. */
  provider: z.literal("openai").optional(),
  /** Ephemeral client secret; instructions and tools are already bound to it. */
  secret: z.string().optional(),
  /** Epoch ms after which `secret` can no longer open a call. */
  expiresAt: z.number().int().optional(),
  model: z.string().optional(),
  /** Daemon-minted id for this call; echo it on `voice.tool` and `voice.end`. */
  callId: z.string().optional(),
  /** The inbox the briefing was built from, so the app can show the same list. */
  items: z.array(VoiceInboxItem).optional(),
});

/** App -> daemon. The voice model called a tool; the daemon runs it. */
export const VoiceTool = z.object({
  t: z.literal("voice.tool"),
  requestId: z.string(),
  callId: z.string(),
  /** The realtime function call id, echoed back so the app can answer the model. */
  toolCallId: z.string(),
  name: z.string(),
  /** The model's JSON arguments, unparsed. */
  arguments: z.string(),
});

/** Daemon -> app. A tool's result, to hand back to the model as `function_call_output`. */
export const VoiceToolResult = z.object({
  t: z.literal("voice.tool"),
  requestId: z.string(),
  callId: z.string(),
  toolCallId: z.string(),
  /** JSON text for the model. */
  output: z.string(),
  /** The app should hang up after the model speaks its goodbye. */
  hangUp: z.boolean().optional(),
});

/**
 * App -> daemon. A call ended. Feeds the call policy's cooldown, and carries the
 * user's "call me back in N minutes" when they asked for one.
 */
export const VoiceEnd = z.object({
  t: z.literal("voice.end"),
  callId: z.string(),
  reason: z.enum(["hangup", "missed", "declined", "failed"]).optional(),
  /** Spoken transcript lines, for the record; optional and capped by the daemon. */
  transcript: z
    .array(z.object({ role: z.enum(["user", "assistant"]), text: z.string() }))
    .optional(),
});

// ── Goals (GG Coder) ───────────────────────────────────────

/**
 * A GG Coder goal: a long-running objective worked by GG Goals, a
 * coordinator agent whose working directory is the goal's own folder
 * (`~/.gg/goals/<id>`). Goals live on the desktop's disk and are shared with
 * GG Coder's desktop app; the phone lists, creates and opens them through the
 * `ggcoder` provider's ACP extension methods (`_gg/goals/*`).
 */
export const GoalStatus = z.enum(["briefing", "running", "paused", "interrupted", "idle"]);

export const GoalContextItem = z.object({
  kind: z.enum(["folder", "file"]),
  path: z.string(),
});

export const GoalSummary = z.object({
  id: z.string(),
  name: z.string(),
  /** The goal text as the user wrote it. */
  goal: z.string(),
  context: z.array(GoalContextItem),
  /** The goal folder: open a goal by starting/resuming a ggcoder session with this as cwd. */
  path: z.string(),
  createdAt: z.string(),
  lastActiveMs: z.number(),
  /** The newest coordinator conversation, to resume; absent opens a fresh one. */
  agentSessionId: z.string().optional(),
  status: GoalStatus,
  /** Daemon session id currently open on this goal, when one is. */
  sessionId: z.string().optional(),
  /** Standing instructions for the goal's workers. Absent = none (or an older GG Coder). */
  instructions: z.string().optional(),
});

/** App -> daemon. List the goals on this machine. */
export const GoalsRequest = z.object({
  t: z.literal("goals"),
  requestId: z.string(),
});

/** Daemon -> app. Answer to `goals`; also broadcast unprompted after any change. */
export const Goals = z.object({
  t: z.literal("goals"),
  /** Echoed when this answers a request; absent on a broadcast. */
  requestId: z.string().optional(),
  goals: z.array(GoalSummary),
  /** Why there are none to show: GG Coder missing, too old, or failed. Absent on success. */
  error: z.string().optional(),
});

/** App -> daemon. Create a goal (briefing phase). Context paths are desktop paths. */
export const GoalCreate = z.object({
  t: z.literal("goal.create"),
  requestId: z.string(),
  name: z.string(),
  goal: z.string(),
  context: z.array(z.string()).default([]),
  instructions: z.string().optional(),
  /**
   * Files picked on the *phone* (the desktop's disk is no place to hunt for a
   * file from a phone). The daemon writes them to pew2's own folder on the
   * computer, where they live as long as the goal, and adds their paths to
   * `context`. Same ceilings as a prompt's attachments. Absent = none; an
   * older daemon drops the field, which is why `GoalResult.files` exists.
   */
  files: z.array(PromptAttachment).optional(),
});

/**
 * App -> daemon. Act on one goal.
 *  - `delete`: remove it (refused while a session on it is working).
 *  - `pause`: stop its run and its workers; it stays paused until resumed.
 *  - `resume`: lift a pause and carry on if it was cut off.
 *  - `update`: change attached context / standing instructions (refused mid-run).
 *  - `critterModel`: pin the workers' model (`model: null` follows GG Goals).
 * Opening a goal is not here: it is `session.start` / `session.resume` on the
 * `ggcoder` provider with `cwd` = the goal's `path`, after which the daemon
 * runs GG Goals' kickoff turn by itself when the goal still needs one.
 */
export const GoalAction = z.object({
  t: z.literal("goal.action"),
  requestId: z.string(),
  goalId: z.string(),
  action: z.enum(["delete", "pause", "resume", "update", "critterModel"]),
  context: z.array(z.string()).optional(),
  instructions: z.string().optional(),
  model: z.string().nullable().optional(),
});

/** Daemon -> app. Result of `goal.create` / `goal.action`. */
export const GoalResult = z.object({
  t: z.literal("goal.result"),
  requestId: z.string(),
  ok: z.boolean(),
  goal: GoalSummary.optional(),
  error: z.string().optional(),
  /**
   * How many phone files were saved for a `goal.create`. Absent from a daemon
   * that predates `GoalCreate.files`: the app then knows its files were not
   * received rather than assuming they were.
   */
  files: z.number().int().nonnegative().optional(),
});

/** One of GG Goals' workers ("critters"), as the goal's farm shows it. */
export const GoalWorker = z.object({
  id: z.string(),
  /** The task name GG Goals gave it. */
  name: z.string(),
  /** builder | scout | researcher | checker, when known. */
  agent: z.string().optional(),
  state: z.enum(["starting", "running", "completed", "failed", "interrupted", "closed"]),
  /** What it is doing right now, one line. */
  activity: z.string().optional(),
  startedAt: z.number().optional(),
  elapsedMs: z.number().optional(),
  toolUses: z.number().int().nonnegative().optional(),
  model: z.string().optional(),
  error: z.string().optional(),
});

/**
 * Daemon -> app. Live state of the goal a session coordinates: phase and the
 * worker roster. Broadcast on change (full state each time), carried in a
 * catch-up `Replay.goal`, never logged. Ken's spoken line is NOT here: it is
 * the last line of GG Goals' message text (`[ken:face] words`), which the app
 * strips from the bubble and shows as Ken.
 */
export const GoalState = z.object({
  t: z.literal("goal.state"),
  sessionId: z.string(),
  goalId: z.string(),
  phase: z.enum(["briefing", "active"]),
  paused: z.boolean(),
  workers: z.array(GoalWorker),
  critterModel: z.string().nullable().optional(),
});

// ── Plan review (GG Coder) ─────────────────────────────────

/**
 * Daemon -> app. A session's plan state (from `_gg/plan_state`): broadcast on
 * change, carried in a catch-up `Replay.plan`, never logged.
 *
 * `pending` is present only while a submitted plan is waiting for the HUMAN
 * (GG Coder already let Autopilot Ken try, and everything has settled). That is
 * the moment the app opens the Accept / Feedback / Reject sheet. Progress of an
 * approved plan travels as the standard ACP `plan` session update, not here.
 */
export const PlanState = z.object({
  t: z.literal("plan.state"),
  sessionId: z.string(),
  /** The agent is in read-only plan mode, drafting. */
  planMode: z.boolean(),
  pending: z
    .object({
      planPath: z.string(),
      /** The plan's markdown. */
      content: z.string(),
      /** Echo this back in `plan.decide`, so a stale sheet cannot decide a newer plan. */
      generation: z.number().int(),
    })
    .nullable(),
});

/**
 * App -> daemon. Decide a pending plan.
 *  - `accept`: implement it. GG Coder starts a fresh context with the plan
 *    baked in (same daemon session; the transcript gets a divider). Logged as
 *    `{ kind: "plan_accepted", planTotal?, agentSessionId? }`; `agentSessionId`
 *    is the implementation's on-disk session, which resume must reopen
 *    (absent from older daemons).
 *  - `feedback`: revise it read-only with `feedback`, then submit again.
 *  - `reject`: drop it; the agent leaves plan mode and waits.
 * Logged as `{ kind: "plan_decision", action, feedback? }`.
 */
export const PlanDecide = z.object({
  t: z.literal("plan.decide"),
  sessionId: z.string(),
  generation: z.number().int(),
  action: z.enum(["accept", "feedback", "reject"]),
  feedback: z.string().optional(),
});

// ── Autopilot (GG Coder) ───────────────────────────────────

/**
 * Daemon -> app. Whether Autopilot (Ken reviewing every finished turn and
 * prompting GG Coder until the work is done) is on for this session's project,
 * and whether Ken is reviewing right now. Broadcast on change, catch-up
 * `Replay.autopilot`, never logged. Ken's verdicts themselves ARE logged, as
 * session events `{ kind: "autopilot", phase, reason?, body?, round? }` with
 * phase one of: review_start | prompted | done | human | capped | ignored |
 * plan_accepted | error.
 */
export const AutopilotState = z.object({
  t: z.literal("autopilot.state"),
  sessionId: z.string(),
  enabled: z.boolean(),
  reviewing: z.boolean(),
});

/** App -> daemon. Turn Autopilot on or off for this session's project. */
export const AutopilotSet = z.object({
  t: z.literal("autopilot.set"),
  sessionId: z.string(),
  enabled: z.boolean(),
});

// ── Project checklist (GG Coder) ───────────────────────────

export const ChecklistItemRow = z.object({
  id: z.string(),
  /** Section heading, e.g. "Foundations". */
  group: z.string(),
  title: z.string(),
  description: z.string(),
  status: z.enum(["not-run", "not-applicable", "due", "passed", "needs-work"]),
  checkedAt: z.string().nullable(),
  result: z.enum(["pass", "issues", "not-applicable"]).nullable(),
  summary: z.string().nullable(),
  findings: z.array(z.string()),
  evidence: z.array(z.string()),
  /** The project's code changed after this result was recorded. */
  changedSinceCheck: z.boolean(),
  /** What GG Coder detected about this project for the item, when anything. */
  detection: z.object({ summary: z.string(), facts: z.array(z.string()) }).nullable(),
  /** Send this as an ordinary prompt to run the check; null when it can't be run. */
  runPrompt: z.string().nullable(),
});

/** App -> daemon. Read the project checklist for an open GG Coder session. */
export const ChecklistRequest = z.object({
  t: z.literal("checklist"),
  requestId: z.string(),
  sessionId: z.string(),
});

/**
 * Daemon -> app. Answer to `checklist` (with `requestId`), or a nudge with no
 * items when a turn changed the checklist (`changed: true`, the app re-asks).
 */
export const Checklist = z.object({
  t: z.literal("checklist"),
  requestId: z.string().optional(),
  sessionId: z.string(),
  changed: z.boolean().optional(),
  staleAfterDays: z.number().optional(),
  items: z.array(ChecklistItemRow).optional(),
  error: z.string().optional(),
});

// ── Project tasks (GG Coder) ───────────────────────────────

export const TaskRow = z.object({
  id: z.string(),
  title: z.string(),
  prompt: z.string(),
  status: z.enum(["pending", "in-progress", "done"]),
  /** What running the task sends the agent; null unless it is still to do. */
  runPrompt: z.string().nullable(),
});

/** App -> daemon. Read the task list of an open GG Coder session's project. */
export const TasksRequest = z.object({
  t: z.literal("tasks"),
  requestId: z.string(),
  sessionId: z.string(),
});

/**
 * App -> daemon. Run a task in this conversation: the agent's context is reset,
 * the task marked in progress, and its prompt sent, as GG Coder's runner does.
 *
 * The reset is logged as a session event `{ kind: "context_reset", reason:
 * "task", title, agentSessionId }`, before the task file is marked in progress,
 * so every client shows the fresh context even if marking it fails. It means
 * the agent remembers nothing before it: clients restart the transcript from a
 * "Task: <title>" note and move the chat's row to `agentSessionId`, the new
 * on-disk session that resume must reopen.
 */
export const TaskStart = z.object({
  t: z.literal("task.start"),
  requestId: z.string(),
  sessionId: z.string(),
  taskId: z.string(),
});

/** Daemon -> app. Answer to `tasks`, and to `task.start` (the list with it in progress, or why not). */
export const Tasks = z.object({
  t: z.literal("tasks"),
  requestId: z.string().optional(),
  sessionId: z.string(),
  items: z.array(TaskRow).optional(),
  error: z.string().optional(),
});

/**
 * Which GG Coder extensions this provider speaks, from its ACP
 * `agentCapabilities._meta.gg`. Carried on `ProviderCapabilities.extensions`;
 * absent = an older daemon or an agent with none, so show none of these UIs.
 */
export const ProviderExtensions = z.object({
  queue: z.boolean().optional(),
  askUser: z.boolean().optional(),
  goals: z.boolean().optional(),
  planReview: z.boolean().optional(),
  autopilot: z.boolean().optional(),
  checklist: z.boolean().optional(),
  /** The project task list; read by the daemon, so set whenever `_meta.gg` is present. */
  tasks: z.boolean().optional(),
});

export const ErrorMessage = z.object({
  t: z.literal("error"),
  code: z.string(),
  message: z.string(),
  sessionId: z.string().optional(),
});

/**
 * A sealed message. Everything with user content travels as one of these.
 *
 * `sid` and `seq` are cleartext headers bound into the AEAD as associated data,
 * so changing either invalidates the frame. The relay neither stores nor replays
 * session events. The daemon owns the ordered session log and answers a
 * reconnecting phone's cursors itself.
 *
 * The definitive shape lives in `crypto.ts`, which is what actually seals and
 * opens these; this mirror exists so a message can be validated on arrival
 * alongside every other frame.
 */
export const Envelope = z.object({
  t: z.literal("e"),
  sid: z.string().optional(),
  seq: z.number().int().nonnegative().optional(),
  /** Monotonic per connection per sender. Replay protection within a session. */
  ctr: z.number().int().nonnegative(),
  /** base64url nonce. */
  n: z.string(),
  /** base64url ciphertext, including the Poly1305 tag. */
  ct: z.string(),
});

export const ClientMessage = z.discriminatedUnion("t", [
  Hello,
  Envelope,
  ProviderCapabilitiesRequest,
  ProviderSessionsRequest,
  SetProviderConfig,
  SetSessionConfig,
  StartSession,
  ResumeSession,
  Prompt,
  Cancel,
  PermissionReply,
  ImageRequest,
  WorkspaceRequest,
  WorkspacesRequest,
  PushRegister,
  QueueCancel,
  AskReply,
  GoalsRequest,
  GoalCreate,
  GoalAction,
  PlanDecide,
  AutopilotSet,
  ChecklistRequest,
  TasksRequest,
  TaskStart,
  VoiceStatusRequest,
  VoiceLogin,
  VoiceSessionRequest,
  VoiceTool,
  VoiceEnd,
  VoicePrefs,
  VoiceArm,
  VoipRegister,
  VoiceForget,
  AppDiag,
]);

export const ServerMessage = z.discriminatedUnion("t", [
  Ready,
  Envelope,
  ProviderAnnounce,
  ProviderCapabilities,
  ProviderConfig,
  ProviderSessions,
  SessionEvent,
  SessionIdle,
  Replay,
  ImageData,
  Workspace,
  Workspaces,
  DeviceJoined,
  SessionQueue,
  Goals,
  GoalResult,
  GoalState,
  PlanState,
  AutopilotState,
  Checklist,
  Tasks,
  VoiceStatus,
  VoiceInbox,
  VoiceBoard,
  VoiceNote,
  VoiceSession,
  VoiceToolResult,
  ErrorMessage,
]);

export type QueuedMessage = z.output<typeof QueuedMessage>;
export type SessionQueue = z.output<typeof SessionQueue>;
export type QueueCancel = z.output<typeof QueueCancel>;
export type AskOption = z.output<typeof AskOption>;
export type AskQuestion = z.output<typeof AskQuestion>;
export type AskRequest = z.output<typeof AskRequest>;
export type AskResult = z.output<typeof AskResult>;
export type AskReply = z.output<typeof AskReply>;
export type VoiceSource = z.output<typeof VoiceSource>;
export type VoiceLoginPending = z.output<typeof VoiceLoginPending>;
export type VoiceStatus = z.output<typeof VoiceStatus>;
export type VoiceStatusRequest = z.output<typeof VoiceStatusRequest>;
export type VoiceLogin = z.output<typeof VoiceLogin>;
export type VoiceInboxItem = z.output<typeof VoiceInboxItem>;
export type VoiceInbox = z.output<typeof VoiceInbox>;
export type VoiceBoardLine = z.output<typeof VoiceBoardLine>;
export type VoiceBoardSession = z.output<typeof VoiceBoardSession>;
export type VoiceBoard = z.output<typeof VoiceBoard>;
export type VoiceSessionRequest = z.output<typeof VoiceSessionRequest>;
export type VoiceSession = z.output<typeof VoiceSession>;
export type VoiceTool = z.output<typeof VoiceTool>;
export type VoiceToolResult = z.output<typeof VoiceToolResult>;
export type VoiceEnd = z.output<typeof VoiceEnd>;
export type VoicePrefsValues = z.output<typeof VoicePrefsValues>;
export type VoicePrefs = z.output<typeof VoicePrefs>;
export type VoiceForget = z.output<typeof VoiceForget>;
export type VoiceArm = z.output<typeof VoiceArm>;
export type VoipRegister = z.output<typeof VoipRegister>;
export type AppDiag = z.output<typeof AppDiag>;
export type VoiceNote = z.output<typeof VoiceNote>;
export type VoiceArmed = z.output<typeof VoiceArmed>;
export type VoiceQuietHours = z.output<typeof VoiceQuietHours>;
export type GoalStatus = z.output<typeof GoalStatus>;
export type GoalContextItem = z.output<typeof GoalContextItem>;
export type GoalSummary = z.output<typeof GoalSummary>;
export type GoalsRequest = z.output<typeof GoalsRequest>;
export type Goals = z.output<typeof Goals>;
export type GoalCreate = z.output<typeof GoalCreate>;
export type GoalAction = z.output<typeof GoalAction>;
export type GoalResult = z.output<typeof GoalResult>;
export type GoalWorker = z.output<typeof GoalWorker>;
export type GoalState = z.output<typeof GoalState>;

export type SetProviderConfig = z.output<typeof SetProviderConfig>;
export type SetSessionConfig = z.output<typeof SetSessionConfig>;
export type Hello = z.output<typeof Hello>;
export type Envelope = z.output<typeof Envelope>;
export type ProviderAnnounce = z.output<typeof ProviderAnnounce>;
export type ConfigOption = z.output<typeof ConfigOption>;
export type AgentSession = z.output<typeof AgentSession>;
export type ResumeSession = z.output<typeof ResumeSession>;
export type ProviderCapabilitiesRequest = z.output<typeof ProviderCapabilitiesRequest>;
export type ProviderCapabilities = z.output<typeof ProviderCapabilities>;
export type ProviderConfig = z.output<typeof ProviderConfig>;
export type AgentProject = z.output<typeof AgentProject>;
export type ProviderSessionsRequest = z.output<typeof ProviderSessionsRequest>;
export type ProviderSessions = z.output<typeof ProviderSessions>;
export type StartSession = z.output<typeof StartSession>;
export type PromptAttachment = z.output<typeof PromptAttachment>;
export type Prompt = z.output<typeof Prompt>;
export type Cancel = z.output<typeof Cancel>;
export type PermissionReply = z.output<typeof PermissionReply>;
export type ImageRequest = z.output<typeof ImageRequest>;
export type ImageData = z.output<typeof ImageData>;
export type WorkspaceRequest = z.output<typeof WorkspaceRequest>;
export type Workspace = z.output<typeof Workspace>;
export type SessionEvent = z.output<typeof SessionEvent>;
export type Replay = z.output<typeof Replay>;
export type SessionIdle = z.output<typeof SessionIdle>;
export type PushRegister = z.output<typeof PushRegister>;
export type DeviceJoined = z.output<typeof DeviceJoined>;
export type WorkspaceEntry = z.output<typeof WorkspaceEntry>;
export type Workspaces = z.output<typeof Workspaces>;
export type ClientMessage = z.output<typeof ClientMessage>;
export type ServerMessage = z.output<typeof ServerMessage>;
export type PlanState = z.output<typeof PlanState>;
export type PlanDecide = z.output<typeof PlanDecide>;
export type AutopilotState = z.output<typeof AutopilotState>;
export type AutopilotSet = z.output<typeof AutopilotSet>;
export type ChecklistItemRow = z.output<typeof ChecklistItemRow>;
export type ChecklistRequest = z.output<typeof ChecklistRequest>;
export type Checklist = z.output<typeof Checklist>;
export type TaskRow = z.output<typeof TaskRow>;
export type TasksRequest = z.output<typeof TasksRequest>;
export type TaskStart = z.output<typeof TaskStart>;
export type Tasks = z.output<typeof Tasks>;
export type ProviderExtensions = z.output<typeof ProviderExtensions>;
