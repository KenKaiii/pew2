/**
 * An agent's thinking, on demand.
 *
 * Reasoning is context, not the answer: printed inline it doubles the length of
 * every turn and buries the reply the user actually came for. So the transcript
 * shows one quiet "Thought process" row and the text lives here, in the same
 * card the command picker uses — same height, same chrome — scrolled rather
 * than truncated, because a thought worth opening is worth reading in full.
 */
import { memo, useRef } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { MarkdownText } from "./MarkdownText";
import { theme } from "../theme";
import { Sheet, SHEET_CARD_HEIGHT, sheetCardStyle } from "./Sheet";

interface ThoughtSheetProps {
  visible: boolean;
  text: string;
  onClose: () => void;
}

function ThoughtSheetView({ visible, text, onClose }: ThoughtSheetProps) {
  // The closed state carries no text, so the card would empty on the first
  // frame of the exit and the sheet would slide away blank. Keep the last
  // thought until another one replaces it.
  const held = useRef(text);
  if (text) held.current = text;

  return (
    <Sheet
      visible={visible}
      title="Thought process"
      onClose={onClose}
      dismissLabel="Close thought process"
    >
      <View style={styles.card}>
        <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
          {/* The dim thinking tone it had inline, so opening it does not promote
              reasoning to the same weight as the agent's answer. */}
          <MarkdownText text={held.current.trimEnd()} tone="thought" />
        </ScrollView>
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  card: sheetCardStyle,
  // Fixed rather than hugging: a two-line thought and a two-page one should
  // open the same object, or the sheet's size becomes a surprise every time.
  scroll: { height: SHEET_CARD_HEIGHT },
  content: { padding: theme.space(4) },
});

export const ThoughtSheet = memo(ThoughtSheetView);
