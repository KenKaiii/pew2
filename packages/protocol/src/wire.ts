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
});

export const ErrorMessage = z.object({
  t: z.literal("error"),
  code: z.string(),
  message: z.string(),
  sessionId: z.string().optional(),
});

export const ClientMessage = z.discriminatedUnion("t", [
  Hello,
  StartSession,
  Prompt,
  Cancel,
  PermissionReply,
]);

export const ServerMessage = z.discriminatedUnion("t", [
  Ready,
  ProviderAnnounce,
  SessionEvent,
  Replay,
  ErrorMessage,
]);

export type Hello = z.output<typeof Hello>;
export type ProviderAnnounce = z.output<typeof ProviderAnnounce>;
export type StartSession = z.output<typeof StartSession>;
export type Prompt = z.output<typeof Prompt>;
export type Cancel = z.output<typeof Cancel>;
export type PermissionReply = z.output<typeof PermissionReply>;
export type SessionEvent = z.output<typeof SessionEvent>;
export type ClientMessage = z.output<typeof ClientMessage>;
export type ServerMessage = z.output<typeof ServerMessage>;
