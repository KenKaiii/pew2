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

/** Bump only on breaking envelope changes. */
export const WIRE_VERSION = 1;

export const Role = z.enum(["daemon", "app"]);
export type Role = z.output<typeof Role>;

/** Sent by both sides immediately after the socket opens. */
export const Hello = z.object({
  t: z.literal("hello"),
  wire: z.literal(WIRE_VERSION),
  role: Role,
  deviceId: z.string().min(1),
  /** Highest seq the client already has, per session. Enables gap-free resume. */
  cursors: z.record(z.string(), z.number().int().nonnegative()).default({}),
});

/** Relay -> both sides, after `hello`. */
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

/** App -> daemon. Start a new session with a provider. */
export const StartSession = z.object({
  t: z.literal("session.start"),
  requestId: z.string(),
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
   * where the daemon would open one. No path is accepted from the client — the
   * daemon resolves the directory itself.
   */
  providerId: z.string().optional(),
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

export const ErrorMessage = z.object({
  t: z.literal("error"),
  code: z.string(),
  message: z.string(),
  sessionId: z.string().optional(),
});

export const ClientMessage = z.discriminatedUnion("t", [
  Hello,
  ProviderCapabilitiesRequest,
  SetProviderConfig,
  StartSession,
  ResumeSession,
  Prompt,
  Cancel,
  PermissionReply,
  ImageRequest,
  WorkspaceRequest,
]);

export const ServerMessage = z.discriminatedUnion("t", [
  Ready,
  ProviderAnnounce,
  ProviderCapabilities,
  SessionEvent,
  SessionIdle,
  Replay,
  ImageData,
  Workspace,
  ErrorMessage,
]);

export type SetProviderConfig = z.output<typeof SetProviderConfig>;
export type Hello = z.output<typeof Hello>;
export type ProviderAnnounce = z.output<typeof ProviderAnnounce>;
export type ConfigOption = z.output<typeof ConfigOption>;
export type AgentSession = z.output<typeof AgentSession>;
export type ResumeSession = z.output<typeof ResumeSession>;
export type ProviderCapabilitiesRequest = z.output<typeof ProviderCapabilitiesRequest>;
export type ProviderCapabilities = z.output<typeof ProviderCapabilities>;
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
export type ClientMessage = z.output<typeof ClientMessage>;
export type ServerMessage = z.output<typeof ServerMessage>;
