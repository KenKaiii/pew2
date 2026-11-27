/**
 * One rendered turn in the thread.
 *
 * Neither side shows avatars. User prompts sit in one quiet raised surface that
 * hugs their content; agent output uses the full reading rail like a document.
 * CommonMark is rendered with native components, including headings, emphasis,
 * lists, links, tables, images, line breaks, and contained code blocks.
 *
 * Memoized and deliberately unanimated: the thread recycles cells, so a mount
 * no longer means "a new message arrived" — a per-mount fade would fire while
 * scrolling through old history.
 */
import { Pew } from "../pew/Pew";
import { memo } from "react";
import { Keyboard, Pressable, StyleSheet, Text, View } from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import { theme } from "../theme";
import { MarkdownText } from "./MarkdownText";
import { ChatImages } from "./ChatImage";
import { CommandToken } from "./CommandToken";
import { MessageTextContext, openCopyMenu } from "./copyMenu";
import { splitCommand } from "../slashCommands";
import { isEmptyTurn } from "../chunks";
import { touchSlop } from "./controls";
import { haptics } from "./haptics";
import { Led } from "./stage/Led";
import {
  adaptiveUserBubbleStyle,
  blockUserBubbleStyle,
  userPromptNeedsFullWidth,
} from "./messageLayoutStyles";
import type { Turn as TurnModel } from "../useDaemon";

/**
 * The retry button's square.
 *
 * A size up from the old message actions, and the one control here that keeps its
 * chrome. Everything else under a turn is a footnote on a reply; this is the
 * only thing to do about a turn that failed, and it sits under an error rather
 * than under an answer.
 */
const RETRY_SIZE = 28 + theme.space(1.5);

interface TurnProps {
  turn: TurnModel;
  liveIdentity?: string;
  /** Opens this turn's reasoning in the thought sheet. */
  onOpenThought?: (text: string) => void;
  /**
   * The prompt to send again, on the failed turn at the end of the thread.
   * Absent on every other turn: `retryTarget` decides which one, and why.
   */
  retryPrompt?: string;
  /** Sends it. Must be stable: cells memo on it. */
  onRetry?: (text: string) => void;
}

/**
 * ## Taking text out of a message
 *
 * Holding any message opens the copy menu (`copyMenu.ts`): "Copy" takes the
 * text exactly as displayed, markdown kept; inside a fenced block "Copy code"
 * takes just the block. There are no copy buttons and the text is not
 * natively selectable, since that would fight the hold.
 *
 * A `Pressable` per turn rather than a gesture over the list, so FlashList
 * keeps its scroll — a drag cancels the press. It claims the touch, so a tap
 * dismisses the keyboard itself (the list's `keyboardShouldPersistTaps` no
 * longer sees it unclaimed), and it is `accessible={false}` so VoiceOver reads
 * a reply a block at a time instead of as one grouped utterance.
 */
function TurnView(props: TurnProps) {
  const text = props.turn.text.trimEnd();
  if (isEmptyTurn(props.turn)) return null;
  return (
    <MessageTextContext.Provider value={text}>
      <Pressable
        accessible={false}
        onPress={Keyboard.dismiss}
        delayLongPress={350}
        onLongPress={() => openCopyMenu(text)}
      >
        <TurnBody {...props} />
      </Pressable>
    </MessageTextContext.Provider>
  );
}

