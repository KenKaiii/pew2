/**
 * The daemon's message handling, independent of how the bytes arrived.
 *
 * There are two transports — a LAN WebSocket server and an outbound relay
 * connection — and they must behave identically. Keeping the switch here rather
 * than in either transport is what stops "works on Wi-Fi, broken over the
 * relay" from becoming a class of bug: a message type added for one is
 * automatically available to the other.
 *
 * `reply` goes to the client that asked. `broadcast` goes to every connected
 * client, which is the point of the daemon owning the log: a phone and a
 * desktop watching one session both need the update.
 */
import type { Daemon } from "./index.js";
import { humanError } from "./errors.js";
import { loadImage } from "./images.js";
import { workspaceStatus } from "./git.js";
import { resolveWorkspace } from "./workspace.js";
import { discoverRepos, listDirectory } from "./workspaces.js";
import { wire } from "@pew2/protocol";

export interface HandlerContext {
  daemon: Daemon;
  /** Send to the one client that sent this message. */
  reply: (message: unknown) => void;
  /** Send to every connected client, on every transport. */
  broadcast: (message: unknown) => void;
  /** Default working directory when a client does not name one. */
  cwd?: string;
}

/** The fields any client message may carry. Validated per case, not up front. */
interface ClientMessage {
  t?: string;
  providerId?: string;
  cwd?: string;
  sessionId?: string;
  text?: string;
  requestId?: string;
  optionId?: string;
  configId?: string;
  /** Directory to browse, for `workspaces`. Distinct from `cwd`, which names
   *  where a session runs rather than what is being looked at. */
  path?: string;
  value?: string | boolean;
  agentSessionId?: string;
  refresh?: boolean;
  uri?: string;
  attachments?: unknown;
  role?: string;
  deviceId?: string;
}

/**
 * Errors are normalised here, at the one point every transport and every
 * provider passes through, so a readable failure is a property of the daemon
 * rather than something each client has to reimplement.
 */
export function errorMessage(code: string, error: unknown) {
  return { t: "error", code, message: humanError(error) };
}

/**
 * Handle one raw frame. Never throws: a malformed message from one client must
 * not take down the transport and every other client with it.
 */
