/**
 * Daemon connection: one WebSocket, auto-reconnecting, translating the wire
 * envelope into rendered chat turns.
 *
 * ACP streams text as many small chunks, so consecutive agent chunks are
 * coalesced into a single message. Without this the list would grow by one row
 * per word and scrolling would fight the user.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SecureChannel, e2e, envelopeHeader, wire } from "@pew2/protocol";

const { WIRE_VERSION } = wire;
import { USE_FIXTURES, isFixtureSession, sampleSessions } from "./fixtures";
import { mergeAgentSessions, needsResume, replaceAgentSessionStub } from "./agentHistory";
import { receiptOnOpen, receiptOnReplay, recordReceipt } from "./turnReceipts";
import {
  adoptPendingSession,
  dropPendingSessions,
  isPendingSession,
  pendingSession,
  pendingSessionKey,
} from "./pendingSession";
import {
  enqueue,
  markSent,
  partitionOutbox,
  pendingStartFor,
  queuedPendingSessions,
  remapSession,
  type OutboxEntry,
} from "./outbox";
import { rememberConfigs, visibleConfigs, withChoice } from "./configTruth";
import {
  beginActivity,
  foldActivity,
  isTimingTurn,
  summariseActivity,
  IDLE_ACTIVITY,
  type Activity,
  type TurnReceipt,
} from "./activity";
import { advance, alreadySeen, type Cursors } from "./cursors";
import { findDuplicateError } from "./errorDedup";
import { isEmptyChunk, readChunk } from "./chunks";
import type { ChatImage } from "./images";
import { emptyImageCache, putImage, type ImageCache } from "./imageCache";
import {
  attachmentImages,
  toWireAttachments,
  type PendingAttachment,
} from "./attachments";
import { defaultProviderId } from "./lastProvider";
import {
  loadCachedProviders,
  loadLastProvider,
  saveCachedProviders,
  saveLastProvider,
} from "./preferences";
import {
  offeredCommands,
  readAvailableCommands,
  type SlashCommand,
} from "./slashCommands";
import type { WireProject } from "./projects";
import { readUsage, type ContextUsage } from "./contextUsage";
import {
  applyChunk,
  capTurns,
  foldBackgroundCatchUp,
  foldBackgroundEvent,
  foldCatchUp,
  foldSessionEvents,
  isOptimistic,
  type ReplayEvent,
} from "./replayFold";
import { readPermissionRequest } from "./permissions";

export type Status = "connecting" | "online" | "offline";

export interface Provider {
  id: string;
  name: string;
  description: string;
  available: boolean;
  unavailableReason?: string;
  color?: string;
}

/**
 * A desktop-local image being brought to the phone.
 *
 * `error` is a first-class state, not a silent failure: the whole point of this
 * path is that a missing picture explains itself instead of leaving a blank.
 */
export type ImageEntry =
  | { status: "loading" }
  | { status: "ready"; dataUri: string; mimeType?: string }
  | { status: "error"; message: string };

export interface PermissionRequest {
  requestId: string;
  title: string;
  options: { optionId: string; name: string }[];
}

export interface Turn {
  id: string;
  /**
   * Stable React identity, fixed for the life of the message.
   *
   * `id` is not that: an optimistic prompt adopts the server's id once the
   * daemon echoes it back, and the thread is a recycling list keyed by this,
   * so a changing key tears the cell down and re-parses its markdown — the
   * prompt visibly rendering a second time a moment after you sent it. Absent
   * on turns born with a server id, which never changes.
   */
  key?: string;
  role: "user" | "agent" | "thought" | "system";
  text: string;
  /**
   * Pictures the agent sent with this message, in order. Kept beside the text
   * rather than spliced into it: the bytes may be inline base64 (megabytes of
   * it) and markdown is re-parsed on every streamed chunk.
   */
  images?: ChatImage[];
  /**
   * Typed with no way to send it, and waiting in the outbox for a socket.
   *
   * Rendered as the message it is, with a mark saying it has not left the
   * phone — not as a failure, because it has not failed: the reconnect sends
   * it. Cleared the moment it goes out, and again by the daemon's echo, so a
   * bubble can never keep the label after the agent has the message.
   */
  queued?: boolean;
}

/**
 * A session-level selector advertised by the connected agent: model, thinking
 * level, or mode. pew2 hardcodes no model names — each app reports its own.
 * https://agentclientprotocol.com/protocol/v1/session-config-options
 */
export interface ConfigOption {
  id: string;
  name: string;
  category?: string;
  type: string;
  currentValue: string | boolean;
  options?: { value: string; name: string; description?: string }[];
}

/** A past conversation, grouped by the agent that ran it. */
export interface Session {
  id: string;
  providerId: string;
  /** First user message, used as the list title. */
  title: string;
  startedAt: number;
  turns: Turn[];
  /** Message rows available before this transcript is opened. */
  messageCount?: number;
  /** The selectors this session was running with, restored when reopened. */
  configOptions: ConfigOption[];
  /**
   * The agent's own id for this conversation, when it came from the agent's
   * history rather than this app. Present means it has not been opened yet:
   * its turns live on the agent's disk and arrive on resume.
   */
  agentSessionId?: string;
  /** Working directory the agent recorded, needed to reopen it there. */
  cwd?: string;
  /**
   * Project name for the drawer, as the daemon stamped it on a finished turn.
   * Only the desktop can resolve it, and a session this app started has no
   * `cwd` of its own to derive it from.
   */
  folder?: string;
  /**
   * The agent is mid-turn in this conversation, whether or not it is on
   * screen.
   *
   * Per session rather than the single `busy` flag because the daemon keeps
   * every session running while the phone looks at one of them: leaving a
   * conversation does not stop its agent, so the drawer has to be able to say
   * which ones are still working.
   */
  busy?: boolean;
  /**
   * What this conversation's last finished turn did, e.g. "Answered in 3s".
   *
   * Kept per session because it is a fact about the turn, not about the screen.
   * It used to live only in the screen state, so it appeared as the turn ended
   * and was gone the moment the user looked at another conversation and came
   * back — the line was there while you watched it happen and never again.
   * Reopening now restores the same summary the turn produced.
   */
  receipt?: TurnReceipt;
  /**
   * A turn finished here while the user was somewhere else. Cleared when the
   * conversation is opened, so the drawer marks what is worth going back to.
   */
  unread?: boolean;
  /**
   * The approval this conversation's agent is stopped on, if any.
   *
   * Per session for the same reason as `busy`: the agent that needs an answer
   * is often not the one on screen, and it will wait for ever — there is no
   * timeout at either end of ACP. Held here, it survives switching away, and
   * survives losing the socket, since the daemon re-states every open request
   * on reconnect. Cleared when it is answered, or when the turn it belonged to
   * ends without it.
   */
  permission?: PermissionRequest;
}



/**
 * The project the open session is working in, as the daemon sees it.
 *
 * Only the desktop can answer this, and it goes stale the moment the agent
 * edits a file, so it is re-asked rather than remembered across sessions.
 */
export interface Workspace {
  cwd: string;
  folder: string;
  repo: boolean;
  uncommitted: number;
}

/** A directory offered by the picker: a suggested repo, or a browsed folder. */
export interface WorkspaceEntry {
  path: string;
  name: string;
  repo: boolean;
  updatedAt?: string;
}

/**
 * The state of browsing for somewhere to work.
 *
 * Held here rather than inside the sheet so an in-flight answer survives the
 * sheet unmounting, and so a reply for a directory the user has already
 * navigated away from can be dropped by comparing `requestId`.
 */
export interface WorkspaceBrowse {
  /** The directory being shown. Absent while showing suggested repositories. */
  path?: string;
  /** Where "up" leads, absent at the top of what may be browsed. */
  parent?: string;
  entries: WorkspaceEntry[];
  loading: boolean;
  /** The daemon would not open that path: missing, a file, or out of bounds. */
  refused: boolean;
}

/**
 * Failed connection attempts before the app stops saying "connecting".
 *
 * With the capped exponential backoff below, four attempts is about fifteen
 * seconds — past a network switch or a daemon restart, and well short of the
 * forever that a rotated pairing used to spend pretending to connect.
 */
const STALLED_ATTEMPTS = 4;

/**
 * How long a conversation may sit as a skeleton before the app admits it is
 * not coming.
 *
 * Generous on purpose. A resumed transcript reveals on its *first* batch rather
 * than its last, so even a thousand-event conversation clears this in the time
 * the agent takes to attach — which means anything still waiting at twenty
 * seconds is not slow, it is lost. Erring the other way is worse than it
 * sounds: cutting a live resume short would replace a transcript that was about
 * to appear with a message saying it failed.
 */
const LOADING_SESSION_TIMEOUT = 20_000;

/**
 * How long a socket may stay in CONNECTING before it is treated as dead.
 *
 * Ten seconds is well past any real handshake, including a relay cold start,
 * and well short of the operating system's own connect timeout — which is the
 * point. The platform does eventually give up; it just does so on a timescale
 * where the user has already decided the app is broken.
 */
const CONNECT_TIMEOUT = 10_000;

/**
 * `WebSocket.CONNECTING`, by value.
 *
 * React Native's WebSocket is not the DOM one, and the static constants are
 * absent on some engines while the instance `readyState` is always the same
 * standard number. Comparing against the literal is the portable form, and the
 * name is what keeps it readable.
 */
const WEBSOCKET_CONNECTING = 0;

interface State {
  status: Status;
  /**
   * A refusal the daemon explained, which reconnecting cannot fix.
   *
   * A wrong protocol version or a rotated key both produce a socket that opens
   * and is then closed. Without somewhere to put the reason, the app would sit
   * in an endless reconnect loop showing "Connecting..." — which is the same
   * thing it shows when the desktop is simply asleep, and tells the one user who
   * needs to act nothing at all.
   */
  fatal?: string;
  /**
   * Set once reconnecting has failed enough times to stop being a blip.
   *
   * Distinct from `fatal`, and deliberately weaker. The refusals that produce a
   * dead pairing happen *below* the WebSocket — the daemon answers 401, the
   * relay answers 409 for a room with no machine in it — so no frame ever
   * arrives to explain them, and the app cannot tell a rotated token from a
   * laptop that is merely asleep. Both must keep retrying, because one of them
   * comes back on its own.
   *
   * What must not continue is the claim that a connection is in progress.
   * "Connecting to your machine..." held forever is the state that sent someone
   * to a stuck screen with nothing to act on.
   */
  unreachable?: boolean;
  providers: Provider[];
  sessionId?: string;
  /** The agent the composer will talk to. Chosen before a session exists. */
  activeProviderId?: string;
  turns: Turn[];
  /** Every conversation this client has seen, newest first. */
  sessions: Session[];
  /** Selectors for the open session, in the agent's own priority order. */
  configOptions: ConfigOption[];
  /**
   * Slash commands the agent offers, minus the ones this app hides. Depends on
   * the project it opened, so it is per session rather than per provider.
   */
  commands: SlashCommand[];
  permission?: PermissionRequest;
  busy: boolean;
  /**
   * Tool calls in the open session's current turn, folded live.
   *
   * Only the open session: this drives one line under the transcript, and a
   * background agent's tools are not what the reader is watching. It resets
   * with every prompt, so it is never a log — it is the present tense.
   */
  activity: Activity;
  /**
   * What the last turn did, shown once it is over and cleared when the next
   * one starts. Absent for a turn this client did not time itself.
   */
  receipt?: TurnReceipt;
  /**
   * At least one agent has been asked what it holds and has not answered yet.
   * The drawer shows skeleton rows instead of a false "No conversations yet".
   */
  loadingSessions: boolean;
  /** A stored transcript is loading and is not ready to reveal yet. */
  loadingSession: boolean;
  /** Project and git state for the session on screen. Absent until asked. */
  workspace?: Workspace;
  /**
   * Browsing the desktop for a project to start in.
   *
   * Absent until the user opens the picker. This is the only way into an agent
   * with no history: its project list is folded from its own past sessions, so
   * a freshly installed one has nothing to offer.
   */
  browse?: WorkspaceBrowse;
  /**
   * How full the agent's context window is, for the session on screen.
   *
   * Absent until the agent volunteers one, and it stays absent for agents that
   * never do (GG Coder sends none today) — which is why the row omits the
   * reading entirely rather than showing a confident 0%.
   */
  usage?: ContextUsage;
  /**
   * Bumped whenever the answer is stale for a reason the request itself cannot
   * see.
   *
   * The workspace request is driven by session, provider and chosen project, so
   * it re-asks when one of those changes. Leaving a conversation changes none of
   * them: from the empty screen, with a project already picked, "new chat"
   * clears the workspace and every dependency stays equal — so nothing re-asked
   * and the project row simply vanished until a prompt created a session. This
   * is the explicit "ask again" the effect otherwise has no way to hear.
   */
  workspaceNonce: number;
  /**
   * Every project each agent has worked in, keyed by provider id.
   *
   * Folded by the daemon from the agent's whole history, not from `sessions`:
   * that list is capped at the newest conversations and so describes a week's
   * work rather than the set of projects a user can return to.
   */
  projects: Record<string, WireProject[]>;
  /**
   * The project the drawer is narrowed to, per agent. Absent means all of
   * them, which is where every agent starts.
   *
   * Per agent rather than one global choice: the projects belong to an agent,
   * so switching apps and back must not carry a path the new agent has never
   * opened — and must not silently forget the one you just picked either.
   */
  projectPath: Record<string, string>;
  /**
   * `providerId:cwd` of the project whose conversations are being fetched.
   *
   * In state rather than a ref because it decides between the skeleton and
   * "No conversations in pew2 yet" — a ref would be read during a render
   * nothing schedules, so the false empty state would show until the reply
   * landed, which is the flash this exists to prevent.
   */
  loadingProject?: string;
}

