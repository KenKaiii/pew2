/**
 * The slash commands worth offering on a phone.
 *
 * Agents advertise their commands over ACP (`available_commands_update`), and
 * the list is per project: `.claude/commands`, `.gg/commands` and the agent's
 * own built-ins all land in it, so opening a different repo offers a different
 * menu. Nothing here is hard-coded per agent — the agent is the source of truth
 * and a new command file shows up without a change on this side.
 *
 * What *is* decided here is which of them make sense in this app. A remote
 * control has no terminal to quit and no REPL to clear, and some commands
 * duplicate a control the UI already owns. Offering those is worse than
 * offering nothing: the user taps `/model`, the daemon opens a picker the phone
 * never renders, and the turn hangs on an answer that cannot be given.
 *
 * React-free so it can be unit tested; same split as `pairingLink.ts` and
 * `hapticsPolicy.ts`, and for the same reason — `bun test` cannot parse React
 * Native's Flow syntax.
 */

export interface SlashCommand {
  name: string;
  description: string;
  /** Placeholder for the argument the command expects, when it takes one. */
  hint?: string;
}

/**
 * Commands the app deliberately does not offer.
 *
 * Two kinds, and both are about honesty rather than taste:
 *
 * - **Owned by the UI.** `/model` and friends open an agent-side picker that
 *   the phone cannot render, while the pills in the top bar already set the
 *   same thing. Two doors to one setting, one of which is a dead end.
 * - **Meaningless remotely.** `/quit` and `/exit` end a terminal session that
 *   the user is not sitting at; `/clear` and `/help` address a REPL that has no
 *   presence here. Tapping them would either do nothing or kill the daemon's
 *   agent out from under the conversation on screen.
 *
 * Conversation and branch management belongs to the same first group: the
 * drawer starts and switches conversations, so an agent-side `/session` or
 * `/new` would fork the transcript on screen away from the one the app is
 * tracking.
 */
const HIDDEN = new Set([
  // Duplicated by the model / mode / thinking pills.
  "model",
  "models",
  "mode",
  "modes",
  "config",
  "settings",
  "output-style",
  // Owned by the drawer, which is where conversations are started and picked.
  "session",
  "sessions",
  "new",
  "resume",
  "branch",
  "branches",
  // Terminal-only, or actively destructive from a remote.
  "quit",
  "exit",
  "clear",
  "reset",
  "logout",
  "login",
  "help",
  "terminal-setup",
  "vim",
  "doctor",
  "upgrade",
  "install-github-app",
  "bug",
  "release-notes",
  "status",
]);

/** Whether the app offers this command at all. */
export function isOfferedCommand(name: string): boolean {
  return !HIDDEN.has(normalise(name));
}

function normalise(name: string): string {
  return name.trim().replace(/^\/+/, "").toLowerCase();
}

/**
 * Normalise and filter a list of commands from any source.
 *
 * Two paths deliver them — the daemon's probe (before a session exists) and the
 * session's own update — and both must apply the same rules, or the menu would
 * change contents the moment the first prompt was sent.
 */
export function offeredCommands(raw: unknown): SlashCommand[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((command: any) => typeof command?.name === "string" && command.name.trim())
    .map((command: any) => ({
      name: normalise(command.name),
      description: typeof command.description === "string" ? command.description : "",
      ...(typeof command.hint === "string"
        ? { hint: command.hint }
        : typeof command.input?.hint === "string"
          ? { hint: command.input.hint }
          : {}),
    }))
    .filter((command: SlashCommand) => isOfferedCommand(command.name));
}

/**
 * Read the command list out of an ACP `available_commands_update`.
 *
 * Returns undefined for every other payload so a caller can keep its previous
 * list: the agent sends this once and does not repeat it per turn.
 */
export function readAvailableCommands(payload: any): SlashCommand[] | undefined {
  const update = payload?.update;
  if (update?.sessionUpdate !== "available_commands_update") return undefined;
  if (!Array.isArray(update.availableCommands)) return undefined;
  return offeredCommands(update.availableCommands);
}

/**
 * The draft text for a chosen command.
 *
 * Always a trailing space, so the caret lands where extra instructions go. Even
 * a command that declares no argument usually accepts context, and a space is
 * trivially deleted — whereas its absence forces the user to type one before
 * they can add anything.
 */
export function applyCommand(command: SlashCommand): string {
  return `/${command.name} `;
}

/**
 * Split a draft into its leading command and the rest.
 *
 * Only at position zero, and only the name itself: that is exactly what the
 * agent parses as a command, so decorating anything further would promise
 * behaviour that will not happen.
 *
 * Returns undefined when there is no command, so the composer can render plain
 * text without constructing a two-part tree for every keystroke.
 *
 * @param settled Text that will not be typed into again, i.e. an already-sent
 *   turn. Such text is trimmed, so the command may end the string.
 */
export function splitCommand(
  draft: string,
  { settled = false }: { settled?: boolean } = {},
): { command: string; rest: string } | undefined {
  // A name is only a command once it is terminated. While the text is still
  // being typed that means a following space and nothing else: matching the
  // first word character would fire mid-word, and since the composer moves the
  // command into its badge and rejoins later keystrokes after a space, typing
  // `/help` would assemble the draft `/h elp` one letter at a time.
  //
  // `settled` text — a turn already sent, which arrives trimmed — may instead
  // end there, so `/commit` alone still renders as the command it ran.
  //
  // Word characters, plus the colon and hyphen that namespaced names use, e.g.
  // `minimal-claude:candy`. Anything else ends the name.
  const match = (settled ? /^\/[\w:-]+(?=\s|$)/ : /^\/[\w:-]+(?=\s)/).exec(draft);
  if (!match) return undefined;
  return { command: match[0], rest: draft.slice(match[0].length) };
}
