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
import Ionicons from "@expo/vector-icons/Ionicons";
import { theme } from "../theme";
import { haptics } from "./haptics";
import { parsePairing, type Pairing } from "../pairingLink";
import { deviceId } from "../pairing";
import { QrScanner } from "./QrScanner";
import { CircleButton } from "./controls";
import { Glass } from "./Glass";
import { verifyPairing } from "../verifyPairing";

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

    // Shape is not proof. A retired token parses exactly like a live one, and
    // storing it here used to send the user to the main screen to watch
    // "Connecting to your machine..." forever — a permanent failure wearing the
    // costume of a slow network. Both refusals happen below the WebSocket (401
    // from the daemon, 409 from the relay for a room with no machine in it), so
    // the only way to know is to complete a handshake.
    const verified = await verifyPairing(result.pairing);
    if (!verified.ok) return verified.message;

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
    // Checking the code is a round trip, and the scanner latches after a read,
    // so without this the camera sits frozen for seconds with nothing said.
    setBusy(true);
    const failure = await accept(value);
    setBusy(false);
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
          <CircleButton label="Back" size={theme.size.touch} onPress={onBack}>
            <Ionicons name="chevron-back" size={24} color={theme.color.text} />
          </CircleButton>
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
          <Glass radius={theme.radius.lg} interactive>
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
          </Glass>

          <View style={styles.orRow}>
            <View style={styles.rule} />
            <Text style={styles.orText}>or paste it</Text>
            <View style={styles.rule} />
          </View>
        </>
      ) : null}

      <Text style={styles.label}>Pairing link</Text>
      <Glass
        radius={theme.radius.md}
        tier="control"
        style={[styles.inputShell, error ? styles.inputError : null]}
      >
        <TextInput
          style={styles.input}
          value={draft}
          onChangeText={(next) => {
            setDraft(next);
            // Clear on edit: leaving a stale error under a corrected link reads
            // as though the correction was rejected too.
            if (error) setError(null);
          }}
          placeholder="ws://192.168.0.10:8787/?token=[REDACTED]"
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
      </Glass>

      {error ? (
        <Text style={styles.error} accessibilityLiveRegion="polite">
          {error}
        </Text>
      ) : null}

      <Glass
        radius={theme.radius.lg}
        tier="raised"
        interactive={!busy && Boolean(draft.trim())}
        style={[styles.connectGlass, (busy || !draft.trim()) && styles.buttonDisabled]}
      >
        <Pressable
          style={({ pressed }) => [styles.button, pressed && styles.buttonPressed]}
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
      </Glass>

      <Text style={styles.footnote}>This is your password link. Keep safe.</Text>

      <QrScanner
        visible={scanning}
        error={scanError}
        busy={busy}
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

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.color.bg },
  scroll: { flex: 1 },
  content: { paddingHorizontal: theme.gutter, paddingTop: theme.space(4) },
  nav: {
    // Reserves the row even with no back button, so the title never shifts
    // upward between entry points.
    minHeight: theme.size.touch,
    justifyContent: "center",
    // This is now a full glass control, so its outer edge shares the same rail
    // as every main-screen control instead of offsetting for the bare glyph.
    paddingLeft: theme.gutter,
  },
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
  inputShell: { minHeight: 50 },
  input: {
    minHeight: 50,
    color: theme.color.text,
    fontSize: 15,
    paddingHorizontal: theme.space(4),
    paddingVertical: theme.space(3.5),
  },
  inputError: { borderWidth: 1, borderColor: theme.color.danger },
  error: {
    color: theme.color.danger,
    fontSize: 14,
    lineHeight: 20,
    marginTop: theme.space(2),
  },
  connectGlass: { marginTop: theme.space(5) },
  button: {
    paddingVertical: theme.space(4),
    alignItems: "center",
    justifyContent: "center",
    minHeight: 52,
  },
  buttonPressed: { backgroundColor: theme.glass.fillPressed },
  buttonDisabled: { opacity: 0.48 },
  buttonText: { color: theme.color.text, fontSize: 16, fontWeight: "700" },
  footnote: {
    color: theme.color.textFaint,
    fontSize: 13,
    lineHeight: 19,
    marginTop: theme.space(8),
  },
});
