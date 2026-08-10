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
import { memo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import { theme } from "../theme";
import { MarkdownText } from "./MarkdownText";
import { ChatImages } from "./ChatImage";
import { CommandToken } from "./CommandToken";
import { ACTION_INSET, ACTION_SIZE, CopyButton } from "./CopyButton";
import { messageCopyIsDuplicate } from "./messageActions";
import { splitCommand } from "../slashCommands";
import { touchSlop } from "./controls";
import { haptics } from "./haptics";
import {
  adaptiveUserBubbleStyle,
  blockUserBubbleStyle,
  userPromptNeedsFullWidth,
} from "./messageLayoutStyles";
import type { Turn as TurnModel } from "../useDaemon";

/**
 * The retry button's square.
 *
 * A size up from the message actions, and the one control here that keeps its
 * chrome. Everything else under a turn is a footnote on a reply; this is the
 * only thing to do about a turn that failed, and it sits under an error rather
 * than under an answer.
 */
const RETRY_SIZE = ACTION_SIZE + theme.space(1.5);

interface TurnProps {
  turn: TurnModel;
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
 * Nothing here does it. Message text is rendered `selectable` (`MarkdownText`),
 * so the gesture is the platform's own: hold to get Android's selection handles
 * and its action bar, hold to get the iOS edit menu over that block.
 *
 * It used to be ours. Every turn was wrapped in a `Pressable` whose long press
 * opened a sheet holding the whole message as one selectable node, because iOS
 * cannot drag a selection across separate `Text` nodes and a rendered reply is
 * dozens of them. The sheet did buy whole-message selection — and cost the
 * gesture every other app has: a hold anywhere in the transcript stopped
 * meaning "select this" and started meaning "open a modal", including over a
 * code block, whose own loupe it took away. Copying by block is the smaller
 * loss, and it is the behaviour nobody has to be taught.
 *
 * The wrapper is gone rather than merely muted, which matters twice:
 *
 * - A `Pressable` claims the touch, and messages cover nearly the whole
 *   transcript, so it also had to re-implement the blur that tapping away from
 *   the composer used to do for free. With plain views, the list's own
 *   `keyboardShouldPersistTaps="handled"` sees an unclaimed tap and blurs.
 * - A `Pressable` is `accessible` by default, and that flag *groups*: it would
 *   collapse a long reply — headings, paragraphs, list items, code — into one
 *   unstoppable VoiceOver utterance. It carried `accessible={false}` to avoid
 *   exactly that, and with the wrapper gone the exemption is no longer needed:
 *   the transcript is navigable a block at a time because it is just text.
 *
 * What the platform gesture does *not* give is the whole message: iOS cannot
 * drag a selection across separate `Text` nodes, so holding a reply reaches one
 * paragraph of it. That is what the Copy button under an agent turn is for —
 * a button, not a hold, so it takes nothing away from the gesture above it.
 */
function TurnView({ turn, onOpenThought, retryPrompt, onRetry }: TurnProps) {
  const images = turn.images ?? [];
  // A turn with pictures and no words is normal: an image generation tool's
  // result arrives as content alone. Only a turn with neither renders nothing.
  if (!turn.text.trim() && images.length === 0) return null;
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

  if (turn.role === "system") {
    return (
      <View style={styles.systemRow}>
        {hasText && <MarkdownText text={text} tone="system" />}
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
            {/* Keeps its border where the copy button has none: this one sits
                under an error rather than under a reply, and has to read as
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
            // No long press of its own: the sheet it opens renders the
            // reasoning as selectable text like any other message, so holding
            // the row would only be a second, worse way to reach the same
            // text.
            disabled={!onOpenThought}
            accessibilityRole="button"
            accessibilityLabel="Show thought process"
            hitSlop={touchSlop(theme.space(1.5))}
            style={({ pressed }) => [styles.thoughtToggle, pressed && styles.thoughtPressed]}
          >
            <Text style={styles.thoughtLabel}>Thought process</Text>
            <Ionicons name="chevron-forward" size={13} color={theme.color.textDim} />
          </Pressable>
        )}
        <ChatImages images={images} />
      </View>
    );
  }

  return (
    <View style={styles.agentRow}>
      {hasText && <MarkdownText text={text} />}
      <ChatImages images={images} />
      {/* A row rather than a lone button, because that is the shape this ends
          up as: one small faint glyph per thing you can do with a reply, on the
          text's own left rail, at a fixed pitch. Today it holds copy — the only
          way to take a whole reply, since the platform's hold selects one block
          and a rendered answer is dozens of them. Anything added later lands
          beside it at the same size and spacing instead of inventing its own.

          Always drawn rather than revealed on hover, because a touch screen has
          no hover, and last in the turn so it never sits between the reader and
          the text — except when the reply *is* a code block, which carries this
          button in its own header already and would otherwise be followed by a
          second one copying the identical string. */}
      {hasText && !messageCopyIsDuplicate(text) && (
        <View style={styles.actions}>
          <CopyButton text={text} accessibilityLabel="Copy message" />
        </View>
      )}
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
    // The one flag that is drawn: without it the label would outlive the
    // message going out, which is the moment it stops being true.
    before.turn.queued === after.turn.queued &&
    // Identity is enough: images are only ever appended as a new array, and
    // comparing sources would walk megabytes of inline base64 per render.
    before.turn.images === after.turn.images,
);

const styles = StyleSheet.create({
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
  thoughtRow: { width: "100%", paddingHorizontal: theme.space(1), alignItems: "flex-start" },
  // A quiet marker on the agent's own rail, not a control competing with the
  // reply: no fill, no border, just a label and the affordance to open it.
  thoughtToggle: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.space(1),
    paddingVertical: theme.space(0.5),
  },
  thoughtPressed: { opacity: 0.6 },
  thoughtLabel: {
    color: theme.color.textDim,
    fontSize: theme.font.small,
    fontWeight: "600",
  },
  systemRow: { width: "100%", gap: theme.space(2) },
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
  // Pulled back by the glyph's own inset inside its box, so the first icon
  // starts exactly where the text does. Aligning the *boxes* instead leaves the
  // row visibly indented from the paragraph above it.
  //
  // The gap sets the pitch: 28 + 4 puts each glyph 32 from the last, far enough
  // apart that two adjacent icons never read as one control and their touch
  // targets stay distinguishable under a thumb.
  actions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.space(1),
    marginLeft: -ACTION_INSET,
    marginTop: theme.space(1.5),
  },
});