function TurnBody({ turn, onOpenThought, retryPrompt, onRetry, liveIdentity }: TurnProps) {
  const images = turn.images ?? [];
  // A turn with pictures and no words is normal: an image generation tool's
  // result arrives as content alone. Only a turn with neither renders nothing.
  if (isEmptyTurn(turn)) return null;
  // Preserve leading indentation: CommonMark uses it for indented code blocks.
  const text = turn.text.trimEnd();
  const hasText = text.trim().length > 0;

  if (turn.role === "user") {
    // A sent command keeps the same treatment it had in the composer, so the
    // thread confirms what was run rather than restating it as plain prose.
    const command = splitCommand(text, { settled: true });
    const instructions = command?.rest.replace(/^ /, "") ?? "";

    return (
      <View style={styles.userRow}>
        <View
          style={[
            styles.userBubble,
            // Pictures need the same definite rail block markdown does: the
            // bubble otherwise hugs its text, and a percentage-width image
            // inside it resolves against an intrinsic width — invisible when
            // the prompt is an image and nothing else.
            (images.length > 0 || userPromptNeedsFullWidth(text)) && blockUserBubbleStyle,
          ]}
        >
          {command ? (
            <View style={styles.commandPrompt}>
              <CommandToken text={command.command} />
              {/* Only when something was actually typed after it: an empty line
                  would leave the bubble padded for text that is not there. */}
              {!!instructions && <MarkdownText text={instructions} />}
            </View>
          ) : (
            hasText && <MarkdownText text={text} />
          )}
          <ChatImages images={images} />
        </View>
        {/* A message typed with no signal. Shown as what it is — sent, waiting
            on the network — rather than as an error, because nothing has
            failed: the reconnect delivers it. Under the bubble and quiet, so a
            thread queued up offline reads as a conversation rather than as a
            column of warnings. */}
        {turn.queued && (
          <View style={styles.queuedRow}>
            <Ionicons name="time-outline" size={12} color={theme.color.textDim} />
            <Text style={styles.queuedLabel}>Sends when you're back online</Text>
          </View>
        )}
      </View>
    );
  }

  if (turn.role === "ken") {
    return (
      <View style={styles.kenBubble}>
        <Text style={styles.kenLabel}>
          Ken{turn.ken?.round !== undefined ? ` · round ${turn.ken.round}` : ""}
        </Text>
        {hasText && <MarkdownText text={text} />}
      </View>
    );
  }

  if (turn.role === "note" && turn.task) {
    // GG Coder's task row: "Task:" muted, then the title, left-aligned above the run.
    return (
      <Text style={styles.taskRow} accessibilityRole="header">
        <Text style={styles.taskLabel}>Task: </Text>
        {turn.task}
      </Text>
    );
  }

  if (turn.role === "note") {
    return (
      <View style={styles.noteRow} accessibilityRole="text">
        <View style={styles.noteRule} />
        <Text style={styles.noteText}>{text}</Text>
        <View style={styles.noteRule} />
      </View>
    );
  }

  if (turn.role === "system") {
    return (
      <View style={styles.systemRow}>
        {hasText && (
          <View style={styles.systemError}>
            <Pew size={28} mood="oops" style={styles.pew} />
            <View style={styles.systemText}>
              <MarkdownText text={text} tone="system" />
            </View>
          </View>
        )}
        <ChatImages images={images} />
        {/* The way out of a failure. Without it the recovery from a rejected
            turn is retyping the prompt on a phone, from memory, with the
            original still on screen a row above. Only ever on the last turn —
            see `retryTarget`. */}
        {retryPrompt !== undefined && onRetry !== undefined && (
          <Pressable
            onPress={() => {
              haptics.sent();
              onRetry(retryPrompt);
            }}
            accessibilityRole="button"
            // The whole of the control's name, since nothing beside the glyph
            // says it. "Again" would be ambiguous read aloud after an error.
            accessibilityLabel="Send this message again"
            hitSlop={touchSlop(RETRY_SIZE)}
            style={({ pressed }) => [styles.retryButton, pressed && styles.retryPressed]}
          >
            {/* Keeps its border: this one sits under an error rather than
                under a reply, and has to read as
                the way out of it rather than as part of the message. */}
            <Ionicons name="refresh" size={16} color={theme.color.text} />
          </Pressable>
        )}
      </View>
    );
  }

  if (turn.role === "thought") {
    // Collapsed by default. Reasoning is several times the length of the answer
    // it precedes, so inline it turns every reply into a scroll hunt for the
    // actual response — one row that opens the full text on demand keeps the
    // transcript readable without throwing the thinking away.
    return (
      <View style={styles.thoughtRow}>
        {hasText && (
          <Pressable
            onPress={() => {
              haptics.tap();
              onOpenThought?.(text);
            }}
            delayLongPress={350}
            onLongPress={() => openCopyMenu(text)}
            disabled={!onOpenThought}
            accessibilityRole="button"
            accessibilityLabel="Show thought process"
            hitSlop={touchSlop(theme.space(1.5))}
            style={({ pressed }) => [styles.thoughtToggle, pressed && styles.thoughtPressed]}
          >
            <Led tone="dim">THOUGHT ›</Led>
          </Pressable>
        )}
        <ChatImages images={images} />
      </View>
    );
  }

  return (
    <View style={styles.agentRow}>
      {hasText && <MarkdownText text={text} liveIdentity={liveIdentity} />}
      <ChatImages images={images} />
    </View>
  );
}