/**
 * A user turn rendered before the daemon has echoed it back. Its id is replaced
 * with the server's once the echo arrives, so it never renders twice.
 */
function localTurn(
  seq: number,
  text: string,
  images?: ChatImage[],
  queued?: boolean,
): Turn {
  // `key` outlives the id swap in the echo path, so the cell rendering this
  // prompt survives reconciliation instead of remounting.
  return {
    id: `local:${seq}`,
    key: `local:${seq}`,
    role: "user",
    text: text.trim(),
    // Rendered from the phone's own copy, so an attached photo appears the
    // instant it is sent rather than after a round trip to fetch back the file
    // this device just uploaded.
    ...(images?.length ? { images } : {}),
    // Only when it is true: an ordinary send must not carry a false flag into
    // every turn comparison in the thread.
    ...(queued ? { queued: true as const } : {}),
  };
}

/**
 * Marks a first prompt that was stopped while its agent was still starting, so
 * it never reached the daemon. Carries a `local:` id like the prompt above it:
 * `session.started` keeps only locally-created turns, and this one belongs with
 * the message it explains.
 */
function stoppedBeforeSend(seq: number): Turn {
  return {
    id: `local:${seq}`,
    key: `local:${seq}`,
    role: "system",
    text: "Stopped before the agent received this.",
  };
}

/**
 * Marks a conversation that was asked for and never arrived.
 *
 * Reopening a session is two messages far apart: `session.resume` goes out, and
 * the transcript follows once the agent has attached. Between them the screen
 * is a skeleton with no composer and no controls. Nothing ever timed that out,
 * so a resume whose answer was lost — the socket dropped, the agent failed to
 * spawn, the daemon was killed mid-handshake — left the phone showing a
 * loading conversation for as long as the app stayed open, with force-quitting
 * the only way back. The wait now ends, and says so where the transcript would
 * have been.
 */
function stalledLoading(seq: number): Turn {
  return {
    id: `local:${seq}`,
    key: `local:${seq}`,
    role: "system",
    text: "Couldn't load this conversation. Open it again to retry.",
  };
}

function firstUserText(turns: Turn[]): string | undefined {
  const first = turns.find((turn) => turn.role === "user");
  return first?.text.trim().slice(0, 60);
}



/**
 * A turn that just ended, reported to the app so it can announce it.
 *
 * The hook reports rather than decides: whether this is worth a banner depends
 * on whether the app is on screen, which only the component tree knows. See
 * `notificationPolicy.ts`.
 */
export interface TurnFinished {
  sessionId: string;
  /** Project folder as the daemon stamped it, e.g. "pew2". */
  folder?: string;
  /** Display name of the agent that ran it. */
  agentName?: string;
  /** What the agent said this turn, for the notification body. */
  lastText?: string;
  /** The conversation on screen when this landed, if any. */
  activeSessionId?: string;
}

/**
 * How much of an agent's turn is kept for a notification body.
 *
 * Only the first usable line is ever rendered, so this only has to be long
 * enough to contain it past any leading blank lines or a fenced block.
 */
const NOTICE_BUFFER = 2000;


/** Where the daemon should push when this phone's app is asleep. */
export interface PushAddress {
  token: string;
  platform: "ios" | "android";
}

interface DaemonOptions {
  /** Called once per finished turn, for any session — not just the open one. */
  onTurnFinished?: (turn: TurnFinished) => void;
  /**
   * This device's push address, asked for once the channel is up.
   *
   * Injected rather than imported because obtaining it means calling into Expo
   * and React Native, and this module is deliberately platform-free — the
   * daemon's own test suite imports app sources directly, so an SDK import here
   * drags React Native's globals into a Node typecheck and breaks it. The screen
   * supplies the platform half; this file only puts it on the wire.
   *
   * Resolves undefined when there can be no push: a simulator, a fresh clone
   * with no EAS project, or a refused permission.
   */
  pushAddress?: () => Promise<PushAddress | undefined>;
  /**
   * Whether the daemon now has somewhere to push, told to the screen.
   *
   * Reports acceptance, not acquisition: holding a token means nothing if the
   * daemon never stored it. A daemon older than `app.push` answers
   * `unknown_message`, and one that has not seen this device's `hello` refuses
   * it — in both cases no push will ever arrive, and the screen has to know so
   * it keeps raising the local banner instead of going silent.
   */
  onPushRegistered?: (registered: boolean) => void;
}

/**
 * @param deviceId Identifies this phone to the relay, which uses it to tell
 * devices apart. Falls back to a constant so a direct LAN connection, where the
 * daemon does not care, still works.
 */
