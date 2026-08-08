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
});

export const WorkspaceEntry = z.object({
  path: z.string(),
  name: z.string(),
  repo: z.boolean(),
  updatedAt: z.string().optional(),
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
   * Optional because the app does not send one: it adopts the next session for
   * the provider it is showing. Required here, this schema would reject every
   * real `session.start` the moment the daemon began validating against it.
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

export const ErrorMessage = z.object({
  t: z.literal("error"),
  code: z.string(),
  message: z.string(),
  sessionId: z.string().optional(),
});

/**
 * A sealed message. Everything with user content travels as one of these.
 *
 * `sid` and `seq` are readable on purpose, and only because the relay keeps the
 * ordered log that lets a reconnecting phone catch up — the daemon does not
 * replay. They are bound into the AEAD as associated data, so the relay may
 * *read* them to order its log but cannot alter them without every recipient
 * rejecting the frame.
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
]);

export const ServerMessage = z.discriminatedUnion("t", [
  Ready,
  Envelope,
  ProviderAnnounce,
  ProviderCapabilities,
  ProviderSessions,
  SessionEvent,
  SessionIdle,
  Replay,
  ImageData,
  Workspace,
  Workspaces,
  DeviceJoined,
  ErrorMessage,
]);

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
export type SessionIdle = z.output<typeof SessionIdle>;
export type PushRegister = z.output<typeof PushRegister>;
export type DeviceJoined = z.output<typeof DeviceJoined>;
export type WorkspaceEntry = z.output<typeof WorkspaceEntry>;
export type Workspaces = z.output<typeof Workspaces>;
export type ClientMessage = z.output<typeof ClientMessage>;
export type ServerMessage = z.output<typeof ServerMessage>;