/**
 * Compared on what is actually drawn, not on object identity.
 *
 * A turn is replaced wholesale for reasons that change nothing on screen — most
 * visibly when an optimistic prompt adopts the server's id the moment the agent
 * connects. Shallow prop equality sees a new object there and re-parses the
 * markdown, which is the prompt appearing to render itself a second time.
 */
export const Turn = memo(
  TurnView,
  (before, after) =>
    before.onOpenThought === after.onOpenThought &&
    // Undefined on every turn but one, so this compares two undefineds for the
    // whole transcript and only changes on the tail.
    before.retryPrompt === after.retryPrompt &&
    before.onRetry === after.onRetry &&
    before.turn.text === after.turn.text &&
    before.turn.role === after.turn.role &&
    before.turn.task === after.turn.task &&
    before.turn.ken?.phase === after.turn.ken?.phase &&
    // The one flag that is drawn: without it the label would outlive the
    // message going out, which is the moment it stops being true.
    before.turn.queued === after.turn.queued &&
    // Identity is enough: images are only ever appended as a new array, and
    // comparing sources would walk megabytes of inline base64 per render.
    before.turn.images === after.turn.images,
);

const styles = StyleSheet.create({
  // Pew's globe fills the middle of its box; the rest is room to bounce,
  // so the box overhangs the old icon's footprint instead of growing the row.
  pew: { margin: -4 },
  noteRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.space(3),
    paddingVertical: theme.space(1),
  },
  taskRow: {
    color: theme.color.text,
    fontSize: theme.font.body,
    fontWeight: "600",
    paddingVertical: theme.space(1),
  },
  taskLabel: { color: theme.color.textDim, fontWeight: "400" },
  noteRule: { flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: theme.color.border },
  noteText: {
    color: theme.color.textDim,
    fontSize: theme.font.small,
    flexShrink: 1,
    textAlign: "center",
  },
  kenBubble: {
    flex: 1,
    gap: theme.space(1),
    backgroundColor: theme.color.surface,
    borderRadius: theme.radius.md,
    paddingHorizontal: theme.space(3),
    paddingVertical: theme.space(2),
  },
  kenLabel: { color: theme.color.textDim, fontSize: theme.font.tiny, fontWeight: "600" },
  userRow: { width: "100%", minWidth: 0, alignItems: "flex-end" },
  userBubble: {
    ...adaptiveUserBubbleStyle,
    backgroundColor: theme.color.surfaceRaised,
    borderRadius: theme.radius.lg,
    paddingHorizontal: theme.space(3.5),
    paddingVertical: theme.space(2.75),
  },
  queuedRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.space(1),
    paddingTop: theme.space(1),
    paddingRight: theme.space(1),
  },
  queuedLabel: { color: theme.color.textDim, fontSize: theme.font.small },
  // Stacked rather than inline: instructions are markdown and may run to
  // several lines, which would not wrap cleanly beside the token.
  commandPrompt: { gap: theme.space(1) },
  agentRow: { width: "100%" },
  thoughtRow: { width: "100%", alignItems: "flex-start" },
  // A quiet marker on the agent's own rail, not a control competing with the
  // reply: no fill, no border, just a label and the affordance to open it.
  thoughtToggle: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.space(1),
    paddingVertical: theme.space(0.5),
  },
  thoughtPressed: { opacity: 0.6 },
  systemRow: { width: "100%", gap: theme.space(2) },
  systemError: { flexDirection: "row", alignItems: "flex-start", gap: theme.space(2) },
  systemText: { flex: 1 },
  // Reads as a control rather than as more of the error text: the failure is
  // the app talking, and this is the one thing to do about it.
  retryButton: {
    alignSelf: "flex-start",
    width: RETRY_SIZE,
    height: RETRY_SIZE,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: RETRY_SIZE / 2,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.color.border,
    backgroundColor: theme.color.surfaceRaised,
  },
  retryPressed: { backgroundColor: theme.color.surfacePressed },
});