export function useDaemon(
  url: string,
  deviceId = "phone",
  /**
   * The pairing key, hex. Every frame is sealed with it.
   *
   * Empty means unpaired: the socket is never opened, because a connection with
   * nothing to encrypt with could only fail at the far end — and would look to
   * the user like a broken daemon rather than a missing pairing.
   */
  pairingKey = "",
  options: DaemonOptions = {},
) {
  const [state, setState] = useState<State>({
    status: "connecting",
    providers: [],
    turns: [],
    // Sample conversations in development so history and long-response
    // rendering can be reviewed with content. Real sessions are appended
    // ahead of these and never replaced by them.
    sessions: USE_FIXTURES ? sampleSessions() : [],
    configOptions: [],
    commands: [],
    busy: false,
    activity: IDLE_ACTIVITY,
    loadingSessions: false,
    loadingSession: false,
    projects: {},
    projectPath: {},
    workspaceNonce: 0,
  });

  // Not in State: this is a cache keyed by provider, not part of the session.
  //
  // Never seeded from fixtures. These selectors drive the live top bar, so a
  // sample "Model: Sonnet" would be presented as this agent's real capability
  // and then be silently replaced by the truth once a session opened. Only an
  // agent's own advertisement may populate this.
  const [knownConfigs, setKnownConfigs] = useState<Record<string, ConfigOption[]>>({});
  // Pictures the daemon has been asked to read off the desktop's disk, keyed by
  // the path the agent named. Outside State because it is a cache belonging to
  // this device's viewport, not to the conversation: it is never replayed,
  // never mirrored into history, and a resumed thread re-requests what it can
  // actually see. Inline `data:` sources never enter here at all.
  const [images, setImages] = useState<Record<string, ImageEntry>>({});
  // The same pictures, plus the recency and byte accounting that bounds them.
  //
  // The ref is the source of truth and state is its published copy: eviction has
  // to drop the uri from `requestedImages` as well, and a `setImages` updater is
  // the one place that must not do it — React may run an updater twice, and
  // mutating a ref in one is exactly the impurity `sessionRef` exists to avoid.
  const imagesCache = useRef<ImageCache<ImageEntry>>(emptyImageCache<ImageEntry>());
  // Commands per provider, kept outside the session so opening a conversation
  // does not blank the menu for agents that never send the ACP notification and
  // are served from their project's files instead.
  const [knownCommands, setKnownCommands] = useState<Record<string, SlashCommand[]>>({});

  const socket = useRef<WebSocket | null>(null);
  /** Encryption state for the live socket. Rebuilt on every reconnect. */
  const channel = useRef<SecureChannel | null>(null);
  /** Set once the daemon has refused this device for a reason retrying cannot fix. */
  const fatal = useRef(false);
  const retry = useRef<ReturnType<typeof setTimeout> | null>(null);
  const attempts = useRef(0);
  const alive = useRef(true);
  const resume = useRef<(() => void) | undefined>(undefined);
  // Mirrors state.sessionId so actions can read it without doing work inside a
  // state updater. Updaters must stay pure: React may invoke them twice.
  const sessionRef = useRef<string | undefined>(undefined);
  // Which drawer row the user is actually looking at, `sessionId` or not.
  //
  // Distinct from `sessionRef` because the cases that differ are exactly the
  // ones that went wrong: a conversation still waiting to be named has no
  // session id, and neither does the empty new-chat screen, yet they are
  // different places to be standing. Undefined means the empty screen.
  const viewingRef = useRef<string | undefined>(undefined);
  // Mirrors activeProviderId for the same reason sessionRef exists: message
  // handlers must not read state inside an updater.
  const providerRef = useRef<string | undefined>(undefined);
  // The chosen project per provider, mirrored out of state for the same reason
  // `providerRef` exists: `start` must read the choice made moments ago, not
  // the one captured when its callback was memoized.
  const projectRef = useRef<Record<string, string>>({});
  // The message entered before a session existed — text and any files with it.
  // Sent as soon as the daemon confirms one, so the composer works straight
  // from the empty state.
  const queued = useRef<
    { text: string; attachments: readonly PendingAttachment[] } | undefined
  >(undefined);
  // Counter behind the ids of optimistic user turns. Starting an agent can take
  // seconds, and the daemon's echo arrives only after that, so the prompt is
  // rendered locally first and reconciled when the echo lands.
  const localSeq = useRef(0);
  // Messages typed with no socket to send them on. See `outbox.ts`: the phone
  // is offline routinely, and a send that cannot go out waits here rather than
  // being refused at the keyboard or written to a dead socket and lost.
  //
  // A ref, and only a ref: it is read and written by socket handlers that must
  // not touch state, and it is deliberately not persisted — it holds attachment
  // bytes, and a queue that survives a force-quit would deliver a message the
  // user has long stopped expecting to send.
  const outbox = useRef<OutboxEntry[]>([]);
  // The `session.start` this client is waiting on, if any. Held outside state
  // because the message handler must read it without a render having happened,
  // and matched against the `requestId` echoed back so the answer adopts the
  // drawer row this client created rather than one another device's session
  // would land in. See `pendingSession`.
  const pendingStart = useRef<string | undefined>(undefined);
  // Whether this client is waiting for a conversation it asked to reopen.
  //
  // A resume is answered by the same broadcast `session.started` as a start,
  // and it carries no request id to match on, so "is this reopen mine?" can
  // only be answered by whether this client asked for one at all. Without that
  // a reopen on the laptop pulled every other device onto it.
  const awaitingResume = useRef(false);
  // Providers already asked for capabilities, so a reconnect's repeat provider
  // announcement does not spawn another probe for each one.
  const probed = useRef(new Set<string>());
  // Capability requests in flight, keyed by provider. One slow or broken agent
  // must not keep another provider's already-loaded history behind a skeleton.
  const pendingCapabilities = useRef(new Set<string>());
  // Per-project session requests in flight, keyed by `providerId:cwd`, so
  // choosing a project shows the loading skeleton rather than the empty state
  // it is about to replace.
  const pendingProjectSessions = useRef(new Set<string>());
  // The directory listing the picker is currently waiting for. Only the newest
  // request may write to state: tapping down two levels quickly produces two
  // listings in flight, and the slower one must not land last and rewind the
  // view the user is already looking at.
  const browseRequest = useRef<string | undefined>(undefined);
  const browseCounter = useRef(0);
  // Highest `seq` seen per session.
  //
  // This is what makes reconnecting gap-free. ACP does not replay messages
  // emitted while a client was away, so the relay stores them and hands back
  // everything after the cursor. On a phone this is not an edge case: the
  // socket dies every time the app is backgrounded or the network changes, and
  // without a cursor the tail of every interrupted turn is lost for good.
  const cursors = useRef<Cursors>({});
  // Images already asked for. A ref, not the state map: the request has to be
  // deduped at the moment of asking, which happens outside any updater.
  const requestedImages = useRef(new Set<string>());

  /**
   * Record one image, evicting whatever no longer fits.
   *
   * Both maps move together, always. `requestedImages` is the guard that stops
   * the transcript re-asking for a picture it already has, so an entry evicted
   * from the cache but left in the guard is a picture that can never be fetched
   * again — a spinner for the rest of the app's life. `ChatImage` re-requests on
   * every mount and cells recycle, so forgetting both is all a re-scroll needs.
   */
  const storeImage = useCallback((uri: string, entry: ImageEntry) => {
    const { cache, evicted } = putImage(imagesCache.current, uri, entry);
    imagesCache.current = cache;
    for (const gone of evicted) requestedImages.current.delete(gone);
    setImages(cache.images);
  }, []);

  /**
   * Drop every cached picture.
   *
   * For the moments where the pictures stop being about anything on screen:
   * leaving a conversation, switching agent, losing the pairing. Holding tens of
   * megabytes for a transcript nobody is looking at is the leak this cache
   * exists to stop.
   */
  const clearImages = useCallback(() => {
    imagesCache.current = emptyImageCache<ImageEntry>();
    requestedImages.current.clear();
    setImages({});
  }, []);
  // Daemon session ids the daemon says it currently holds.
  //
  // Session ids belong to a daemon *process*, but this list survives restarts
  // and reconnects, so a conversation on screen can name an id that no longer
  // exists — prompting it answered "Unknown session". The daemon reports its
  // open sessions with every provider announcement, and `hello` triggers one,
  // so a stale entry is reopened by `agentSessionId` instead.
  //
  // Undefined means the daemon never said (an older build): assume every id is
  // live rather than resuming conversations that were fine.
  const liveSessions = useRef<Set<string> | undefined>(undefined);
  // Mirrors state.sessions so openSession can look one up without doing that
  // work inside a state updater.
  const sessionsRef = useRef<Session[]>(state.sessions);
  // Synced in an effect rather than during render: writing a ref while
  // rendering is the same impurity the updaters above avoid.
  useEffect(() => {
    sessionsRef.current = state.sessions;
  }, [state.sessions]);

  // Agents by id, so a finished turn can be announced by name without reading
  // state inside the socket handler.
  const providersRef = useRef<Provider[]>(state.providers);
  useEffect(() => {
    providersRef.current = state.providers;
  }, [state.providers]);

  // Held in a ref so a changing handler never re-opens the socket.
  const onTurnFinished = useRef(options.onTurnFinished);
  useEffect(() => {
    onTurnFinished.current = options.onTurnFinished;
  }, [options.onTurnFinished]);

  // Same reason, for the rest of the options: the socket effect reads them when
  // it needs them rather than depending on them.
  const optionsRef = useRef(options);
  optionsRef.current = options;

  // What each session's agent has said during its current turn, keyed by
  // session, so a notification can quote a conversation that is not on screen.
  //
  // A ref, not state: this is a buffer for one message, it must not re-render
  // anything, and it is written from the socket handler where an updater's
  // "may run twice" rule would corrupt an accumulation.
  const turnText = useRef(new Map<string, string>());

  // Whether this connection has already told the daemon where to push.
  //
  // Reset when the socket is replaced, because a reconnection is exactly when
  // it is worth sending again: a token can rotate while the app is away, and a
  // daemon that restarted has forgotten every token it held.
  const pushRegistered = useRef(false);

  // The agent this device used last, read once from storage.
  //
  // Closing the app is not a decision to go back to whichever agent sorts
  // first, so a launch re-targets the last one used. Undefined means "not read
  // yet": the keychain read starts at mount and finishes long before the
  // daemon's provider list arrives over the socket, so no chip is shown for the
  // wrong agent first.
  const [rememberedProviderId, setRememberedProviderId] = useState<string | undefined>(
    undefined,
  );
  useEffect(() => {
    let cancelled = false;
    loadLastProvider()
      .then((id) => {
        if (!cancelled && id) setRememberedProviderId(id);
      })
      .catch(() => {
        // Secure storage can refuse to read (locked keychain, first run after a
        // restore). Remembering the last agent is a convenience, so falling
        // back to "no preference" is right - crashing the app for it is not.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // The agents this machine last reported, restored for a launch with no
  // signal. Without it a cold start offline knew of no agent at all, so a new
  // conversation had nothing to address — the composer took the words and the
  // send was refused, whatever the outbox was willing to hold. See
  // `providerCache.ts`.
  //
  // Applied only over an empty list, and never after: the socket may well have
  // answered before the keychain did, and this must never overwrite what the
  // machine is saying right now with what it said last week.
  useEffect(() => {
    let cancelled = false;
    void loadCachedProviders().then((cached) => {
      if (cancelled || cached.length === 0) return;
      setState((s) => (s.providers.length > 0 ? s : { ...s, providers: cached }));
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Written back whenever the machine answers, so the memory is of the last
  // truth rather than the first. Keyed on the ids and their availability, not
  // the array — which is rebuilt by frames that change neither.
  const providerKey = state.providers.map((p) => `${p.id}:${p.available}`).join(",");
  useEffect(() => {
    if (!providerKey) return;
    // The ref, not `state.providers`: reading it here keeps the list out of the
    // dependency array, so the write is driven by the key above.
    void saveCachedProviders(providersRef.current);
  }, [providerKey]);

  // Where the composer points before the user picks anything this launch.
  const fallbackProviderId = defaultProviderId(state.providers, rememberedProviderId);

  // Remember every agent the user lands on — chosen from the drawer, opened
  // from history, or started by the daemon — so the next launch resumes there.
  useEffect(() => {
    if (state.activeProviderId) void saveLastProvider(state.activeProviderId);
  }, [state.activeProviderId]);

  // The agent the composer targets, including the implicit first-available one
  // the user never explicitly chose. `providerRef` only knows about deliberate
  // selections, so on a fresh launch it is empty while the UI already names an
  // agent — and a model picked right then would have nowhere to go. Kept in an
  // effect below for the same reason as `sessionsRef`.
  const targetProviderRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    targetProviderRef.current = state.activeProviderId ?? fallbackProviderId;
  }, [state.activeProviderId, fallbackProviderId]);

  useEffect(() => {
    alive.current = true;

    // A different pairing deserves a fresh attempt: this effect re-runs when the
    // url changes, which is exactly when someone has scanned a new code.
    fatal.current = false;
    // The attempt counter and the verdict it produced belong to the pairing that
    // failed. Carried into a newly scanned one, they would leave "Can't reach
    // your machine" sitting over a connection that is only just starting — and
    // one already past the threshold would show it before the first try.
    attempts.current = 0;
    setState((s) => (s.unreachable ? { ...s, unreachable: false } : s));

    const connect = () => {
      if (!alive.current) return;
      setState((s) => ({ ...s, status: "connecting" }));

      const ws = new WebSocket(url);
      socket.current = ws;
      // A new socket has told nobody anything yet, and the daemon on the far
      // end may be a restarted process holding no tokens at all. Until it
      // accepts one, the local banner is the only route there is.
      pushRegistered.current = false;
      optionsRef.current.onPushRegistered?.(false);
      // Fresh per connection: the counters that make replay detectable are only
      // meaningful within one socket, so carrying them across a reconnect would
      // make the new connection's first frames look like replays.
      const secure = new SecureChannel(e2e.fromHex(pairingKey), "app");
      channel.current = secure;

      /**
       * Deliver everything typed while there was nowhere to send it.
       *
       * Called once the channel is proven — the first sealed frame back, not
       * merely an open socket — and again whenever a conversation gains the id
       * its waiting messages are addressed to. See `outbox.ts`.
       */
      const flushOutbox = () => {
        if (outbox.current.length === 0) return;
        // At most one conversation may be starting at a time: `pendingStart`
        // holds a single request id, and a second `session.start` sent beside
        // it could never be adopted — leaving a row that outlives its own
        // answer, and prompts addressed to a pending key nothing will rename.
        // The `session.started` that answers this one flushes the next.
        let starting = pendingStart.current !== undefined;
        const { ready, held } = partitionOutbox(outbox.current, (entry) => {
          if (entry.kind === "start") {
            if (starting) return false;
            starting = true;
            return true;
          }
          // A conversation with no id yet is early rather than undeliverable:
          // `session.started` re-addresses this entry the moment it is named.
          if (isPendingSession(entry.sessionId)) return false;
          // An undefined `activeSessions` is an older daemon saying nothing,
          // which `needsResume` reads as live.
          if (liveSessions.current === undefined || liveSessions.current.has(entry.sessionId))
            return true;
          // The session died with a previous daemon. Held only while reopening
          // the conversation can still re-address it — the resume carries the
          // agent's own id, which is what `session.started` remaps on. Without
          // one, nothing will ever rename this entry, so it goes and is refused
          // out loud rather than waiting in a queue nobody can see.
          const row = sessionsRef.current.find((entry2) => entry2.id === entry.sessionId);
          return !row?.agentSessionId;
        });
        if (ready.length === 0) return;
        outbox.current = held;

        // Which turns stop saying they are waiting. Collected here and applied
        // in one update below, rather than a state pass per message. The turns
        // are also what says which conversations start pulsing: a row is
        // working exactly when one of these bubbles is in it, which stays true
        // through the renaming `session.started` is about to do to it.
        const sent = new Set<string>();
        for (let i = 0; i < ready.length; i++) {
          const entry = ready[i]!;
          // The socket can die between two writes of the same batch. What is
          // left goes back to the front of the queue, ahead of what was held,
          // so the conversation keeps the order it was typed in.
          if (socket.current !== ws || ws.readyState !== WebSocket.OPEN) {
            outbox.current = [...ready.slice(i), ...outbox.current];
            break;
          }
          const message =
            entry.kind === "start"
              ? {
                  t: "session.start",
                  requestId: entry.requestId,
                  providerId: entry.providerId,
                  cwd: entry.cwd,
                }
              : {
                  t: "session.prompt",
                  sessionId: entry.sessionId,
                  text: entry.text,
                  attachments: entry.attachments,
                };
          ws.send(JSON.stringify(secure.seal(message, envelopeHeader(message))));
          if (entry.kind === "start") {
            // Reinstated here, not when the message was queued: `onopen` clears
            // it, and without this the answer would find no row to adopt and
            // prepend a second one beside the prompt already on screen.
            pendingStart.current = entry.requestId;
          }
          // A request alone marks nothing: the conversation is not working
          // until the message it was started for has actually gone, which is a
          // separate entry addressed to it.
          if (entry.kind === "prompt") sent.add(entry.turnKey);
        }
        if (sent.size === 0) return;

        const started = Date.now();
        setState((s) => {
          const turns = markSent(s.turns, sent);
          // A delivered bubble in the open transcript is what makes this the
          // conversation on screen — asked of the turns rather than of a session
          // id, because the row carrying them may still be a `pending:` request
          // that `session.started` renames a moment from now.
          const onScreen = turns !== s.turns;
          return {
            ...s,
            busy: onScreen ? true : s.busy,
            // The clock starts when the message actually leaves the phone. It
            // would be a lie about the agent otherwise — it measures how long
            // the answer took, not how long the tunnel lasted.
            activity: onScreen ? beginActivity(started) : s.activity,
            receipt: onScreen ? undefined : s.receipt,
            turns,
            sessions: s.sessions.map((session) => {
              const owned = markSent(session.turns, sent);
              if (owned === session.turns) return session;
              // Marked working here rather than on the first streamed chunk, for
              // the same reason `deliverPrompt` does: an agent can think for a
              // long time before it says anything.
              return { ...session, turns: owned, busy: true };
            }),
          };
        });
      };

      ws.onopen = () => {
        clearTimeout(deadline);
        attempts.current = 0;
        // A request written to the socket that died is never answered, and its
        // entry would hold the drawer in a skeleton forever. Dropping them here
        // also lets the open project be asked for again.
        pendingProjectSessions.current.clear();
        // Same reasoning for a `session.start` or `session.resume` written to
        // the socket that died: their answer is broadcast once and stored
        // nowhere, so waiting for it across a reconnect is waiting forever. See
        // `dropPendingSessions`.
        pendingStart.current = undefined;
        awaitingResume.current = false;
        setState((s) => ({
          ...s,
          status: "online",
          // Whatever it was, it is reachable now.
          unreachable: false,
          // Turns end while the phone is asleep and the socket is dead, and
          // `session.idle` is not replayed — only `session.event` is persisted.
          // So anything believed to be working across a drop is a guess, and
          // the pulsing dot would never stop. Clear it: a session still running
          // announces itself the moment it finishes, which is the signal that
          // matters.
          // Except the ones whose request never reached a socket at all: they
          // are still in the outbox, and this reconnect is what sends them.
          sessions: dropPendingSessions(
            s.sessions,
            queuedPendingSessions(outbox.current),
          ).map((session) => (session.busy ? { ...session, busy: false } : session)),
        }));
        // Cleartext, because it is what establishes the connection — and carries
        // a sealed proof beside it, so the daemon can tell a paired phone from
        // anyone who merely learned the relay room id.
        ws.send(
          JSON.stringify({
            t: "hello",
            wire: WIRE_VERSION,
            role: "app",
            deviceId,
            // "Everything after this, please." Empty on a first connection.
            cursors: cursors.current,
            proof: secure.proof(deviceId),
          }),
        );
      };

      ws.onmessage = (event) => {
        let frame: unknown;
        try {
          frame = JSON.parse(event.data as string);
        } catch {
          return;
        }

        // A cleartext frame from the daemon or the relay. Only two are acted on,
        // and neither carries user content: a version mismatch, and the refusal
        // that follows a proof the daemon would not accept. Both have to be
        // readable *before* anything can be decrypted, which is exactly why they
        // are the ones left in the open.
        const kind = (frame as { t?: unknown } | null)?.t;
        if (kind === "error") {
          const code = (frame as { code?: unknown }).code;
          // `device-refused` joins these: the pairing is already claimed by
          // another device, which is fatal in exactly the same way — retrying
          // cannot fix it, and the message names the rotation that can.
          //
          // But only when it is addressed to this device. The relay forwards
          // cleartext to every app in the room, so a refusal aimed at someone
          // else — an attacker probing with a leaked link — arrives here too.
          // Acting on it would let one frame from that attacker put the phone
          // that actually owns the pairing into a permanent, un-retried failure.
          const refusedDevice = (frame as { deviceId?: unknown }).deviceId;
          if (
            code === "device-refused" &&
            typeof refusedDevice === "string" &&
            refusedDevice !== deviceId
          ) {
            return;
          }
          if (code === "wire-version" || code === "unpaired" || code === "device-refused") {
            const detail = (frame as { message?: unknown }).message;
            fatal.current = true;
            // Nothing will ever be fetched from that machine again, and these
            // are pictures of its filesystem. Forget them with the pairing.
            clearImages();
            setState((s) => ({
              ...s,
              status: "offline",
              fatal: typeof detail === "string" ? detail : "This device is no longer paired.",
            }));
          }
          return;
        }
        if (kind !== "e") return;

        const message: any = secure.open(frame);
        // Undecryptable: a stray frame, a replay, or traffic from a pairing this
        // phone no longer holds the key for. Silently ignored — there is nothing
        // useful to show and nothing safe to act on.
        if (message === undefined) return;

        // Replayed history, after a reconnect or a resume. Progressive batches
        // make long transcripts visible from the top while the agent continues
        // loading; each batch is still folded in one state update, avoiding the
        // quadratic event-by-event array copies that caused multi-second stalls.
        if (message.t === "session.replay" && Array.isArray(message.events)) {
          if (message.sessionId !== sessionRef.current) {
            // Another conversation's missed events, folded into the transcript
            // that conversation carries. Not rendered now — the user is reading
            // something else — but there to read when they open it, which is
            // the whole point of holding a transcript per session.
            //
            // Only for a catch-up. A *resume* replay of a background session
            // would be its full history arriving against turns this client
            // already has, and duplicating them is worse than waiting for the
            // reopen that asked for it.
            if (message.catchUp === true) {
              const missed: ReplayEvent[] = [];
              for (const event of message.events) {
                if (event?.t !== "session.event" || typeof event.seq !== "number") continue;
                // Same duplicate guard as the visible path below: a catch-up
                // and a live event can cross on the wire, and the cursor is
                // what stops the same chunk being appended twice.
                if (alreadySeen(cursors.current, event.sessionId, event.seq)) continue;
                cursors.current = advance(cursors.current, event.sessionId, event.seq);
                missed.push(event);
              }
              setState((prev) =>
                foldBackgroundCatchUp(
                  prev,
                  message.sessionId,
                  missed,
                  message.working === true,
                  message.permissions,
                ),
              );
            }
            return;
          }
          const events: ReplayEvent[] = [];
          for (const event of message.events) {
            if (event?.t !== "session.event" || typeof event.seq !== "number") continue;
            if (alreadySeen(cursors.current, event.sessionId, event.seq)) continue;
            cursors.current = advance(cursors.current, event.sessionId, event.seq);
            events.push(event);
          }
          setState((prev) => {
            const folded = events.length > 0 ? foldSessionEvents(prev, events) : prev;

            // A reconnect catch-up is the opposite of history: these events are
            // a turn that is running right now, and the socket was simply not up
            // to carry them. See `foldCatchUp`.
            if (message.catchUp === true) {
              return foldCatchUp(
                prev,
                message.sessionId,
                events,
                message.working === true,
                Date.now(),
                // What the agent is still stopped on, which no replayed event
                // can say: a logged `permission_request` is skipped as history,
                // so without this the sheet the user dropped their signal in
                // front of never came back and the turn never resumed.
                message.permissions,
              );
            }

            const complete = message.complete !== false;
            // Reveal on the first real batch. An empty final frame still clears
            // the skeleton for sessions with no visible transcript.
            if (events.length === 0 && !complete) return folded;
            // Replay is history, not an active agent turn. Claude may still be
            // attaching in the background, but prompts safely queue server-side.
            //
            // Except when a turn is already running *here*. Every session gets a
            // replay the moment it goes live — empty, for one just created to
            // carry a first prompt — and clearing on that frame stopped the clock
            // before the agent had said anything. The turn then ended with no
            // start time to measure, so the first exchange of every conversation
            // finished without its "Answered in 4s" while every later one had it.
            //
            // "Running here" means a clock this device started, not `prev.busy`.
            // Opening an old conversation sets `busy` on the way in (it may still
            // be mid-turn on the desktop), and the replay is the only frame that
            // ever cleared it — so carrying it through here left every resumed
            // conversation pulsing in the drawer for as long as the app was open.
            const running = isTimingTurn(prev.activity);
            return {
              ...folded,
              loadingSession: false,
              busy: running,
              // Replayed tool calls finished long ago — the same reason a replay
              // batch never raises a permission. Timing them from this device's
              // clock would report a minutes-old turn as taking an instant. A
              // clock this device started is a different thing and is kept.
              activity: running ? prev.activity : IDLE_ACTIVITY,
              // The finished turn under the restored transcript, taken from the
              // conversation rather than from the screen: what is on screen may
              // still belong to the thread being left. Clearing it outright is
              // what made the line disappear on every reopen that goes through a
              // resume. See `receiptOnReplay`.
              receipt: receiptOnReplay(folded.sessions, message.sessionId, running),
              // The drawer entry too, and this is the flag the user actually
              // sees: the pulsing dot beside the conversation's name. Resuming
              // marks the session working on the way in, `session.started`
              // copies that onto its entry, and nothing else ever takes it off
              // for an agent that sends no `session.idle` after attaching.
              // Only this conversation — a background turn elsewhere is real.
              sessions: folded.sessions.map((session) =>
                session.id === message.sessionId && session.busy !== running
                  ? { ...session, busy: running }
                  : session,
              ),
            };
          });
          return;
        }

        // Advance the cursor here, as the message arrives, for the same reason
        // the session ref is tracked here: updaters must stay pure.
        if (message.t === "session.event" && typeof message.seq === "number") {
          // Replay and the live stream overlap, so an event received just
          // before the socket dropped can arrive again. Rendering it twice
          // would duplicate agent output on screen.
          if (alreadySeen(cursors.current, message.sessionId, message.seq)) return;
          cursors.current = advance(cursors.current, message.sessionId, message.seq);
        }

        // Track the live session id here, as the message arrives, rather than
        // inside the updater below. Updaters must stay pure: React may invoke
        // them twice, and the ref would then desync from state.
        //
        // The awaited request id is read and cleared for the same reason, and
        // only when the daemon echoes the one this client sent: the daemon
        // broadcasts `session.started` to every paired client, so a session
        // opened on the laptop arrives here too and must not consume the row
        // this phone is holding for its own pending request.
        let adoptedRequestId: string | undefined;
        // Whether this conversation is the one on screen, or merely one the
        // daemon is announcing.
        //
        // `session.started` used to be taken as "this is now the screen",
        // unconditionally. It is broadcast to every paired client, so a session
        // opened anywhere — the laptop, another phone — redirected this one,
        // and because the frame carries no transcript the redirect arrived as a
        // blank conversation. Worse, it did that to a session the user had
        // deliberately opened moments earlier: send a prompt, switch away while
        // the agent boots, and the answer landed on whatever was being read,
        // emptying it. Recovering meant force-quitting, and the session that
        // caused it was the one nothing pointed at.
        //
        // So it takes the screen only when the screen is waiting for it: the
        // empty new-chat view, the row this client is holding for its own
        // request, or a reopen whose skeleton is already up.
        let claimsScreen = false;
        if (message.t === "session.started") {
          if (message.requestId && message.requestId === pendingStart.current) {
            adoptedRequestId = pendingStart.current;
            pendingStart.current = undefined;
          }
          const mine =
            adoptedRequestId !== undefined &&
            viewingRef.current === pendingSessionKey(adoptedRequestId);
          const reopened = message.resumed === true && awaitingResume.current;
          if (reopened) awaitingResume.current = false;
          claimsScreen = mine || reopened || viewingRef.current === undefined;
          if (claimsScreen) {
            sessionRef.current = message.sessionId;
            viewingRef.current = message.sessionId;
          }

          // The prompt this client is holding belongs to the session this
          // client started, not to whichever one the daemon announced next.
          // Delivering it to someone else's would put the user's message into a
          // conversation on another device — and lose it from this one.
          const pending = claimsScreen ? queued.current : undefined;
          if (pending) queued.current = undefined;
          if (pending) {
            ws.send(
              JSON.stringify(
                secure.seal(
                  {
                    t: "session.prompt",
                    sessionId: message.sessionId,
                    text: pending.text,
                    attachments: toWireAttachments(pending.attachments),
                  },
                  { sid: message.sessionId },
                ),
              ),
            );
          }
        }

        // Keep what the agent is saying, per session, so a turn that ends off
        // screen can still be quoted in a notification. Above the scope filter
        // below on purpose: the sessions worth announcing are exactly the ones
        // not on screen, and under the filter their text would never be
        // collected.
        //
        // Written here rather than in a state updater, which React may run
        // twice — appending twice would duplicate the text.
        if (message.t === "session.event") {
          const chunk = readChunk(message.payload);
          if (chunk?.role === "agent" && chunk.text) {
            const seen = turnText.current.get(message.sessionId) ?? "";
            // Only the opening line is ever shown, so a long turn must not
            // accumulate megabytes per session for a 140-character banner.
            if (seen.length < NOTICE_BUFFER)
              turnText.current.set(message.sessionId, seen + chunk.text);
          }
        }

        // The daemon broadcasts every session to every client, and a previous
        // session can still be streaming after the user backs out and starts
        // another. Drop anything that is not the session on screen, otherwise
        // its output would appear in the wrong conversation.
        //
        // `session.idle` is deliberately absent: it is the only signal that a
        // conversation left running has finished, which is precisely the one
        // nobody is looking at. It is applied per session instead.
        const scoped = message.t === "session.event" || message.t === "session.config";
        if (scoped && message.sessionId !== sessionRef.current) {
          // Not on screen, but it is still someone's conversation. Its chunks go
          // into the transcript that session carries, so switching away from a
          // working agent and coming back shows the reply that landed while you
          // were gone rather than your own prompt and silence.
          //
          // `session.config` is genuinely not wanted here: it is answered by the
          // `session.config` case, which already mirrors it per session.
          if (message.t === "session.event") {
            setState((prev) =>
              foldBackgroundEvent(
                prev,
                message.sessionId,
                `${message.sessionId}:${message.seq}`,
                message.payload,
              ),
            );
          }
          return;
        }

        if (message.t === "session.idle") {
          const finished: string = message.sessionId;
          const lastText = turnText.current.get(finished);
          // One turn's worth: the next prompt in this session starts empty.
          turnText.current.delete(finished);
          const providerId =
            (message.providerId as string | undefined) ??
            sessionsRef.current.find((entry) => entry.id === finished)?.providerId;
          onTurnFinished.current?.({
            sessionId: finished,
            folder: message.folder,
            agentName: providersRef.current.find((p) => p.id === providerId)?.name,
            lastText,
            activeSessionId: sessionRef.current,
          });

          // A turn just ended, so the agent may have written files: the
          // uncommitted count beside the composer is stale the instant it
          // finishes. Only the open session's project is on screen, so a
          // background session finishing must not re-ask for it. Opening a
          // session or switching agent is covered by the effect below, and
          // asking in both places would count the same repo twice.
          if (finished === sessionRef.current) {
            ws.send(
              JSON.stringify(
                secure.seal(
                  {
                    t: "workspace.status",
                    sessionId: sessionRef.current,
                    providerId: providerRef.current,
                  },
                  { sid: sessionRef.current },
                ),
              ),
            );
          }
        }

        // A session the daemon just opened is live by definition, so record it
        // before the announcement that would otherwise still call it stale.
        if (message.t === "session.started" && message.sessionId) {
          liveSessions.current = new Set(liveSessions.current ?? []).add(message.sessionId);

          // This conversation has a real id now, so the messages waiting on the
          // name it used to have are addressed to it and can go. Two names lead
          // here: the `pending:` key of the request this client sent, and the id
          // this conversation had under a daemon that has since restarted, which
          // a resume replaces. Re-addressed whether or not it is on screen — the
          // messages belong to the conversation, not to the screen.
          if (adoptedRequestId) {
            outbox.current = remapSession(
              outbox.current,
              pendingSessionKey(adoptedRequestId),
              message.sessionId,
            );
          }
          const resumed = message.agentSessionId
            ? sessionsRef.current.find(
                (entry) =>
                  entry.agentSessionId === message.agentSessionId &&
                  entry.id !== message.sessionId,
              )
            : undefined;
          if (resumed) {
            outbox.current = remapSession(outbox.current, resumed.id, message.sessionId);
          }
          flushOutbox();
        }

        // What a *new* conversation with this agent will open with, held per
        // provider so the empty state can show it before any session exists.
        //
        // Only the two messages that actually describe that: the daemon's
        // capability reply, and its announcement that a provider-level choice
        // changed. Deliberately *not* fed from `session.started` or
        // `session.config` — those describe one conversation, and a resumed one
        // comes back at the selectors it was last held at rather than the ones
        // the next prompt would use. Folding them in here is what put "Opus" in
        // the pill and then ran the prompt on the remembered model instead.
        if (message.t === "provider.capabilities" || message.t === "provider.config") {
          const advertised: ConfigOption[] = message.configOptions ?? [];
          if (advertised.length > 0) {
            setKnownConfigs((known) =>
              rememberConfigs(known, message.providerId ?? providerRef.current, advertised),
            );
          }
        }

        // Slash commands, by contrast, are a property of the agent and the
        // project rather than of one conversation, so every message that carries
        // them is a fair source.
        if (
          message.t === "session.started" ||
          message.t === "session.config" ||
          message.t === "provider.capabilities"
        ) {
          // Learned from the probe session, so the sheet works in the empty
          // state — before a prompt has created a session to ask. Held per
          // provider, since every available agent is probed at startup and the
          // last reply to land must not become another agent's menu.
          const commands = offeredCommands(message.commands);
          const owner = message.providerId ?? providerRef.current;
          if (commands.length > 0 && owner) {
            setKnownCommands((known) => ({ ...known, [owner]: commands }));
          }
        }

        // Ask each available agent what it currently offers. The answer comes
        // from the agent, so an app that updates its model line-up is reflected
        // without changing anything here.
        if (message.t === "providers") {
          // Hand the daemon somewhere to push, once per connection.
          //
          // Here rather than beside `hello` because `hello` is cleartext and
          // this must be sealed: a push token identifies this phone, and the
          // relay is not entitled to it. `providers` is the daemon's first
          // sealed reply, so its arrival is the proof the channel is up.
          //
          // Re-sent on every reconnection, not cached, because tokens rotate;
          // the daemon keys them by device, so repeats replace rather than
          // accumulate. Failure is silent by design — a simulator, a fresh
          // clone with no EAS project, or a refused permission all land here,
          // and each one simply leaves the app with the local-only banners it
          // had before.
          const askPush = optionsRef.current.pushAddress;
          if (askPush && !pushRegistered.current) {
            pushRegistered.current = true;
            void askPush().then((address) => {
              // Reported as sent, not as accepted: the daemon stays silent on
              // success, and only speaks up to refuse. A refusal arrives as an
              // `error` below and puts this back to false.
              const sent = address !== undefined && ws.readyState === WebSocket.OPEN;
              if (sent) {
                ws.send(JSON.stringify(secure.seal({ t: "app.push", ...address })));
              }
              optionsRef.current.onPushRegistered?.(sent);
            });
          }
          if (Array.isArray(message.activeSessions)) {
            liveSessions.current = new Set<string>(message.activeSessions);
            // The conversation on screen may have died with a previous daemon
            // process. Reopen it from the agent's own copy rather than leaving
            // a thread that answers "Unknown session" on the next prompt.
            const current = sessionRef.current;
            const stale =
              current && !liveSessions.current.has(current)
                ? sessionsRef.current.find((entry) => entry.id === current)
                : undefined;
            if (stale?.agentSessionId && stale.providerId) {
              sessionRef.current = undefined;
              // The screen is still this conversation, and the reopen about to
              // be sent is the one allowed to land on it.
              awaitingResume.current = true;
              providerRef.current = stale.providerId;
              ws.send(
                JSON.stringify(
                  secure.seal({
                    t: "session.resume",
                    providerId: stale.providerId,
                    agentSessionId: stale.agentSessionId,
                    cwd: stale.cwd,
                  }),
                ),
              );
              setState((s) => ({ ...s, busy: true, loadingSession: true }));
            }
          }
          for (const provider of message.providers ?? []) {
            if (!provider.available || probed.current.has(provider.id)) continue;
            probed.current.add(provider.id);
            pendingCapabilities.current.add(provider.id);
            ws.send(
              JSON.stringify(secure.seal({ t: "provider.capabilities", providerId: provider.id })),
            );
          }

          // Anything typed while there was no signal goes now. Here rather than
          // in `onopen` for two reasons: this frame is the proof the sealed
          // channel works, and `activeSessions` above is what says whether the
          // conversation a queued prompt names still exists.
          flushOutbox();
        }
        if (message.t === "provider.capabilities") {
          pendingCapabilities.current.delete(message.providerId);
        }
        if (message.t === "provider.sessions") {
          pendingProjectSessions.current.delete(`${message.providerId}:${message.cwd}`);
        }
        // A daemon older than this app rejects `provider.sessions` outright, and
        // the rejection names no request. Dropping every in-flight key is the
        // safe read: the alternative is a set that never empties, so choosing
        // that project again would be ignored for the life of the socket.
        if (message.t === "error" && message.code === "unknown_message") {
          pendingProjectSessions.current.clear();
        }
        // A refused push token, for any of the three reasons it can be refused:
        // a daemon too old to know `app.push`, one that has not seen this
        // device's `hello`, or a token it will not accept. All three mean no
        // push will ever arrive, and the screen must go back to raising the
        // local banner — otherwise suppressing it in favour of a push that
        // cannot come leaves a backgrounded phone silent, which is worse than
        // the behaviour this feature replaced.
        if (
          message.t === "error" &&
          (message.code === "unknown_message" ||
            message.code === "push_unidentified" ||
            message.code === "push_token_invalid")
        ) {
          optionsRef.current.onPushRegistered?.(false);
        }

        // Project and git state, answered per request. An answer for a
        // conversation the user has already left describes the wrong project,
        // so it is dropped rather than shown for a second.
        if (message.t === "workspace" && typeof message.cwd === "string") {
          // Two ways an answer can describe the wrong project: it names a
          // conversation that is no longer on screen, or it is the
          // no-session answer (the agent's last project) arriving after a
          // session has since opened somewhere else.
          const mine = message.sessionId
            ? message.sessionId === sessionRef.current
            : !sessionRef.current;
          if (!mine) return;
          const workspace: Workspace = {
            cwd: message.cwd,
            folder: message.folder ?? message.cwd,
            repo: message.repo === true,
            uncommitted: message.uncommitted ?? 0,
          };
          setState((s) => ({ ...s, workspace }));
          return;
        }

        // Browsing the desktop for a project. Answers are matched on
        // `requestId` so a slow listing for a directory the user has already
        // navigated away from cannot overwrite the one they are looking at —
        // which is otherwise easy to trigger by tapping down two levels fast.
        if (message.t === "workspaces" && typeof message.requestId === "string") {
          if (message.requestId !== browseRequest.current) return;
          const refused = message.refused === true;
          setState((s) => ({
            ...s,
            browse: {
              // A refusal names no directory, so the one already on screen is
              // kept. Taking the absent path would drop the pane back to the
              // suggestions view — losing the user's place as the reward for
              // tapping something that could not be opened.
              path: refused
                ? s.browse?.path
                : typeof message.path === "string"
                  ? message.path
                  : undefined,
              parent: refused
                ? s.browse?.parent
                : typeof message.parent === "string"
                  ? message.parent
                  : undefined,
              entries: refused
                ? (s.browse?.entries ?? [])
                : Array.isArray(message.entries)
                  ? (message.entries as WorkspaceEntry[])
                  : [],
              loading: false,
              refused,
            },
          }));
          return;
        }

        // Answered per request rather than as a session event, so it is handled
        // here and kept out of the transcript state entirely.
        if (message.t === "image" && typeof message.uri === "string") {
          const uri: string = message.uri;
          storeImage(
            uri,
            message.dataUri
              ? { status: "ready", dataUri: message.dataUri, mimeType: message.mimeType }
              : { status: "error", message: message.error ?? "Could not load this image" },
          );
          return;
        }

        // Read once, out here: an updater may run twice, and two different
        // clock readings would time the same turn differently on each pass.
        const now = Date.now();

        setState((prev) => {
          switch (message.t) {
            case "providers":
              return {
                ...prev,
                providers: message.providers ?? [],
                loadingSessions: pendingCapabilities.current.size > 0,
              };

            case "provider.capabilities": {
              // Fold in the conversations the agent already holds on disk, so
              // the drawer shows work started at the desk too.
              const sessions = mergeAgentSessions(
                prev.sessions,
                message.providerId,
                message.sessions,
                message.canResume === true,
              );
              // Always publish the provider's completion. Even an empty response
              // must clear its own skeleton while unrelated probes continue.
              return {
                ...prev,
                sessions,
                projects: message.providerId
                  ? { ...prev.projects, [message.providerId]: message.projects ?? [] }
                  : prev.projects,
                loadingSessions: pendingCapabilities.current.size > 0,
              };
            }

            case "provider.sessions": {
              // One project's conversations, asked for when it was chosen. The
              // capped history in `provider.capabilities` is the newest work
              // across every project, so a project touched before that window
              // has nothing in the list until this lands.
              return {
                ...prev,
                sessions: mergeAgentSessions(
                  prev.sessions,
                  message.providerId,
                  message.sessions,
                  message.canResume === true,
                ),
                // Cleared only by the answer it was set for: a reply for a
                // project the user has already moved on from must not end the
                // skeleton over the one they are waiting on.
                loadingProject:
                  prev.loadingProject === `${message.providerId}:${message.cwd}`
                    ? undefined
                    : prev.loadingProject,
              };
            }

            case "session.started": {
              // A resumed conversation arrives with the agent's id for it. Its
              // drawer entry is a stub whose turns live on the agent's disk, so
              // this live session *replaces* it — prepending both would list
              // the same conversation twice.
              const agentSessionId = message.agentSessionId as string | undefined;
              const resumedFrom = agentSessionId
                ? prev.sessions.find((s) => s.agentSessionId === agentSessionId)
                : undefined;
              // Same array when nothing is dropped, which is the common case: a
              // fresh identity re-renders the whole transcript for no change,
              // seen as the first prompt flickering the instant the session
              // opens — right after it was sent.
              //
              // Only the transcript on screen is a candidate: a conversation
              // announced while the user is reading a different one has no
              // optimistic turns of its own, and taking them from the visible
              // thread would move that thread's unsent prompt into it.
              const visibleTurns = claimsScreen ? prev.turns : [];
              const local = visibleTurns.filter(isOptimistic);
              const turns = local.length === visibleTurns.length ? visibleTurns : local;
              const live: Session = {
                id: message.sessionId,
                providerId: message.providerId ?? prev.activeProviderId ?? "",
                title: firstUserText(turns) ?? resumedFrom?.title ?? "New conversation",
                startedAt: Date.now(),
                turns,
                configOptions: message.configOptions ?? [],
                agentSessionId,
                // The project this conversation belongs to, known now rather
                // than at the end of its first turn. `session.idle` used to be
                // the only thing that ever set this, and the drawer filters by
                // it — so with a project selected a new conversation was absent
                // from the list until it had finished replying, which is the
                // one moment the user is most likely to go looking for it.
                //
                // The daemon's answer only, never this phone's selected project
                // as a fallback. This frame is broadcast, so most of the time it
                // describes a conversation started somewhere else, and guessing
                // would file another device's work under whatever project this
                // screen happens to be showing. A session that arrives without
                // one is left unplaced, and `session.idle` still names it later.
                cwd: message.cwd ?? resumedFrom?.cwd,
                // A session started to deliver a first prompt is already
                // working; the drawer must say so from the moment it exists.
                // Only when this is that session: `prev.busy` describes the
                // conversation on screen, and copying it onto an unrelated one
                // announced from another device is a row that pulses for work
                // it is not doing.
                busy: claimsScreen ? prev.busy : undefined,
              };
              // The row this client already added when it asked, if this is the
              // answer to that request. Adopting it in place keeps the
              // conversation where the user last saw it in the list instead of
              // removing a row and prepending a near-identical one.
              const adopted = adoptPendingSession(prev.sessions, adoptedRequestId, live);
              const sessions = adopted ?? replaceAgentSessionStub(prev.sessions, live);
              // In the drawer either way — that is the whole point of this
              // frame — but the screen is only redirected when it was waiting
              // for this conversation. See `claimsScreen`.
              if (!claimsScreen) return { ...prev, sessions };
              return {
                ...prev,
                sessions,
                sessionId: message.sessionId,
                activeProviderId: message.providerId ?? prev.activeProviderId,
                configOptions: message.configOptions ?? [],
                // Keep any prompt already rendered optimistically: it belongs to
                // this session, which was started to deliver it.
                turns,
                // Keep the skeleton until the batched transcript follows this frame.
                loadingSession: message.resumed === true,
                // `prev.busy`, not `false`, for a session started to carry a
                // first prompt: `start` already marked it working and began the
                // clock. Overwriting that stopped the timer before the agent had
                // said anything, so `summariseActivity` found no start time and
                // the first turn of every conversation finished without its
                // "Answered in 4s" — every later turn had one.
                busy: message.resumed === true ? true : prev.busy,
              };
            }

            case "session.idle": {
              // Arrives for every session, including ones this client is not
              // showing, so the flags are set per session and only the open
              // one touches the global spinner. Without that, a background
              // agent finishing would stop the spinner on the turn you are
              // actually watching.
              const mine = message.sessionId === prev.sessionId;
              // What the turn did, summarised once. Only the visible session
              // has an `activity` to summarise — a background turn's tools were
              // never rendered — so this is undefined for the others, which is
              // also the honest answer: nothing was measured.
              const receipt = mine ? summariseActivity(prev.activity, now) : undefined;
              return {
                ...prev,
                busy: mine ? false : prev.busy,
                // A turn cannot end while its agent is waiting to be let past a
                // tool, so an approval still standing here died with the turn:
                // cancelled, or the agent gave up. The daemon has already
                // forgotten it, and a button that posts an id nothing is
                // listening for is worse than no button.
                permission: mine ? undefined : prev.permission,
                // The live line exits here, and what it was doing becomes the
                // receipt.
                activity: mine ? IDLE_ACTIVITY : prev.activity,
                receipt: mine ? receipt : prev.receipt,
                // Stored on the conversation too, so reopening it shows the
                // same line rather than losing it to navigation.
                sessions: recordReceipt(prev.sessions, message.sessionId, receipt).map((session) =>
                  session.id === message.sessionId
                    ? {
                        ...session,
                        busy: false,
                        permission: undefined,
                        // Worth going back to, and marked as such until it is
                        // opened. Never for the conversation on screen: its
                        // reply is already there to read.
                        unread: !mine,
                        folder: session.folder ?? message.folder,
                      }
                    : session,
                ),
              };
            }

            case "session.config": {
              const configOptions = message.configOptions ?? [];
              return {
                ...prev,
                configOptions,
                // Mirror into history so reopening restores the same selection.
                sessions: prev.sessions.map((session) =>
                  session.id === message.sessionId
                    ? { ...session, configOptions }
                    : session,
                ),
              };
            }

            case "session.event": {
              const payload = message.payload;

              // Folded before anything else, and carried through every exit
              // below: a tool call is not a chunk, so most of this case returns
              // early and would otherwise drop the very updates it is watching.
              const activity = foldActivity(prev.activity, payload, now);
              // Same object when the event changed no tool, so a streamed word
              // of prose does not re-render the footer.
              const base = activity === prev.activity ? prev : { ...prev, activity };

              // Sent once per session rather than per turn, and specific to the
              // project the agent opened, so it is held until replaced.
              const commands = readAvailableCommands(payload);
              if (commands) return { ...base, commands };

              // How full the agent's context window is. Held like `commands` —
              // it describes the session, not this turn — and filtered to the
              // session on screen, since the daemon broadcasts every session's
              // events and another project's meter is not this one's.
              const usage = readUsage(payload);
              if (usage) {
                if (message.sessionId !== sessionRef.current) return base;
                return { ...base, usage };
              }

              const permission = readPermissionRequest(payload);
              if (permission) {
                return {
                  ...base,
                  busy: false,
                  permission,
                  // Filed against the conversation as well as shown, so it is
                  // still answerable after switching away — and so a reconnect,
                  // which restates every open request, has something to
                  // reconcile against.
                  sessions: base.sessions.map((session) =>
                    session.id === message.sessionId ? { ...session, permission } : session,
                  ),
                };
              }

              const chunk = readChunk(payload);
              if (!chunk || isEmptyChunk(chunk)) return base;

              const turns = [...prev.turns];
              // Shared with the replay fold and with background sessions, so a
              // conversation reads the same whether it was watched live, caught
              // up after a drop, or written while the user was elsewhere.
              applyChunk(turns, `${message.sessionId}:${message.seq}`, chunk);
              // Bounded here rather than inside that helper: this is the one
              // place a turn is added to the visible transcript, and it runs for
              // every chunk of every streamed answer.
              const capped = capTurns(turns);
              // Mirror into history so the sidebar can reopen this later, and
              // title the session from its first user message.
              const sessions = prev.sessions.map((session) =>
                session.id === message.sessionId
                  ? {
                      ...session,
                      turns: capped,
                      title:
                        session.title === "New conversation" && chunk.role === "user"
                          ? chunk.text.trim().slice(0, 60)
                          : session.title,
                    }
                  : session,
              );

              return { ...base, turns: capped, sessions, busy: chunk.role !== "system" };
            }

            case "error": {
              // A desktop older than this app does not know an optional request
              // (the workspace bar's, first of all). That is not a failure of
              // anything the user did: rendering it would drop a system turn
              // into the transcript and clear `busy` mid-stream, killing the
              // spinner on a turn that is still running. The bar simply stays
              // empty until that daemon is updated.
              //
              // One thing must still be undone: a `provider.sessions` this
              // daemon cannot answer would otherwise leave the drawer on its
              // skeleton forever — an endless spinner over the project whose
              // conversations are the one thing an old daemon cannot list.
              // Falling back to the history already held is the honest state.
              if (message.code === "unknown_message") {
                return prev.loadingProject === undefined
                  ? prev
                  : { ...prev, loadingProject: undefined };
              }

              // Agents usually stream a failure as message text and then reject
              // the turn, so the same sentence arrives twice. Promote the copy
              // already on screen instead of appending a second one: the user
              // sees it once, and in the colour that says it failed.
              const duplicate = findDuplicateError(prev.turns, message.message);
              if (duplicate >= 0) {
                const turns = [...prev.turns];
                // Keep the agent's own wording, which may carry more context
                // than the rejection; only its severity was wrong.
                turns[duplicate] = { ...turns[duplicate]!, role: "system" };
                return { ...prev, busy: false, loadingSession: false, turns };
              }
              return {
                ...prev,
                busy: false,
                loadingSession: false,
                turns: capTurns([
                  ...prev.turns,
                  // Date.now() collides when two errors land in the same
                  // millisecond; the length keeps it unique within the thread.
                  {
                    id: `err-${prev.turns.length}-${Date.now()}`,
                    role: "system",
                    text: message.message,
                  },
                ]),
              };
            }

            default:
              return prev;
          }
        });
      };

      const scheduleReconnect = () => {
        // Only the current socket may drive reconnection. On Fast Refresh or a
        // url change, the previous socket's onclose fires after the new one is
        // already open; without this guard it would mark us offline and open a
        // duplicate connection that keeps dispatching state updates.
        if (!alive.current || socket.current !== ws) return;
        // A refusal the daemon explained is not a blip. Retrying a rotated key
        // or a version mismatch every few seconds forever would never succeed,
        // would keep the radio awake, and would bury the explanation under a
        // status line that says the opposite.
        if (fatal.current) {
          setState((s) => ({ ...s, status: "offline" }));
          return;
        }
        // Past this many tries the socket is not coming up on its own schedule,
        // and calling it "connecting" is no longer true. Roughly fifteen seconds
        // of backoff: long enough to ride out a network switch or a daemon
        // restart, short enough that nobody is left reading a spinner.
        const stalled = attempts.current + 1 >= STALLED_ATTEMPTS;
        setState((s) =>
          s.status === "offline" && Boolean(s.unreachable) === stalled
            ? s
            : { ...s, status: "offline", unreachable: stalled },
        );
        // Exponential backoff, capped, so a sleeping laptop does not get hammered.
        const delay = Math.min(1000 * 2 ** attempts.current, 10_000);
        attempts.current += 1;
        retry.current = setTimeout(connect, delay);
      };

      // A socket that never finishes connecting, and never fails either.
      //
      // The handshake reaches out over whatever the phone last had, and a
      // network that changed underneath it — wifi to cellular, a captive
      // portal, a VPN coming up — leaves the TCP connection half open: nothing
      // is coming back, but nothing has been refused, so `onclose` and
      // `onerror` are never called and the backoff below never runs. iOS will
      // eventually time it out on its own schedule, which is measured in
      // minutes and looks exactly like the app having given up silently. This
      // is the deadline the platform does not give.
      //
      // Closing it is enough to start recovery: `onclose` follows, which is the
      // same path a refused connection takes, so the attempt counts towards the
      // backoff and towards `unreachable` like any other failure.
      const deadline = setTimeout(() => {
        if (socket.current !== ws || ws.readyState !== WEBSOCKET_CONNECTING) return;
        ws.close();
      }, CONNECT_TIMEOUT);

      ws.onclose = () => {
        clearTimeout(deadline);
        scheduleReconnect();
      };
      ws.onerror = () => ws.close();
    };

    connect();

    // Published for `resumeNow` below, which cannot reach `connect` itself: the
    // socket and its backoff are scoped to this effect.
    resume.current = () => {
      if (!alive.current) return;
      // A refusal the daemon explained is still a refusal after a trip to the
      // home screen; retrying it here would defeat the whole point of `fatal`.
      if (fatal.current) return;
      const ws = socket.current;
      // A live socket needs nothing. `CONNECTING` is left alone too: an attempt
      // is already in flight, and replacing it would abandon a connection that
      // may be one frame from opening.
      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        return;
      }
      if (retry.current) {
        clearTimeout(retry.current);
        retry.current = null;
      }
      // Deliberately back to zero. The attempts behind us were made against a
      // backgrounded app, and carrying their count forward would both stretch
      // the next delay and let one more failure trip the "can't reach your
      // machine" threshold on what is, for the user, the first try.
      attempts.current = 0;
      // And the verdict those attempts produced goes with them. The UI checks
      // `unreachable` before `status`, so leaving it set would keep "Can't reach
      // your machine" on screen over a connection that is only just starting —
      // the pessimistic message this whole path exists to get rid of. Guarded so
      // a resume with nothing to correct does not re-render the tree.
      setState((s) => (s.unreachable ? { ...s, unreachable: false } : s));
      connect();
    };

    return () => {
      alive.current = false;
      resume.current = undefined;
      if (retry.current) clearTimeout(retry.current);
      const ws = socket.current;
      socket.current = null;
      // Drop the handlers before closing so the outgoing socket cannot mutate
      // state or schedule a reconnect after teardown.
      channel.current = null;
      if (ws) {
        ws.onopen = null;
        ws.onmessage = null;
        ws.onclose = null;
        ws.onerror = null;
        ws.close();
      }
    };
    // `pairingKey` and `deviceId` belong here beside `url`: the key is stripped
    // from the url before it is stored (`pairingLink.ts`), so re-pairing to the
    // same machine with a rotated key leaves this effect — and the
    // `SecureChannel` built inside it — holding the key that no longer opens
    // anything. `storeImage` and `clearImages` are `useCallback([])` and never
    // change identity, so listing them costs no reconnects.
  }, [url, deviceId, pairingKey, storeImage, clearImages]);

  /**
   * Send one sealed message.
   *
   * Returns false when nothing was sent, so a caller can report the failure.
   * A missing channel counts as not connected: sending in the clear would put
   * the very content this exists to protect on the wire, so it is not a
   * fallback — it is the failure.
   */
  const post = useCallback((message: unknown) => {
    const ws = socket.current;
    const secure = channel.current;
    if (!ws || !secure || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(secure.seal(message, envelopeHeader(message))));
    return true;
  }, []);

  // Sent outside any state updater: React may invoke an updater twice, and a
  // socket write in one would ask the daemon for the same picture twice.
  const sendImageRequest = useCallback(
    (uri: string) => {
      const sent = post({
        t: "image.fetch",
        requestId: uri,
        sessionId: sessionRef.current,
        uri,
      });
      storeImage(
        uri,
        sent
          ? { status: "loading" }
          : // Offline: say so rather than spinning forever on a request that was
            // never written to a socket.
            { status: "error", message: "Not connected to your computer" },
      );
    },
    [post, storeImage],
  );

  /**
   * Retry the connection now instead of waiting out the backoff.
   *
   * Called when the app returns to the foreground. iOS suspends the socket on
   * background and it closes without ceremony, so a retry is usually already
   * queued — and because the delay doubles, it can be up to ten seconds out. The
   * user comes back to a conversation reporting itself offline on a network that
   * is perfectly fine, for no reason but a timer's opinion. Returning to the
   * foreground is strong evidence the network is worth another try.
   *
   * The `AppState` listener that calls this lives in the caller rather than in
   * here, and that is load-bearing rather than tidiness: this module is reached
   * by the daemon's own tests through `agentHistory.ts`, which imports `Session`
   * from it. A `react-native` import here drags React Native's global type
   * declarations into the daemon's TypeScript program, where they redefine
   * `setTimeout` as returning a browser-style `number` — breaking every
   * `.unref()` and `Timeout` in the daemon, in files nobody touched. Keeping
   * this hook free of native imports is the same rule the pure modules follow.
   */
  const resumeNow = useCallback(() => {
    resume.current?.();
  }, []);

  /**
   * Send a prompt, or hold it until there is a socket to send it on.
   *
   * The one place a user message becomes a turn, shared by the two ways of
   * sending one: into an open conversation, and into a conversation that has
   * been asked for but not yet named. Both can be offline, and the difference
   * shows only in what the bubble says about itself — the message is rendered
   * either way, and `flushOutbox` delivers it when the signal returns.
   *
   * Returns false only when the message is genuinely not taken: the queue is
   * full. The composer keeps the words in that case rather than clearing a
   * message that is going nowhere.
   */
  const deliverPrompt = useCallback(
    (sessionId: string, text: string, attachments: readonly PendingAttachment[]): boolean => {
      // Attempted first, because its answer decides everything below. A
      // conversation with no id yet cannot be addressed at all, so it does not
      // even try: `session.started` re-addresses this entry later.
      const wire = toWireAttachments(attachments);
      const sent =
        !isPendingSession(sessionId) &&
        post({ t: "session.prompt", sessionId, text, attachments: wire });
      const turn = localTurn(localSeq.current++, text, attachmentImages(attachments), !sent);
      if (!sent) {
        const queue = enqueue(outbox.current, {
          kind: "prompt",
          turnKey: turn.key!,
          sessionId,
          text,
          attachments: wire,
        });
        if (!queue) return false;
        outbox.current = queue;
      }
      const started = Date.now();
      // The conversation on screen, whether it has an id yet or not.
      const visible =
        sessionId === sessionRef.current ||
        (isPendingSession(sessionId) && sessionId === viewingRef.current);
      setState((s) => ({
        ...s,
        // Nothing is working while a message waits for a socket, so nothing
        // spins and no clock runs. Both start in `flushOutbox`, at the moment
        // the message actually leaves the phone.
        busy: visible && sent ? true : s.busy,
        // Whatever this conversation was still loading, it is now carrying a
        // prompt the user just sent. `loadingSession` suppresses the working
        // indicator entirely, so leaving it set showed an empty transcript
        // under the message for as long as the agent took to attach — the
        // one moment the user most needs to see that something is happening.
        loadingSession: visible ? false : s.loadingSession,
        // A prompt sent to another conversation is not what this transcript
        // is showing, so the line under it keeps describing this one.
        activity: visible && sent ? beginActivity(started) : s.activity,
        receipt: visible && sent ? undefined : s.receipt,
        turns: visible ? capTurns([...s.turns, turn]) : s.turns,
        sessions: s.sessions.map((session) =>
          session.id === sessionId
            ? {
                ...session,
                turns: capTurns([...session.turns, turn]),
                // Marked working here, not on the first streamed chunk:
                // an agent can think for a long time before it says
                // anything, and the drawer should show that as work.
                busy: sent ? true : session.busy,
                unread: false,
                title:
                  session.title === "New conversation" ? turn.text.slice(0, 60) : session.title,
              }
            : session,
        ),
      }));
      return true;
    },
    [post],
  );

  const actions = useMemo(
    () => ({
      /**
       * `initialText` and its attachments are sent automatically once the
       * session is ready.
       */
      start: (
        providerId: string,
        initialText?: string,
        attachments: readonly PendingAttachment[] = [],
      ): boolean => {
        const started = Date.now();
        // A conversation with this agent already asked for and still waiting for
        // a socket: this message joins it instead of opening a second one.
        // Offline that is the ordinary case rather than a race — without it,
        // every message typed in a tunnel would open its own thread and spawn
        // its own agent the moment the signal came back.
        const waiting = initialText ? pendingStartFor(outbox.current, providerId) : undefined;
        if (waiting) {
          return deliverPrompt(pendingSessionKey(waiting.requestId), initialText!, attachments);
        }
        queued.current = initialText ? { text: initialText, attachments } : undefined;
        // Named, so the answer can be matched to this request rather than to
        // whichever `session.started` happens to arrive next: the daemon
        // broadcasts them to every client, and another device starting a
        // conversation at the same moment would otherwise be adopted here.
        //
        // Carries the device id because that is the part no other client can
        // repeat. A counter and a clock alone are per-app values, and two
        // phones opening their first conversation in the same millisecond would
        // mint the same string — which is the one case this id exists to tell
        // apart.
        const requestId = `start:${deviceId}:${localSeq.current++}:${started}`;
        pendingStart.current = requestId;
        viewingRef.current = pendingSessionKey(requestId);
        // A chosen project is where this conversation opens. Without it the
        // daemon falls back to the agent's last workspace, which is the whole
        // reason picking a project from the phone was impossible before.
        const cwd = projectRef.current[providerId];
        const sent = post({ t: "session.start", requestId, providerId, cwd });
        // Spawning the agent and its ACP handshake take seconds; without a local
        // turn the screen would sit empty and look like the send did nothing.
        const turn = initialText
          ? localTurn(localSeq.current++, initialText, attachmentImages(attachments), !sent)
          : undefined;
        if (!sent) {
          // The first message is queued against the request rather than held in
          // `queued`, which is only delivered when the answer lands on the
          // conversation the user is looking at. Across a reconnect that is a
          // long time to still be standing in the same place — open another
          // conversation meanwhile and the message would be adopted into the
          // new row and then never sent. See `QueuedStart`.
          queued.current = undefined;
          const request = enqueue(outbox.current, { kind: "start", requestId, providerId, cwd });
          const queue =
            request && turn
              ? enqueue(request, {
                  kind: "prompt",
                  turnKey: turn.key!,
                  sessionId: pendingSessionKey(requestId),
                  text: initialText!,
                  attachments: toWireAttachments(attachments),
                })
              : request;
          // Both or neither: a request queued without the message it exists to
          // carry would open an empty conversation on reconnect.
          if (!queue) return false;
          outbox.current = queue;
        }
        setState((s) => ({
          ...s,
          busy: turn !== undefined && sent,
          loadingSession: false,
          turns: turn ? capTurns([...s.turns, turn]) : s.turns,
          // The clock starts when the prompt leaves the phone, not when the
          // agent first speaks: booting the agent is part of the wait. A prompt
          // still waiting for a socket has not left the phone, and its clock
          // starts in `flushOutbox` instead.
          activity: turn && sent ? beginActivity(started) : s.activity,
          receipt: undefined,
          // The conversation exists as far as the user is concerned — they
          // just started it — so it is in the drawer from here, carrying the
          // prompt, and `session.started` adopts this row rather than creating
          // its own. Leaving the list untouched until the answer arrived is
          // what made a conversation vanish when the reply was slow and the
          // user moved on: it was running on the desktop with nothing on the
          // phone pointing at it. See `pendingSession`.
          sessions: [
            {
              ...pendingSession(requestId, providerId, initialText, started, cwd),
              // A conversation whose request is still queued is not working:
              // nothing has been asked of anything yet.
              busy: turn !== undefined && sent,
              turns: turn ? [turn] : [],
            },
            ...s.sessions,
          ],
        }));
        return true;
      },

      /**
       * Send a prompt.
       *
       * `to` names a conversation other than the one on screen, which is how a
       * reply typed into a notification reaches the agent it answers without
       * yanking the user into that thread. The optimistic turn is then only
       * recorded against that session, never the visible transcript — putting
       * it there would show a message from another project in this one.
       *
       * `attachments` are inlined into the message; the daemon writes them to
       * its own disk and hands the agent a path it can actually open.
       *
       * @returns false when the conversation must be reloaded first — a daemon
       * restart drops its session ids, and prompting one it no longer holds
       * answers "Unknown session". The caller still has the text and can open
       * the conversation instead of losing it.
       */
      prompt: (text: string, to?: string, attachments: readonly PendingAttachment[] = []): boolean => {
        const sessionId = to ?? sessionRef.current;
        if (!sessionId) return false;
        if (to && to !== sessionRef.current) {
          const target = sessionsRef.current.find((entry) => entry.id === to);
          if (!target || needsResume(target, liveSessions.current)) return false;
        }
        return deliverPrompt(sessionId, text, attachments);
      },

      cancel: () => {
        const sessionId = sessionRef.current;
        if (sessionId) {
          post({ t: "session.cancel", sessionId });
          // No receipt for a turn the user stopped: it did not finish, and
          // reporting what it managed first would read as a result.
          setState((s) => ({ ...s, busy: false, activity: IDLE_ACTIVITY, receipt: undefined }));
          return;
        }

        // Stop pressed while the agent is still booting. The first prompt of a
        // conversation is not sent yet — it is held in `queued` until
        // `session.started` names a session to send it to — so there is nothing
        // for the daemon to cancel, and dropping the queued text *is* the
        // cancel. Without this the prompt went out the moment the session
        // opened, and Stop appeared to work only on the second press.
        const pending = queued.current;
        queued.current = undefined;
        // Built out here, not in the updater: React may invoke an updater twice,
        // and `localSeq.current++` inside one would hand two turns the same id.
        const note = pending ? stoppedBeforeSend(localSeq.current++) : undefined;
        setState((s) => ({
          ...s,
          busy: false,
          activity: IDLE_ACTIVITY,
          receipt: undefined,
          // The prompt is still on screen but the agent never saw it: say so,
          // rather than leaving it looking like a message that was ignored.
          turns: note ? [...s.turns, note] : s.turns,
        }));
      },

      answer: (requestId: string, optionId: string) => {
        const sessionId = sessionRef.current;
        if (sessionId) post({ t: "session.permission", sessionId, requestId, optionId });
        setState((s) => ({
          ...s,
          permission: undefined,
          busy: true,
          // Cleared on the conversation too, or reopening it would offer the
          // same approval again and the second answer would land on a request
          // the agent has already been let past.
          sessions: s.sessions.map((session) =>
            session.id === sessionId && session.permission
              ? { ...session, permission: undefined }
              : session,
          ),
        }));
      },

      /** Change a model, thinking level or mode on the open session. */
      setConfig: (configId: string, value: string | boolean) => {
        const sessionId = sessionRef.current;
        const providerId = providerRef.current ?? targetProviderRef.current;
        // Chosen in a live conversation or in the empty state, this is now what
        // the *next* conversation opens with too: the daemon records either
        // against the provider. Applied locally so the empty state is already
        // right the moment you leave this one, rather than a round trip later.
        if (providerId) {
          setKnownConfigs((known) => ({
            ...known,
            [providerId]: withChoice(known[providerId] ?? [], configId, value),
          }));
        }
        if (sessionId) {
          post({ t: "session.config", sessionId, configId, value });
          return;
        }

        // Nothing to set it on yet: a conversation is only created by its first
        // prompt, so before then the daemon holds the choice against the
        // provider and the new session opens with it applied. Without this the
        // pill in the empty state silently did nothing until you had sent a
        // message — the one moment you are most likely to be choosing a model.
        if (!providerId) return;
        post({ t: "provider.config", providerId, configId, value });
      },

      /** Reopen a past conversation from the sidebar. */
      openSession: (sessionId: string) => {
        const session = sessionsRef.current.find((entry) => entry.id === sessionId);
        if (!session) return;

        // A conversation from the agent's own history has no turns here yet:
        // they live on the agent's disk and stream back as ordinary events once
        // it loads. Show the agent and wait rather than rendering it empty.
        //
        // A session this app started is shown from memory instead — unless the
        // daemon no longer holds it. See `needsResume`.
        if (needsResume(session, liveSessions.current)) {
          sessionRef.current = undefined;
          // The row being reopened, even though it has no session id until the
          // daemon answers: this is the screen, and a `session.started` for
          // something else must not land on it.
          viewingRef.current = sessionId;
          awaitingResume.current = true;
          providerRef.current = session.providerId;
          queued.current = undefined;
          post({
            t: "session.resume",
            providerId: session.providerId,
            agentSessionId: session.agentSessionId,
            cwd: session.cwd,
          });
          setState((s) => ({
            ...s,
            sessionId: undefined,
            activeProviderId: session.providerId,
            workspace: undefined,
            // Belongs to the conversation being left: a context reading is about one
            // agent's window, and carrying it across would put the previous chat's
            // percentage beside this one's project.
            usage: undefined,
            turns: [],
            configOptions: [],
            // Cleared so the previous conversation's menu is not offered for
            // this one; the provider's own list below fills it back in.
            commands: [],
            // A reopen is a new agent session, so nothing can be pending in it
            // yet — and the sheet being left behind belongs to a request in the
            // conversation being left, which this screen must not answer.
            permission: undefined,
            busy: true,
            loadingSession: true,
            // Both describe the conversation being left.
            activity: IDLE_ACTIVITY,
            receipt: undefined,
            sessions: s.sessions.map((entry) =>
              // Its approval goes with it: a resume means the daemon no longer
              // holds that session, so the request it was blocked on died with
              // the old agent and the button would post an id into nothing.
              entry.id === sessionId
                ? { ...entry, unread: false, permission: undefined }
                : entry,
            ),
          }));
          return;
        }

        // Fixture transcripts exist only on this device, so they must never
        // become the target of a prompt, cancel or config change: the daemon
        // has never heard of them and those messages would vanish silently.
        // Opening one shows its history and selects its agent; typing then
        // starts a real session instead of posting against a phantom id.
        //
        // A conversation still waiting for its `session.started` is the same
        // case for the same reason — the daemon has not named it yet, so there
        // is no id to address — with the difference that this one becomes real
        // shortly. Opening it shows the prompt already sent, and the answer
        // lands in this transcript anyway, because `session.started` sets
        // `sessionId` regardless of what is on screen.
        const live = !isFixtureSession(sessionId) && !isPendingSession(sessionId);
        sessionRef.current = live ? sessionId : undefined;
        viewingRef.current = sessionId;
        // Opening this one withdraws the claim of a reopen still in flight. A
        // resume does not block the drawer, so tapping a second conversation
        // while the first is still attaching is ordinary — and without this the
        // first one's answer would arrive, still count as "mine", and pull the
        // user back out of the conversation they just chose.
        awaitingResume.current = false;
        providerRef.current = session.providerId;
        queued.current = undefined;
        setState((s) => ({
          ...s,
          sessionId: live ? sessionId : undefined,
          activeProviderId: session.providerId,
          // Another conversation can be in another project entirely. The nonce
          // covers the case this branch also serves: opening a *fixture* leaves
          // `sessionId` and the provider exactly as they were, so without it the
          // row stays blank rather than coming back.
          workspace: undefined,
          // Belongs to the conversation being left: a context reading is about one
          // agent's window, and carrying it across would put the previous chat's
          // percentage beside this one's project.
          usage: undefined,
          workspaceNonce: s.workspaceNonce + 1,
          turns: session.turns,
          configOptions: session.configOptions,
          // This conversation's own state, not a reset: it may still be
          // mid-turn on the desktop, and clearing the spinner here would show
          // a running agent as finished.
          busy: session.busy === true,
          // Same rule, and the reason it is kept per session: an agent stopped
          // waiting for approval is what the user came back to deal with. The
          // previous conversation's sheet goes with it — answering that one
          // from here posted the wrong session's request id, which the daemon
          // dropped in silence.
          permission: session.permission,
          loadingSession: false,
          // A conversation still running elsewhere has tools this client never
          // saw, so there is no live line to restore.
          activity: IDLE_ACTIVITY,
          // Its last finished turn's summary, though, is a fact about that
          // turn and is restored with it.
          receipt: receiptOnOpen(session),
          // Reading it is what makes it read.
          sessions: s.sessions.map((entry) =>
            entry.id === sessionId ? { ...entry, unread: false } : entry,
          ),
        }));
      },

      /**
       * Narrow the drawer to one project, and start the next conversation in
       * it. `path` undefined is "all projects", the state every agent opens in.
       *
       * Asks the daemon for that project's conversations as well as filtering
       * what is already here: the history this client holds is the newest work
       * across every project, so a project last touched a month ago has none
       * of its own rows in it.
       */
      selectProject: (providerId: string, path?: string) => {
        if (path) projectRef.current = { ...projectRef.current, [providerId]: path };
        else {
          const { [providerId]: _dropped, ...rest } = projectRef.current;
          projectRef.current = rest;
        }
        setState((s) => ({
          ...s,
          projectPath: path
            ? { ...s.projectPath, [providerId]: path }
            : Object.fromEntries(
                Object.entries(s.projectPath).filter(([id]) => id !== providerId),
              ),
          // Any fetch still in flight is for the project just left, so its
          // skeleton no longer describes this list. Back to "all projects"
          // especially: nothing is being fetched at all, and leaving this set
          // would hold the drawer in a skeleton over history it already has.
          loadingProject: undefined,
        }));
        // The request itself is an effect below, so a project chosen while
        // offline is still asked for the moment the socket comes back.
      },

      /**
       * Look on the desktop for somewhere to work.
       *
       * Call with no path for the opening view — git checkouts the daemon found
       * — and with one to browse into a directory. This is the only route into
       * an agent that has never been used: its project list comes from its own
       * past sessions, so a new agent offers nothing to pick.
       */
      browseWorkspaces: (path?: string) => {
        // Monotonic, and compared on arrival: two listings can be in flight at
        // once if the user taps quickly, and only the newest may render.
        const requestId = `ws_${++browseCounter.current}`;
        browseRequest.current = requestId;

        const sent = post({ t: "workspaces", requestId, path });
        setState((s) => ({
          ...s,
          browse: {
            // The previous listing is kept underneath the spinner rather than
            // cleared: blanking the list on every tap makes the picker flash
            // empty between levels.
            path: path ?? s.browse?.path,
            parent: s.browse?.parent,
            entries: s.browse?.entries ?? [],
            loading: sent,
            // Not a refusal — the request never reached the daemon. The picker
            // shows the offline case from `status`, which is already on screen.
            refused: false,
          },
        }));
      },

      /** Choose which agent the composer targets. Ends any open session. */
      select: (providerId: string) => {
        sessionRef.current = undefined;
        viewingRef.current = undefined;
        // Choosing an agent ends the open session, so a reopen still in flight
        // has nothing left to come back to. Same reasoning as `leave`.
        awaitingResume.current = false;
        providerRef.current = providerId;
        queued.current = undefined;
        // The pictures belong to the transcript being closed, and they are the
        // largest thing this hook holds. See `imageCache.ts`.
        clearImages();
        setState((s) => ({
          ...s,
          activeProviderId: providerId,
          sessionId: undefined,
          workspace: undefined,
          // Belongs to the conversation being left: a context reading is about one
          // agent's window, and carrying it across would put the previous chat's
          // percentage beside this one's project.
          usage: undefined,
          turns: [],
          // Selectors belong to the old agent's session; keeping them would
          // show another agent's model name in the top bar. Its slash commands
          // are wrong here for the same reason.
          configOptions: [],
          commands: [],
          busy: false,
          loadingSession: false,
          activity: IDLE_ACTIVITY,
          receipt: undefined,
        }));
      },

      /**
       * Ask the daemon for an image the agent named by path.
       *
       * Idempotent by uri: the transcript is a recycling list, so the same
       * picture is mounted and unmounted repeatedly while scrolling and must
       * not re-fetch megabytes each time. A failure is remembered too — only an
       * explicit retry asks again.
       */
      fetchImage: (uri: string) => {
        if (requestedImages.current.has(uri)) return;
        requestedImages.current.add(uri);
        sendImageRequest(uri);
      },

      /** Forget a failed fetch and ask again, from the placeholder's tap. */
      retryImage: (uri: string) => {
        sendImageRequest(uri);
      },

      leave: () => {
        sessionRef.current = undefined;
        viewingRef.current = undefined;
        // Leaving is a decision about the screen, so a reopen still in flight
        // no longer has a claim on it.
        awaitingResume.current = false;
        queued.current = undefined;
        // Same reasoning as `select`: nothing on screen refers to these bytes
        // any more, and a re-opened conversation re-requests what it can see.
        clearImages();
        setState((s) => ({
          ...s,
          sessionId: undefined,
          // Belongs to the conversation being closed, so it is dropped — and the
          // nonce is what makes the effect below actually ask again. Leaving
          // changes none of its other dependencies when the project is already
          // the chosen one, which is precisely the "new chat" case.
          workspace: undefined,
          // Belongs to the conversation being left: a context reading is about one
          // agent's window, and carrying it across would put the previous chat's
          // percentage beside this one's project.
          usage: undefined,
          workspaceNonce: s.workspaceNonce + 1,
          turns: [],
          configOptions: [],
          commands: [],
          busy: false,
          loadingSession: false,
          activity: IDLE_ACTIVITY,
          receipt: undefined,
        }));
      },
    }),
    // `deviceId` identifies this phone in the ids `start` mints. It does not
    // change in practice, and listing it costs nothing if it ever does.
    [post, deliverPrompt, sendImageRequest, clearImages, deviceId],
  );

  // Give up on a conversation that is taking impossibly long to open.
  //
  // Every other spinner in this app has something that ends it: a turn ends
  // with `session.idle`, a connection ends with an open socket or a retry. The
  // resume skeleton was the exception — it ended only when the transcript
  // arrived, so if the transcript never arrived it did not end at all. That is
  // the state that had to be force-quit out of. See `stalledLoading`.
  //
  // `busy` goes with it: the two are set together on the way in, and clearing
  // only the skeleton would reveal a composer that still thought a turn was
  // running.
  useEffect(() => {
    if (!state.loadingSession) return;
    const timer = setTimeout(() => {
      setState((s) =>
        s.loadingSession
          ? {
              ...s,
              loadingSession: false,
              busy: false,
              activity: IDLE_ACTIVITY,
              turns: capTurns([...s.turns, stalledLoading(localSeq.current++)]),
            }
          : s,
      );
    }, LOADING_SESSION_TIMEOUT);
    return () => clearTimeout(timer);
    // `sessionId` restarts the clock when one conversation is opened while
    // another is still loading: without it the second would inherit whatever
    // was left of the first one's budget and could fail in a second or two.
  }, [state.loadingSession, state.sessionId]);

  // Which project the bar above the composer names.
  //
  // Driven by the session and agent on screen rather than by a one-off request:
  // opening a past conversation, switching agents or reconnecting all change
  // the answer, and each of those is exactly a change to these values. Live
  // edits are covered by the `session.idle` refresh in the socket handler, and
  // the cases that clear the row without changing any of these carry the nonce.
  const workspaceProviderId = state.activeProviderId ?? fallbackProviderId;
  // Before a session exists this is what the context row describes: the project
  // the next prompt will open in, rather than whichever one the agent happened
  // to use last. Named here rather than inline in the dependency array so the
  // one value that matters is what the effect keys on — the whole `projectPath`
  // map changes when any *other* agent's project is chosen.
  const workspaceCwd = workspaceProviderId ? state.projectPath[workspaceProviderId] : undefined;
  useEffect(() => {
    if (state.status !== "online") return;
    post({
      t: "workspace.status",
      sessionId: state.sessionId,
      providerId: workspaceProviderId,
      cwd: workspaceCwd,
    });
  }, [
    post,
    state.status,
    state.sessionId,
    workspaceProviderId,
    workspaceCwd,
    // Leaving a conversation changes none of the above when the project is
    // already the chosen one, and the row would stay empty until a prompt.
    state.workspaceNonce,
  ]);

  // Fall back to the last selectors this agent advertised, so the model picker
  // is available on an empty screen instead of only mid-conversation.
  //
  // The provider defaults the same way the UI does: before an explicit choice
  // this launch, the composer already targets the remembered agent, so the
  // selector has to describe that same agent rather than nothing.
  const effectiveProviderId = state.activeProviderId ?? fallbackProviderId;
  const configOptions = visibleConfigs({
    session: state.configOptions,
    provider: effectiveProviderId ? knownConfigs[effectiveProviderId] : undefined,
    // An open conversation is the one case where the provider's list is not the
    // answer: a restored one comes back at the selectors it was last used with,
    // which need not be the remembered ones, and they arrive a moment after the
    // session does. A guess about which model is answering is the one thing this
    // pill must never be — so it shows nothing until the session says.
    inConversation: state.sessionId !== undefined || state.loadingSession,
  });
  // The live session's own list wins; otherwise the provider's, which is what
  // agents that never send the notification rely on entirely.
  const commands =
    state.commands.length > 0
      ? state.commands
      : (effectiveProviderId ? knownCommands[effectiveProviderId] : undefined) ?? [];
  const loadingSessions = effectiveProviderId
    ? pendingCapabilities.current.has(effectiveProviderId) ||
      state.loadingProject !== undefined
    : false;

  // Fetch the chosen project's conversations.
  //
  // An effect rather than part of `selectProject` so the one rule covers a
  // reconnect too: the socket dies on every backgrounding, and a request
  // written to the dead one is never answered.
  const openProjectPath = effectiveProviderId
    ? state.projectPath[effectiveProviderId]
    : undefined;
  useEffect(() => {
    if (state.status !== "online" || !effectiveProviderId || !openProjectPath) return;
    const key = `${effectiveProviderId}:${openProjectPath}`;
    if (pendingProjectSessions.current.has(key)) return;
    pendingProjectSessions.current.add(key);
    const sent = post({
      t: "provider.sessions",
      providerId: effectiveProviderId,
      cwd: openProjectPath,
    });
    if (!sent) {
      pendingProjectSessions.current.delete(key);
      return;
    }
    setState((s) => ({ ...s, loadingProject: key }));
  }, [post, state.status, effectiveProviderId, openProjectPath]);

  return {
    ...state,
    ...actions,
    resumeNow,
    // Exported so the UI names the same agent the composer targets: the drawer
    // and top bar must not show Claude Code while a prompt would go elsewhere.
    effectiveProviderId,
    configOptions,
    commands,
    loadingSessions,
    images,
  };
}
