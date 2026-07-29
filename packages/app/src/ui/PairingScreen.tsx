/**
 * The first thing a new user sees: connect this phone to a desktop.
 *
 * The whole product promise is "ask your coding agent to connect it". So this
 * screen shows the one command to run, then accepts what that command prints.
 * It deliberately does not explain ACP, providers or sessions — none of that
 * matters until there is a daemon on the other end.
 */
import { useState } from "react";
import {
  ActivityIndicator,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { theme } from "../theme";
import { haptics } from "./haptics";
import { parsePairing, type Pairing } from "../pairingLink";
import { deviceId } from "../pairing";
import { QrScanner } from "./QrScanner";

interface Props {
  onPaired: (pairing: Pairing) => void;
  /** Returns to the launch screen. Omitted when there is nowhere to go back to. */
  onBack?: () => void;
  /** Set when a previously stored pairing stopped working. */
  notice?: string;
}

export function PairingScreen({ onPaired, onBack, notice }: Props) {
  const insets = useSafeAreaInsets();
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [busy, setBusy] = useState(false);

  // Scanning needs a camera. There is no useful one on web, so offering the
  // button there would be a dead end.
  const canScan = Platform.OS === "ios" || Platform.OS === "android";

  const accept = async (value: string): Promise<string | null> => {
    // The relay refuses a connection with no device id, so it is resolved
    // before the link is stored rather than at connect time.
    const result = parsePairing(value, await deviceId());
    if (!result.ok) {
      // Validate before storing: a bad link would otherwise surface much later
      // as a socket that silently never connects.
      return result.error;
    }
    onPaired(result.pairing);
    return null;
  };

  const submit = async () => {
    setBusy(true);
    haptics.sent();
    const failure = await accept(draft);
    // Pairing is the one moment the user is asked to trust this thing, so both
    // outcomes are confirmed physically rather than by a line of text alone.
    if (failure) haptics.failed();
    else haptics.finished();
    setError(failure);
    if (failure) setBusy(false);
  };

  const handleScan = async (value: string) => {
    const failure = await accept(value);
    if (!failure) {
      setScanning(false);
      return;
    }
    haptics.failed();
    // Stay on the camera and say why, rather than dumping the user back to a
    // form with an error about a code they can no longer see.
    setScanError(failure);
    // Put the scanned text in the field too, so it can be corrected by hand if
    // the code was damaged or partly obscured.
    setDraft(value);
  };

  return (
    <View style={styles.root}>
      {/* Fixed nav bar. Outside the scroll view so back stays reachable however
          far the form is scrolled, and on the same top inset as the drawer
          header so the two agree across screens. */}
      <View style={[styles.nav, { paddingTop: insets.top + theme.headerInset }]}>
        {onBack ? (
          <Pressable
            onPress={() => {
              haptics.tap();
              onBack();
            }}
            accessibilityRole="button"
            accessibilityLabel="Back"
            hitSlop={8}
            style={({ pressed }) => [styles.back, pressed && styles.backPressed]}
          >
            <Ionicons name="chevron-back" size={24} color={theme.color.text} />
          </Pressable>
        ) : null}
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[
          styles.content,
          { paddingBottom: insets.bottom + theme.space(8) },
        ]}
        keyboardShouldPersistTaps="handled"
      >
      <Text style={styles.title}>Connect your device</Text>
      <Text style={styles.body}>Run this on your computer, then scan the code.</Text>

      <View style={styles.command}>
        <Text style={styles.commandText} selectable>
          pew2 pair
        </Text>
      </View>

      {notice ? <Text style={styles.notice}>{notice}</Text> : null}

      {canScan ? (
        <>
          <Pressable
            style={({ pressed }) => [styles.scan, pressed && styles.buttonPressed]}
            onPress={() => {
              haptics.tap();
              setScanError(null);
              setScanning(true);
            }}
            accessibilityRole="button"
            accessibilityLabel="Scan the QR code"
          >
            <Ionicons name="qr-code-outline" size={20} color={theme.color.text} />
            <Text style={styles.scanText}>Scan QR code</Text>
          </Pressable>

          <View style={styles.orRow}>
            <View style={styles.rule} />
            <Text style={styles.orText}>or paste it</Text>
            <View style={styles.rule} />
          </View>
        </>
      ) : null}

      <Text style={styles.label}>Pairing link</Text>
      <TextInput
        style={[styles.input, error ? styles.inputError : null]}
        value={draft}
        onChangeText={(next) => {
          setDraft(next);
          // Clear on edit: leaving a stale error under a corrected link reads
          // as though the correction was rejected too.
          if (error) setError(null);
        }}
        placeholder="ws://192.168.0.10:8787/?token=…"
        placeholderTextColor={theme.color.placeholder}
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="off"
        spellCheck={false}
        keyboardType="url"
        returnKeyType="go"
        onSubmitEditing={() => void submit()}
        editable={!busy}
        accessibilityLabel="Pairing link"
      />

      {error ? (
        <Text style={styles.error} accessibilityLiveRegion="polite">
          {error}
        </Text>
      ) : null}

      <Pressable
        style={({ pressed }) => [
          styles.button,
          pressed && styles.buttonPressed,
          (busy || !draft.trim()) && styles.buttonDisabled,
        ]}
        onPress={() => void submit()}
        disabled={busy || !draft.trim()}
        accessibilityRole="button"
        accessibilityLabel="Connect"
      >
        {busy ? (
          <ActivityIndicator color={theme.color.text} />
        ) : (
          <Text style={styles.buttonText}>Connect</Text>
        )}
      </Pressable>

      <Text style={styles.footnote}>This is your password link. Keep safe.</Text>

      <QrScanner
        visible={scanning}
        error={scanError}
        onScan={(value) => void handleScan(value)}
        onClose={() => {
          setScanning(false);
          // Carry the reason back to the form, so closing after a failed scan
          // does not land on a screen that looks like nothing happened.
          if (scanError) setError(scanError);
          setScanError(null);
        }}
      />
      </ScrollView>
    </View>
  );
}

