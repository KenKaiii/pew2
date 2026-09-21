import { Alert, Pressable, ScrollView, StyleSheet, Text } from "react-native";
import { Sheet, SHEET_CARD_HEIGHT } from "./Sheet";
import { PrivacyLink } from "./PrivacyLink";
import { haptics } from "./haptics";
import { theme } from "../theme";
import type { Status } from "../useDaemon";

// Same fixed desktop install/update instruction formerly shown in Sidebar.
const INSTALL_COMMAND = "curl -fsSL https://raw.githubusercontent.com/KenKaiii/pew2/main/install.sh | sh";
interface Props {
  visible: boolean;
  machineLabel: string;
  machineRemote: boolean;
  status: Status;
  update?: { latest: string; automatic: boolean };
  onClose: () => void;
  onUnpair: () => void;
}
export function ConnectionSheet({ visible, machineLabel, machineRemote, status, update, onClose, onUnpair }: Props) {
  return <Sheet visible={visible} title="Connection" onClose={onClose} dismissLabel="Close connection details">
    <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
      <Text selectable style={styles.title}>{machineLabel}</Text>
      <Text style={styles.detail}>{status === "online" ? "Connected" : status === "connecting" ? "Connecting…" : "Connection interrupted"}. {machineRemote ? "Reachable from anywhere." : "Same network only."}</Text>
      {update && (update.automatic ? <Text style={styles.detail}>Updating pew2…</Text> :
        <Pressable accessibilityRole="button" accessibilityLabel={`pew2 ${update.latest} is available for ${machineLabel}. How to update.`} style={styles.action} onPress={() => {
          haptics.tap();
          Alert.alert(`pew2 ${update.latest} is available`, `This computer can't update itself, so run this on ${machineLabel}:\n\n${INSTALL_COMMAND}`, [{ text: "OK" }]);
        }}><Text style={styles.actionText}>New pew2 version available</Text></Pressable>)}
      <PrivacyLink />
      <Pressable accessibilityRole="button" accessibilityLabel={`Forget pairing with ${machineLabel}`} style={styles.action} onPress={() => {
        haptics.tap();
        Alert.alert("Forget this computer?", "You'll need to scan or paste its pairing link to connect again.", [
          { text: "Cancel", style: "cancel" },
          { text: "Forget", style: "destructive", onPress: () => { haptics.warned(); onUnpair(); } },
        ]);
      }}><Text style={styles.destructive}>Forget this computer</Text></Pressable>
    </ScrollView>
  </Sheet>;
}
const styles = StyleSheet.create({
  scroll: { maxHeight: SHEET_CARD_HEIGHT },
  content: { paddingHorizontal: theme.gutter, paddingVertical: theme.sectionGap, gap: theme.sectionGap },
  title: { color: theme.color.text, fontSize: theme.font.title, lineHeight: theme.line.body },
  detail: { color: theme.color.textDim, fontSize: theme.font.body, lineHeight: theme.line.body },
  action: { minHeight: theme.size.touch, justifyContent: "center" },
  actionText: { color: theme.color.text, fontSize: theme.font.body, lineHeight: 20 },
  destructive: { color: theme.color.danger, fontSize: theme.font.body, lineHeight: 20 },
});
