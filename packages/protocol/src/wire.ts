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

/** App -> daemon. Send a prompt into an existing session. */
export const Prompt = z.object({
  t: z.literal("session.prompt"),
  sessionId: z.string(),
  text: z.string(),
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
]);

export const ServerMessage = z.discriminatedUnion("t", [
  Ready,
  ProviderAnnounce,
  ProviderCapabilities,
  SessionEvent,
  Replay,
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
export type Prompt = z.output<typeof Prompt>;
export type Cancel = z.output<typeof Cancel>;
export type PermissionReply = z.output<typeof PermissionReply>;
export type SessionEvent = z.output<typeof SessionEvent>;
export type ClientMessage = z.output<typeof ClientMessage>;
export type ServerMessage = z.output<typeof ServerMessage>;
