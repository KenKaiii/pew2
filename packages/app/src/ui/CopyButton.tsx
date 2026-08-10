/**
 * Copy some text, and say so.
 *
 * One control rather than two: a fenced code block has had this button in its
 * header since the day code blocks did, and a reply now carries the same one
 * under it. Copying is the same act in both places, so it is the same glyph,
 * the same confirmation and the same sensation — a second hand-rolled variant
 * is how two buttons a row apart end up meaning different things.
 *
 * The glyph carries it alone. The word "Copy" beside it said nothing the icon
 * did not, and it said it under every reply in the transcript: a column of
 * captions running down a screen whose whole job is reading the agent's text.
 * The state changes are what the label was really for, and those are legible as
 * shape — a tick, or an alert in the danger colour.
 *
 * So the confirmation is the button itself. There is no toast in this app, and
 * the press lands under a finger that is covering the glyph, so the haptic
 * fires on the *result*: success and failure are told apart by feel before
 * either is seen. It reverts on its own — nothing here is a state the user has
 * to dismiss.
 *
 * The words are not gone, only unpainted: the label names the button to
 * VoiceOver and the state is announced as its value, so what a sighted user
 * reads as a tick is heard as "Copied".
 */
import { useEffect, useState } from "react";
import Ionicons from "@expo/vector-icons/Ionicons";
import * as Clipboard from "expo-clipboard";
import { Pressable, StyleSheet, type StyleProp, type ViewStyle } from "react-native";
import { theme } from "../theme";
import { writeToClipboard } from "./clipboard";
import { touchSlop } from "./controls";
import { haptics } from "./haptics";

type CopyState = "idle" | "copied" | "failed";

/** How long the confirmation holds. Long enough to read, short enough to forget. */
const REVERT_DELAY = 1800;

/** Spoken, never drawn. The visible half of each state is its glyph. */
const SPOKEN: Record<CopyState, string> = {
  idle: "Copy",
  copied: "Copied",
  failed: "Couldn't copy",
};

/**
 * The button's own square, and the unit the action row is spaced on.
 *
 * Small deliberately. This is a footnote under a reply, not a call to action:
 * it repeats under every agent message in the transcript, so at any weight that
 * demanded attention it would become a column of controls running down a screen
 * whose entire job is reading text. The glyph is legible; the box is quiet; the
 * touch target is neither, and comes from `hitSlop` instead.
 */
export const ACTION_SIZE = 28;

/** Glyph inset inside that square, for aligning the row to the text rail. */
export const ACTION_INSET = (ACTION_SIZE - 16) / 2;

const ICONS: Record<CopyState, keyof typeof Ionicons.glyphMap> = {
  idle: "copy-outline",
  copied: "checkmark",
  failed: "alert-circle-outline",
};

export function CopyButton({
  text,
  accessibilityLabel,
  style,
}: {
  /** Exactly what lands on the clipboard — the source, not the rendering. */
  text: string;
  accessibilityLabel: string;
  /** Placement only. The button's own shape is not a call-site decision. */
  style?: StyleProp<ViewStyle>;
}) {
  const [state, setState] = useState<CopyState>("idle");

  useEffect(() => {
    if (state === "idle") return undefined;
    const revert = setTimeout(() => setState("idle"), REVERT_DELAY);
    return () => clearTimeout(revert);
  }, [state]);

  // Transcript cells are recycled, so this component instance outlives the
  // message it was mounted for: without this, a confirmation could be inherited
  // by whatever turn scrolls into the cell next, claiming a copy that never
  // happened. Also covers the same button being re-pointed mid-stream.
  useEffect(() => {
    setState("idle");
  }, [text]);

  const copy = async () => {
    const copied = await writeToClipboard(text, Clipboard.setStringAsync);
    if (copied) haptics.finished();
    else haptics.failed();
    setState(copied ? "copied" : "failed");
  };

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      // Announces the confirmation to VoiceOver, which is where the whole of
      // the visible feedback — one glyph swapping for another — says nothing.
      accessibilityValue={{ text: SPOKEN[state] }}
      // The glyph is well under the platform minimum, so the target is grown
      // rather than the button: an icon this small is a miss otherwise.
      hitSlop={touchSlop(ACTION_SIZE)}
      onPress={() => void copy()}
      style={({ pressed }) => [styles.button, pressed && styles.pressed, style]}
    >
      <Ionicons
        name={ICONS[state]}
        // A shade larger than it was beside a word: alone, the glyph is the
        // entire control and has to be readable as one.
        size={16}
        // Confirmation is the one state that brightens, and it is the only
        // moment this button is worth looking at. At rest it sits at the
        // transcript's faintest text colour: present when looked for, invisible
        // when reading past. Never the accent — nothing here is a primary
        // action.
        color={
          state === "failed"
            ? theme.color.danger
            : state === "copied"
              ? theme.color.text
              : theme.color.textFaint
        }
      />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    width: ACTION_SIZE,
    height: ACTION_SIZE,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.radius.sm,
  },
  pressed: { backgroundColor: theme.color.surfacePressed },
});
