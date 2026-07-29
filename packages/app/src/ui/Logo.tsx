/**
 * The pew2 mark.
 *
 * Deliberately not a new invention: the orb already means "an agent is here"
 * everywhere else in the app, so the brand mark is that same sphere rather than
 * an abstract logo that appears once and is never seen again. In accent rather
 * than a provider colour, because at launch no agent has been chosen yet.
 *
 * The wordmark is lowercase to match how the command is typed.
 */
import { StyleSheet, Text, View } from "react-native";
import { Orb } from "./Orb";
import { theme } from "../theme";

interface LogoProps {
  /** Diameter of the orb. The wordmark scales with it. */
  size?: number;
}

export function Logo({ size = 72 }: LogoProps) {
  return (
    <View
      style={styles.root}
      accessible
      accessibilityRole="image"
      accessibilityLabel="pew2"
    >
      <Orb color={theme.color.accent} size={size} />
      <Text
        style={[
          styles.word,
          {
            fontSize: size * 0.5,
            letterSpacing: size * 0.02,
            // Bitcount's side bearings are asymmetric: the glyph run sits left
            // of its own text box, so centring the box leaves the wordmark
            // visibly off the orb above it. Measured at 4.3pt on a 72pt mark.
            //
            // A margin on a centred child shifts it by half its value, hence
            // double the correction. Expressed as a ratio because bearings
            // scale with font size.
            marginLeft: size * 0.12,
          },
        ]}
        // The mark is already labelled, so the text must not be read twice.
        accessibilityElementsHidden
        importantForAccessibility="no"
      >
        pew2
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { alignItems: "center", gap: theme.space(5) },
  word: {
    color: theme.color.text,
    // The wordmark is the purest expression of the display face, so it uses the
    // same family as every other title rather than a bespoke treatment.
    fontFamily: theme.display.semibold,
  },
});
