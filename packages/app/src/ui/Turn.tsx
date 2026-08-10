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
import { memo, type ReactNode } from "react";
import {
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import { theme } from "../theme";
import { MarkdownText } from "./MarkdownText";
import { ChatImages } from "./ChatImage";
import { CommandToken } from "./CommandToken";
import { splitCommand } from "../slashCommands";
import { touchSlop } from "./controls";
import {
  adaptiveUserBubbleStyle,
  blockUserBubbleStyle,
  userPromptNeedsFullWidth,
} from "./messageLayoutStyles";
import type { Turn as TurnModel } from "../useDaemon";

interface TurnProps {
  turn: TurnModel;
  /** Opens this turn's reasoning in the thought sheet. */
  onOpenThought?: (text: string) => void;
  /** Opens this turn's text for copying and selection. */
  onCopyMessage?: (text: string) => void;
}

/**
 * Press and hold any message to take its text.
 *
 * A hold rather than a visible button: every turn would need one, and a copy
 * control on each of them is more chrome than transcript. Hold is where the
 * platform already puts "do something with this text", so nothing has to be
 * taught — and the sheet it opens is the discovery, since it shows both what
 * will be copied and that it can be selected by hand.
 *
 * ## Why this wrapper is not an accessibility element
 *
 * A `Pressable` is `accessible` by default, and that flag is a *grouping*: it
 * collapses everything inside into one VoiceOver node whose announcement is
 * React Native's concatenation of the children. Applied here it would turn a
 * long agent reply — headings, paragraphs, list items, code — into a single
 * unstoppable utterance, when today it is navigable a block at a time. Skimming
 * by swiping between paragraphs is *how* a screen reader reads a long answer,
 * so grouping would take the most structure away from the readers who depend on
 * it most, in exchange for one action. Not worth it: `accessible={false}` keeps
 * the transcript exactly as navigable as it was.
 *
 * The cost of that choice is the rotor. Custom actions are offered per focused
 * element, so a wrapper VoiceOver cannot focus has nowhere to hang "Copy". The
 * remaining route is VoiceOver's own double-tap-and-hold, which passes a real
 * touch to the view under the focused text and so reaches `onLongPress` here.
 * That path is untested on a device — if it turns out not to fire, the answer is
 * a focusable copy control per turn, not grouping the reply.
 *
 * The thought row keeps its rotor action, because it is already one focusable
 * button with one label and nothing inside to flatten.
 *
 * A held code block opens this sheet rather than the platform's own selection
 * loupe, which is the one thing this wrapper takes away. It is a fair trade in
 * both directions: the block keeps its own Copy button for the code alone, and
 * the sheet's text is selectable too — so selecting part of a snippet is one
 * more step, while selecting part of a *reply* becomes possible at all.
 */
function Copyable({
  text,
  onCopy,
  style,
  children,
}: {
  text: string;
  onCopy?: (text: string) => void;
  style?: StyleProp<ViewStyle>;
  children: ReactNode;
}) {
  // Without a handler this is a plain view: no press state, no accessibility
  // node wrapped around the turn, nothing to explain.
  if (!onCopy) return <View style={style}>{children}</View>;

  return (
    // See above: this must never become an accessibility element. It is a touch
    // target laid over text, not a control, and the text underneath keeps its
    // own nodes.
    <Pressable accessible={false} onLongPress={() => onCopy(text)} style={style}>
      {children}
    </Pressable>
  );
}

/** Only for the thought row, which is a single focusable button. */
const COPY_ACTIONS = [{ name: "copy", label: "Copy message" }] as const;

function TurnView({ turn, onOpenThought, onCopyMessage }: TurnProps) {
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
        <Copyable
          text={text}
          // A prompt that is only pictures has no text to take, so it gets no
          // hold either — a gesture that opens an empty sheet is worse than one
          // that is not there.
          onCopy={hasText ? onCopyMessage : undefined}
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
        </Copyable>
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
      <Copyable text={text} onCopy={hasText ? onCopyMessage : undefined} style={styles.systemRow}>
        {hasText && <MarkdownText text={text} tone="system" />}
        <ChatImages images={images} />
      </Copyable>
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
            onPress={() => onOpenThought?.(text)}
            // The reasoning is text like any other, and it is the turn people
            // most often want out of the app verbatim.
            onLongPress={onCopyMessage ? () => onCopyMessage(text) : undefined}
            disabled={!onOpenThought}
            accessibilityRole="button"
            accessibilityLabel="Show thought process"
            accessibilityActions={onCopyMessage ? COPY_ACTIONS : undefined}
            onAccessibilityAction={(event) => {
              if (event.nativeEvent.actionName === "copy") onCopyMessage?.(text);
            }}
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
    <Copyable text={text} onCopy={hasText ? onCopyMessage : undefined} style={styles.agentRow}>
      {hasText && <MarkdownText text={text} />}
      <ChatImages images={images} />
    </Copyable>
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
    before.onCopyMessage === after.onCopyMessage &&
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
  systemRow: { width: "100%" },
});
