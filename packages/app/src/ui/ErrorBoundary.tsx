/**
 * The last thing standing between a render crash and a blank screen.
 *
 * React unmounts the whole tree when a render throws. Without a boundary the
 * app becomes a black rectangle: nothing to read, nothing to tap, and nothing a
 * tester can put in a bug report beyond "it broke". That is the worst possible
 * feedback loop for a build going to people who cannot attach a debugger.
 *
 * So this shows what happened and offers the one action that actually recovers
 * a bad render — try again. The error text is on screen rather than only in a
 * log, because the person hitting it is holding a phone, not a terminal.
 *
 * Deliberately not a crash *reporter*. Sending diagnostics off this device would
 * mean shipping prompts and file paths to a third party, which is the opposite
 * of what the encryption work was for. If reporting is ever added it should be
 * opt-in and say exactly what it sends.
 *
 * It also uses only system fonts. The app's display family is loaded at runtime
 * by `useFonts`, and naming an unloaded family on iOS silently falls back — so a
 * crash that happened *during* font loading would render this screen in the
 * wrong metrics, or not at all. A last resort cannot depend on something that
 * may be the thing that broke.
 */
import { Component, type ReactNode } from "react";
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { theme } from "../theme";

interface Props {
  children: ReactNode;
}

interface State {
  error?: Error;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = {};

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error) {
    // Also to the console, so `expo start` shows it during development. The
    // on-screen copy is for everyone who has no console attached.
    console.error("[pew2] render crashed:", error);
  }

  private reset = () => this.setState({ error: undefined });

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <View style={styles.screen}>
        <Text style={styles.title}>pew2 hit a problem</Text>
        <Text style={styles.body}>
          Something in the app failed to draw. Trying again usually works; if it keeps
          happening, this message is worth reporting.
        </Text>

        {/* Scrollable: a stack is long, and truncating it removes the only part
            that makes the report useful. */}
        <ScrollView style={styles.detail} contentContainerStyle={styles.detailContent}>
          <Text style={styles.detailText} selectable>
            {error.message}
            {error.stack ? `\n\n${error.stack}` : ""}
          </Text>
        </ScrollView>

        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Try again"
          onPress={this.reset}
          style={({ pressed }) => [styles.button, pressed && styles.buttonPressed]}
        >
          <Text style={styles.buttonText}>Try again</Text>
        </Pressable>
      </View>
    );
  }
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: theme.color.bg,
    padding: theme.space(5),
    justifyContent: "center",
    gap: theme.space(4),
  },
  title: { color: theme.color.text, fontSize: theme.font.greeting, fontWeight: "600" },
  body: { color: theme.color.textDim, fontSize: theme.font.body, lineHeight: theme.line.body },
  detail: {
    maxHeight: 220,
    backgroundColor: theme.color.surface,
    borderRadius: theme.radius.md,
  },
  detailContent: { padding: theme.space(3) },
  // Monospace: this is a stack trace, and proportional text makes one unreadable.
  detailText: {
    color: theme.color.textDim,
    fontSize: theme.font.tiny,
    // System monospace, always present. A stack trace in a proportional face is
    // materially harder to read, and this is the part worth reporting.
    fontFamily: Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" }),
  },
  button: {
    backgroundColor: theme.color.accent,
    borderRadius: theme.radius.pill,
    paddingVertical: theme.space(3),
    alignItems: "center",
  },
  buttonPressed: { opacity: 0.85 },
  buttonText: { color: "#ffffff", fontSize: theme.font.body, fontWeight: "600" },
});
