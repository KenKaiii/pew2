/**
 * QR scanning for pairing.
 *
 * The app only ever *reads* codes. The pairing token belongs to the desktop —
 * that machine mints it and prints it — so the phone has nothing of its own to
 * publish. Re-displaying a received secret would only add shoulder-surf and
 * screenshot exposure for no gain.
 *
 * Camera permission is genuinely optional here: pasting a link works just as
 * well, so a refusal is offered a way forward rather than treated as an error.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { theme } from "../theme";
import { haptics } from "./haptics";

interface Props {
  visible: boolean;
  onClose: () => void;
  /** Called with the raw scanned string; the caller validates it. */
  onScan: (value: string) => void;
  /** Set when the last scan produced an invalid link, so it can be shown here. */
  error?: string | null;
}

export function QrScanner({ visible, onClose, onScan, error }: Props) {
  const insets = useSafeAreaInsets();
  const [permission, requestPermission] = useCameraPermissions();
  // The camera fires continuously while a code is in frame. Without a latch the
  // same code is delivered dozens of times and the app pairs, re-renders and
  // pairs again.
  const handled = useRef(false);
  // The last code handed to the caller, and the one it refused. A refused code
  // is skipped so the camera can stay live for a *different* one without
  // re-submitting the bad code on every frame it remains in view.
  const submitted = useRef<string | undefined>(undefined);
  const rejected = useRef<string | undefined>(undefined);
  const [torch, setTorch] = useState(false);

  const handleScan = useCallback(
    ({ data }: { data: string }) => {
      if (handled.current || data === rejected.current) return;
      handled.current = true;
      submitted.current = data;
      // The camera is held at arm's length and the sheet dismisses itself, so a
      // pulse is the clearest confirmation that the code actually registered.
      haptics.finished();
      onScan(data);
    },
    [onScan],
  );

  // A refused code leaves the sheet open so the reason can be read over the
  // camera. Without re-arming, the scanner is deaf from that moment on: the
  // user points at a corrected code and nothing happens, and only closing and
  // reopening revives it. Retry is the entire point of staying on the camera.
  useEffect(() => {
    if (!error) return;
    rejected.current = submitted.current;
    handled.current = false;
  }, [error]);

  // A retry must be able to scan the same code again, so the latch is released
  // whenever the sheet is reopened rather than only on a new code.
  const close = useCallback(() => {
    handled.current = false;
    rejected.current = undefined;
    setTorch(false);
    onClose();
  }, [onClose]);

  const granted = permission?.granted === true;

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="fullScreen"
      onShow={() => {
        handled.current = false;
        rejected.current = undefined;
      }}
      onRequestClose={close}
    >
      <View style={styles.root}>
        {granted ? (
          <CameraView
            style={StyleSheet.absoluteFill}
            facing="back"
            enableTorch={torch}
            // Only QR: narrowing the set makes recognition faster and stops a
            // barcode on a nearby package from being read as a pairing link.
            barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
            onBarcodeScanned={handleScan}
          />
        ) : null}

        {/* Sits above the camera, so it is declared after it. */}
        <View style={[styles.overlay, { paddingTop: insets.top + theme.space(2) }]}>
          <View style={styles.bar}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Cancel scanning"
              onPress={() => {
                haptics.tap();
                close();
              }}
              style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}
            >
              <Ionicons name="close" size={22} color={theme.color.text} />
            </Pressable>

            {granted ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={torch ? "Turn off torch" : "Turn on torch"}
                accessibilityState={{ selected: torch }}
                onPress={() => {
                  haptics.select();
                  setTorch((on) => !on);
                }}
                style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}
              >
                <Ionicons
                  name={torch ? "flashlight" : "flashlight-outline"}
                  size={20}
                  color={theme.color.text}
                />
              </Pressable>
            ) : null}
          </View>

          {granted ? (
            <View style={styles.centre} pointerEvents="none">
              {/* A frame, not a mask: it tells the user where to aim without
                  hiding the rest of the viewfinder. */}
              <View style={styles.reticle} />
              <Text style={styles.hint}>{error ?? "Point at the code"}</Text>
            </View>
          ) : (
            <View style={styles.centre}>
              <Ionicons name="camera-outline" size={40} color={theme.color.textFaint} />
              <Text style={styles.permissionTitle}>
                {permission?.canAskAgain === false ? "Camera is off" : "Camera needed"}
              </Text>
              <Text style={styles.permissionBody}>
                {permission?.canAskAgain === false
                  ? "Turn it on in Settings, or paste the link."
                  : "Only used to read the code."}
              </Text>
              {permission?.canAskAgain !== false ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Allow camera access"
                  onPress={() => {
                    haptics.tap();
                    void requestPermission();
                  }}
                  style={({ pressed }) => [styles.allow, pressed && styles.pressed]}
                >
                  <Text style={styles.allowText}>Allow camera</Text>
                </Pressable>
              ) : null}
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Paste the link instead"
                onPress={() => {
                  haptics.tap();
                  close();
                }}
                style={({ pressed }) => [styles.secondary, pressed && styles.pressed]}
              >
                <Text style={styles.secondaryText}>Paste a link</Text>
              </Pressable>
            </View>
          )}
        </View>
      </View>
    </Modal>
  );
}

const RETICLE = 240;

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#000" },
  overlay: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: theme.gutter,
  },
  bar: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  iconButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
    // Legible over an arbitrary camera image, which may be any brightness.
    backgroundColor: "rgba(0,0,0,0.55)",
  },
  pressed: { opacity: 0.6 },
  centre: { flex: 1, alignItems: "center", justifyContent: "center", gap: theme.space(4) },
  reticle: {
    width: RETICLE,
    height: RETICLE,
    borderRadius: 24,
    borderWidth: 2,
    borderColor: "rgba(255,255,255,0.9)",
  },
  hint: {
    color: "#fff",
    fontSize: 15,
    textAlign: "center",
    paddingHorizontal: theme.space(6),
    paddingVertical: theme.space(2),
    backgroundColor: "rgba(0,0,0,0.55)",
    borderRadius: 10,
    overflow: "hidden",
  },
  permissionTitle: {
    color: theme.color.text,
    fontFamily: theme.display.semibold,
    fontSize: 18,
    letterSpacing: 0.4,
  },
  permissionBody: {
    color: theme.color.textDim,
    fontSize: 15,
    lineHeight: 21,
    textAlign: "center",
    paddingHorizontal: theme.space(4),
  },
  allow: {
    backgroundColor: theme.color.surfaceRaised,
    borderRadius: 12,
    paddingVertical: theme.space(3.5),
    paddingHorizontal: theme.space(8),
  },
  allowText: { color: theme.color.text, fontSize: 16, fontWeight: "600" },
  secondary: { paddingVertical: theme.space(2) },
  secondaryText: { color: theme.color.textFaint, fontSize: 15 },
});
