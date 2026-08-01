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
import { StyleSheet, View } from "react-native";
import { theme } from "../theme";
import { MarkdownText } from "./MarkdownText";
import { ChatImages } from "./ChatImage";
import { CommandToken } from "./CommandToken";
import { splitCommand } from "../slashCommands";
import {
  adaptiveUserBubbleStyle,
  blockUserBubbleStyle,
  userPromptNeedsFullWidth,
} from "./messageLayoutStyles";
import type { Turn as TurnModel } from "../useDaemon";

function TurnView({ turn }: { turn: TurnModel }) {
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
      </View>
    );
  }

  if (turn.role === "system") {
    return (
      <View style={styles.systemRow}>
        {hasText && <MarkdownText text={text} tone="system" />}
        <ChatImages images={images} />
      </View>
    );
  }

  if (turn.role === "thought") {
    return (
      <View style={styles.thoughtRow}>
        {hasText && <MarkdownText text={text} tone="thought" />}
        <ChatImages images={images} />
      </View>
    );
  }

  return (
    <View style={styles.agentRow}>
      {hasText && <MarkdownText text={text} />}
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
    before.turn.text === after.turn.text &&
    before.turn.role === after.turn.role &&
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
  // Stacked rather than inline: instructions are markdown and may run to
  // several lines, which would not wrap cleanly beside the token.
  commandPrompt: { gap: theme.space(1) },
  agentRow: { width: "100%" },
  thoughtRow: { width: "100%", paddingHorizontal: theme.space(1) },
  systemRow: { width: "100%" },
});