export async function handleMessage(raw: string, ctx: HandlerContext): Promise<void> {
  const { daemon, reply, broadcast } = ctx;
  // A headless daemon (launchd) has cwd `/`; an agent spawned there writes its
  // state into the filesystem root or fails trying. Resolve to somewhere real.
  const cwd = resolveWorkspace(ctx.cwd);

  let message: ClientMessage;
  try {
    message = JSON.parse(raw);
  } catch {
    reply(errorMessage("bad_json", "Message was not valid JSON"));
    return;
  }

  try {
    switch (message.t) {
      case "hello":
        // Re-announce the provider list.
        //
        // Over a direct socket the daemon sees the connection open and can push
        // it. Over the relay it cannot: the app may join minutes after the
        // daemon did, and the daemon is never told. `hello` is the only signal
        // that a client has arrived, so it is what triggers the announcement.
        // Announcing is idempotent, so doing it on both paths is harmless.
        await daemon.refreshProviders();

        // Announce the arrival to everyone else. `pew2 pair` listens for this
        // to turn "scan this" into "paired", and it belongs here rather than in
        // either transport for the same reason the rest of this switch does: a
        // phone may arrive over the relay while the CLI watches the LAN socket,
        // and both paths must produce the identical event.
        //
        // Daemons are excluded — only a client joining is news.
        if (message.role !== "daemon") {
          broadcast({
            t: "device.joined",
            deviceId: message.deviceId ?? "a device",
            at: Date.now(),
          });
        }
        break;

      case "provider.capabilities": {
        // What does this app offer right now, and what has it already been used
        // for? Both come from the agent itself, so the reply reflects the
        // installed version rather than anything baked into pew2.
        if (!message.providerId) throw new Error("providerId required");
        const providerId = message.providerId;
        const capabilities = await daemon.probeProvider(providerId, {
          refresh: message.refresh === true,
        });
        reply({ t: "provider.capabilities", providerId, ...capabilities });
        break;
      }

      case "provider.sessions": {
        // One project's conversations. Answered as a `reply` rather than a
        // broadcast: it is a menu choice on one phone, not a change to the
        // session log every client shares.
        if (!message.providerId || !message.cwd) {
          throw new Error("providerId and cwd required");
        }
        const providerId = message.providerId;
        const projectCwd = message.cwd;
        const sessions = await daemon.sessionsForProject(providerId, projectCwd);
        reply({
          t: "provider.sessions",
          providerId,
          cwd: projectCwd,
          sessions,
          // These come from the same list the probe answered from, so they are
          // reopenable on exactly the same terms.
          canResume: (await daemon.probeProvider(providerId)).canResume,
        });
        break;
      }

      case "session.resume": {
        // Reopen a conversation the agent already had on disk, including ones
        // this app never started.
        if (!message.providerId || !message.agentSessionId) {
          throw new Error("providerId and agentSessionId required");
        }
        const pending = daemon.beginResumeSession(
          message.providerId,
          message.agentSessionId,
          message.cwd ?? cwd,
        );
        broadcast({
          t: "session.started",
          sessionId: pending.sessionId,
          providerId: message.providerId,
          configOptions: [],
          resumed: true,
          // Clients list the agent's copy as a stub; this is what lets them
          // replace it with the live session instead of showing it twice.
          agentSessionId: message.agentSessionId,
        });
        // History can now stream without racing ahead of session.started.
        daemon.markStreaming(pending.sessionId);
        void pending.ready
          .then(() => {
            broadcast({
              t: "session.config",
              sessionId: pending.sessionId,
              providerId: message.providerId,
              configOptions: daemon.configOptions(pending.sessionId),
            });
            daemon.finishStreaming(pending.sessionId);
          })
          .catch((error) => {
            broadcast({
              ...errorMessage("resume_failed", error),
              sessionId: pending.sessionId,
            });
            daemon.finishStreaming(pending.sessionId);
          });
        break;
      }

      case "session.start": {
        if (!message.providerId) throw new Error("providerId required");
        // The agent's own most recent project when the app named none: a phone
        // has no file picker, and defaulting to the home directory gives the
        // agent no project to work in and no project commands to offer.
        const workspace =
          message.cwd ?? (await daemon.lastWorkspace(message.providerId)) ?? cwd;
        const sessionId = await daemon.startSession(message.providerId, workspace);
        broadcast({
          t: "session.started",
          sessionId,
          providerId: message.providerId,
          // Echoed so a client can tell its own session from one another device
          // started. Without it, every client adopts every new session.
          requestId: message.requestId,
          // Models and thinking levels come from the agent itself, so a newly
          // connected app brings its own without any mapping here.
          configOptions: daemon.configOptions(sessionId),
          // The agent's own id for this conversation. Clients merge the agent's
          // stored history into the same list, and without this the next probe
          // lists this very session again as a stub — reopening that copy is
          // what threw away the model just picked.
          agentSessionId: daemon.agentSessionId(sessionId),
        });
        // Agents can emit updates during `session/new` itself; those were held
        // back so no event ever precedes the session it belongs to.
        daemon.markLive(sessionId);
        break;
      }

      case "session.prompt": {
        if (!message.sessionId || message.text === undefined) {
          throw new Error("sessionId and text required");
        }
        // The one field here that is neither a scalar nor optional-by-default:
        // it becomes bytes on this disk, so its shape is parsed rather than
        // trusted. `storeAttachments` then re-checks the size limits.
        const attachments = wire.PromptAttachment.array()
          .default([])
          .parse(message.attachments ?? []);
        // Deliberately not awaited: a turn can run for minutes, and the client
        // is driven by streamed events rather than this reply.
        const sessionId = message.sessionId;
        daemon
          .prompt(sessionId, message.text, attachments)
          .catch((error) => reply(errorMessage("prompt_failed", error)))
          // Tell every client the turn is over, so they can stop showing a
          // working indicator. Broadcast, not reply: other devices watching this
          // session need it too.
          //
          // Carries the project and agent so a client can announce a session it
          // is not showing — the phone is usually elsewhere by the time a long
          // turn ends, and only this machine knows the path.
          .finally(() =>
            broadcast({
              t: "session.idle",
              sessionId,
              ...daemon.sessionOrigin(sessionId),
            }),
          );
        break;
      }

      case "session.cancel": {
        if (!message.sessionId) throw new Error("sessionId required");
        await daemon.cancel(message.sessionId);
        break;
      }

      // No session yet: the empty state is a real place to choose from, and a
      // conversation does not exist until the first prompt is sent. Record the
      // choice so the session this prompt creates opens with it already set,
      // instead of the change being dropped on the floor.
      case "provider.config": {
        if (!message.providerId || !message.configId || message.value === undefined) {
          throw new Error("providerId, configId and value required");
        }
        await daemon.rememberConfigOption(
          message.providerId,
          message.configId,
          message.value,
        );
        break;
      }

      case "session.config": {
        if (!message.sessionId || !message.configId || message.value === undefined) {
          throw new Error("sessionId, configId and value required");
        }
        broadcast({
          t: "session.config",
          sessionId: message.sessionId,
          configOptions: await daemon.setConfigOption(
            message.sessionId,
            message.configId,
            message.value,
          ),
        });
        break;
      }

      case "image.fetch": {
        // Only this machine can read the path the agent named. Replied to the
        // asking client rather than broadcast: it is bytes for one viewport,
        // and it never enters the session log that every client replays.
        if (!message.uri || !message.requestId) {
          throw new Error("requestId and uri required");
        }
        const uri = message.uri;
        const requestId = message.requestId;
        // The root comes from the session the daemon started, never from the
        // message: a client-supplied `cwd` would let a caller name its own
        // containment root and read anything on the machine.
        const root =
          (message.sessionId ? daemon.sessionCwd(message.sessionId) : undefined) ?? cwd;
        try {
          const image = await loadImage(uri, { cwd: root });
          reply({ t: "image", requestId, uri, ...image });
        } catch (error) {
          // A failure is part of the answer, not a transport error: the app
          // shows the reason in place of the picture instead of a blank frame.
          reply({ t: "image", requestId, uri, error: humanError(error) });
        }
        break;
      }

      case "workspace.status": {
        // The project the session is in, plus how dirty it is. Replied rather
        // than logged as a session event: it describes the machine right now,
        // so replaying it on every reconnect would only restate stale counts.
        //
        // The directory comes from the session (or the provider's last
        // project), never from the message: a client-supplied path would let a
        // caller probe any directory on this machine for its existence.
        //
        // One exception, and it is not really one: a path this daemon itself
        // announced as a project. The phone sends it back after the user picks
        // that project, so the composer can name where the next prompt will
        // land before a session exists. Nothing is learned by asking about a
        // directory the answer already listed.
        const chosen =
          message.providerId && message.cwd
            ? daemon.knownProject(message.providerId, message.cwd)
            : undefined;
        const root =
          (message.sessionId ? daemon.sessionCwd(message.sessionId) : undefined) ??
          chosen ??
          (message.providerId ? await daemon.lastWorkspace(message.providerId) : undefined) ??
          cwd;
        reply({
          t: "workspace",
          // Echoed so a client can drop an answer for a conversation it has
          // already navigated away from.
          sessionId: message.sessionId,
          ...(await workspaceStatus(root)),
        });
        break;
      }

      case "workspaces": {
        // The counterpart to `workspace` above, and the one place a client-named
        // path *is* honoured. That case refuses them because answering "does
        // this exist" for an arbitrary string is a filesystem oracle; here the
        // user is deliberately browsing, so the protection is different in kind:
        // every path is resolved through symlinks and must land inside
        // `browsableRoots()`, and anything else comes back as one flat
        // `refused` rather than a reason that would leak what is there.
        //
        // Without this an agent with no history cannot be started at all: its
        // project list is folded from its own past sessions, so a newly
        // installed agent offers nothing to pick.
        if (!message.requestId) throw new Error("requestId required");

        if (!message.path) {
          // Opening view: the good guesses. Walking down from home on a
          // touchscreen is the thing this exists to avoid.
          const suggestions = await discoverRepos();
          // Recorded so that choosing one is recognised. A browsed directory has
          // no sessions yet, so it is not a "known project", and without this the
          // composer would name the agent's previous project while working in
          // this one.
          daemon.rememberOfferedWorkspaces(suggestions.map((entry) => entry.path));
          reply({
            t: "workspaces",
            requestId: message.requestId,
            entries: suggestions,
            refused: false,
          });
          break;
        }

        const listing = await listDirectory(message.path);
        if (listing) {
          // The listed directory itself is offerable too: it is where "start
          // here" acts once the user has navigated into it.
          daemon.rememberOfferedWorkspaces([
            listing.path,
            ...listing.entries.map((entry) => entry.path),
          ]);
        }
        reply({
          t: "workspaces",
          requestId: message.requestId,
          path: listing?.path,
          parent: listing?.parent,
          entries: listing?.entries ?? [],
          refused: listing === undefined,
        });
        break;
      }

      case "session.permission": {
        if (!message.sessionId || !message.requestId || !message.optionId) {
          throw new Error("sessionId, requestId and optionId required");
        }
        daemon.answerPermission(message.sessionId, message.requestId, message.optionId);
        break;
      }

      default:
        // Its own code, not `command_failed`: an app newer than this daemon
        // asks for things it does not have yet (the workspace bar being the
        // first), and the client has to tell "you are out of date" apart from
        // "your prompt failed" — the latter belongs in the transcript, this
        // does not.
        reply(errorMessage("unknown_message", `Unknown message type '${message.t}'`));
        return;
    }
  } catch (error) {
    reply(errorMessage("command_failed", error));
  }
}