/**
 * Distance from the back button's edge to the chevron's ink.
 *
 * The icon is centred in a 44pt target and its drawn glyph is far narrower, so
 * this is what has to be subtracted for the arrow to sit on the content rail.
 */
const CHEVRON_INSET = 18;

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.color.bg },
  scroll: { flex: 1 },
  content: { paddingHorizontal: theme.gutter, paddingTop: theme.space(4) },
  nav: {
    // Reserves the row even with no back button, so the title never shifts
    // upward between entry points.
    minHeight: theme.size.touch,
    justifyContent: "center",
    // Puts the chevron *glyph* on the same rail as the title, not the touch
    // target's edge. The glyph is ~8pt wide centred in a 44pt target, so the
    // box must start 18pt inside the gutter for the ink to line up. Measured
    // on device; aligning the box instead leaves the arrow visibly indented.
    paddingLeft: theme.gutter - CHEVRON_INSET,
  },
  back: {
    width: theme.size.touch,
    height: theme.size.touch,
    alignItems: "center",
    justifyContent: "center",
  },
  backPressed: { opacity: 0.5 },
  title: {
    color: theme.color.text,
    fontFamily: theme.display.semibold,
    fontSize: 28,
    // The dot-matrix face is dense at heading size; a little tracking keeps the
    // glyph grid legible rather than reading as one block.
    letterSpacing: 0.5,
    marginBottom: theme.space(3),
  },
  body: {
    color: theme.color.textDim,
    fontSize: 15,
    lineHeight: 22,
    marginBottom: theme.space(6),
  },
  command: {
    backgroundColor: theme.color.surface,
    borderColor: theme.color.border,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 12,
    paddingVertical: theme.space(4),
    paddingHorizontal: theme.space(4),
    marginBottom: theme.space(8),
  },
  commandText: {
    color: theme.color.accent,
    fontSize: 16,
    fontFamily: "Menlo",
  },
  notice: {
    color: theme.color.accent,
    fontSize: 14,
    lineHeight: 20,
    marginBottom: theme.space(5),
  },
  scan: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: theme.space(2),
    backgroundColor: theme.color.surfaceRaised,
    borderRadius: 12,
    paddingVertical: theme.space(4),
    minHeight: 52,
  },
  scanText: { color: theme.color.text, fontSize: 16, fontWeight: "600" },
  orRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.space(3),
    marginVertical: theme.space(5),
  },
  rule: { flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: theme.color.border },
  orText: { color: theme.color.textFaint, fontSize: 13 },
  label: {
    color: theme.color.textFaint,
    fontSize: 13,
    marginBottom: theme.space(2),
  },
  input: {
    backgroundColor: theme.color.surface,
    borderColor: theme.color.border,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 12,
    color: theme.color.text,
    fontSize: 15,
    paddingHorizontal: theme.space(4),
    paddingVertical: theme.space(3.5),
  },
  inputError: { borderColor: theme.color.danger },
  error: {
    color: theme.color.danger,
    fontSize: 14,
    lineHeight: 20,
    marginTop: theme.space(2),
  },
  button: {
    backgroundColor: theme.color.surfaceRaised,
    borderRadius: 12,
    marginTop: theme.space(5),
    paddingVertical: theme.space(4),
    alignItems: "center",
    justifyContent: "center",
    minHeight: 52,
  },
  buttonPressed: { backgroundColor: theme.color.surfacePressed },
  buttonDisabled: { opacity: 0.45 },
  buttonText: { color: theme.color.text, fontSize: 16, fontWeight: "600" },
  footnote: {
    color: theme.color.textFaint,
    fontSize: 13,
    lineHeight: 19,
    marginTop: theme.space(8),
  },
});
