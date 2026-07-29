/**
 * The sidebar drawer.
 *
 * Connected apps across the top, their conversations below. Switching app
 * refilters the list in place, so moving between Claude, Codex and your own app
 * is one tap and never a new screen.
 *
 * This is a push drawer: the conversation slides right to reveal it rather than
 * being covered, so the two surfaces read as one moving layout instead of a
 * modal layer. The panel itself is therefore static — App owns the motion.
 */
import { Dimensions, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { theme } from "../theme";
import { Orb } from "./Orb";
import { touchSlop } from "./controls";
import type { Provider, Session } from "../useDaemon";

export const DRAWER_WIDTH = Math.min(Dimensions.get("window").width * 0.82, 330);

interface SidebarProps {
  open: boolean;
  providers: Provider[];
  sessions: Session[];
  activeProviderId?: string;
  activeSessionId?: string;
  onSelectProvider: (id: string) => void;
  onOpenSession: (id: string) => void;
  onNewConversation: () => void;
}

export function Sidebar({
  open,
  providers,
  sessions,
  activeProviderId,
  activeSessionId,
  onSelectProvider,
  onOpenSession,
  onNewConversation,
}: SidebarProps) {
  const insets = useSafeAreaInsets();

  const visible = sessions.filter(
    (session) => !activeProviderId || session.providerId === activeProviderId,
  );

  return (
    <View
      style={[styles.panel, { width: DRAWER_WIDTH }]}
      pointerEvents={open ? "auto" : "none"}
      // Hidden from assistive tech while closed: it is still mounted, but it is
      // not on screen and must not be reachable by swipe navigation.
      accessibilityElementsHidden={!open}
      importantForAccessibility={open ? "auto" : "no-hide-descendants"}
    >
      <View style={[styles.panelInner, { paddingTop: insets.top + theme.headerInset }]}>
          <View style={styles.header}>
            <Text style={styles.headerTitle}>Connected Apps</Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="New conversation"
              hitSlop={touchSlop(theme.size.control)}
              onPress={onNewConversation}
              style={({ pressed }) => [styles.newButton, pressed && styles.pressed]}
            >
              <Ionicons name="create-outline" size={18} color={theme.color.text} />
            </Pressable>
          </View>

          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            // Without an explicit height a horizontal ScrollView stretches to
            // fill the remaining column space and pushes the history far down.
            style={styles.agentScroller}
            contentContainerStyle={styles.agentRow}
          >
            {providers.map((provider) => (
              <Pressable
                key={provider.id}
                disabled={!provider.available}
                accessibilityRole="button"
                accessibilityLabel={
                  provider.available
                    ? provider.name
                    : `${provider.name}, unavailable. ${provider.unavailableReason ?? ""}`
                }
                accessibilityState={{
                  selected: provider.id === activeProviderId,
                  disabled: !provider.available,
                }}
                onPress={() => onSelectProvider(provider.id)}
                style={({ pressed }) => [
                  styles.agentChip,
                  provider.id === activeProviderId && styles.agentChipActive,
                  pressed && provider.available && styles.pressed,
                  !provider.available && styles.chipDisabled,
                ]}
              >
                <Orb color={provider.color} size={18} />
                <Text style={styles.agentChipText} numberOfLines={1}>
                  {provider.name}
                </Text>
              </Pressable>
            ))}
          </ScrollView>

          <Text style={styles.sectionLabel}>Chat history</Text>

          <ScrollView
            style={styles.sessions}
            contentContainerStyle={styles.sessionsContent}
            showsVerticalScrollIndicator={false}
          >
            {visible.length === 0 ? (
              <Text style={styles.empty}>
                No conversations yet. Send a message to start one.
              </Text>
            ) : (
              visible.map((session) => (
                <Pressable
                  key={session.id}
                  accessibilityRole="button"
                  accessibilityLabel={session.title}
                  accessibilityState={{ selected: session.id === activeSessionId }}
                  onPress={() => onOpenSession(session.id)}
                  style={({ pressed }) => [
                    styles.session,
                    session.id === activeSessionId && styles.sessionActive,
                    pressed && styles.pressed,
                  ]}
                >
                  <Text style={styles.sessionTitle} numberOfLines={1}>
                    {session.title}
                  </Text>
                  <Text style={styles.sessionMeta}>
                    {session.turns.length} message
                    {session.turns.length === 1 ? "" : "s"}
                  </Text>
                </Pressable>
              ))
            )}
          </ScrollView>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  // The drawer is the lower layer: it stays put while the conversation slides
  // right to reveal it, so it needs no transform of its own.
  panel: {
    position: "absolute",
    top: 0,
    left: 0,
    bottom: 0,
    backgroundColor: theme.color.drawer,
  },
  panelInner: { flex: 1, paddingBottom: theme.space(4) },

  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    // Same gutter and the same row height as the conversation's top bar, so
    // the title and the hamburger beside it share one baseline.
    paddingHorizontal: theme.gutter,
    height: theme.size.control,
    marginBottom: theme.space(3),
  },
  headerTitle: {
    color: theme.color.text,
    fontSize: theme.font.title,
    fontWeight: "700",
  },
  newButton: {
    width: theme.size.control,
    height: theme.size.control,
    borderRadius: theme.size.control / 2,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.glass.control.fill,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.glass.control.rim,
  },

  agentScroller: { flexGrow: 0, height: theme.size.chip },
  agentRow: {
    paddingHorizontal: theme.gutter,
    gap: theme.space(2),
    alignItems: "center",
  },
  agentChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.space(2),
    height: theme.size.chip,
    paddingHorizontal: theme.space(3.5),
    borderRadius: theme.radius.pill,
    backgroundColor: theme.glass.control.fill,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.glass.control.rim,
  },
  agentChipActive: {
    backgroundColor: theme.glass.fillActive,
  },
  agentChipText: {
    color: theme.color.text,
    fontSize: theme.font.small,
    lineHeight: theme.font.small + 4,
    maxWidth: 140,
  },
  chipDisabled: { opacity: 0.4 },
  pressed: { opacity: 0.6 },

  sectionLabel: {
    color: theme.color.textDim,
    fontSize: theme.font.small,
    paddingHorizontal: theme.gutter,
    paddingTop: theme.space(5),
    paddingBottom: theme.space(2),
  },

  sessions: { flex: 1 },
  // The row's own inset is subtracted from the list inset so session text lands
  // on exactly the same left rail as the "Chat history" label, while the
  // selected-row highlight still extends past the text on both sides.
  sessionsContent: {
    paddingHorizontal: theme.gutter - theme.space(2),
    gap: theme.space(1),
  },
  session: {
    paddingHorizontal: theme.space(2),
    paddingVertical: theme.space(3),
    borderRadius: theme.radius.md,
    gap: 2,
  },
  sessionActive: { backgroundColor: theme.glass.control.fill },
  sessionTitle: {
    color: theme.color.text,
    fontSize: theme.font.body,
    lineHeight: theme.line.body,
  },
  sessionMeta: { color: theme.color.textDim, fontSize: theme.font.tiny },
  empty: {
    color: theme.color.textDim,
    fontSize: theme.font.small,
    lineHeight: 20,
    paddingHorizontal: theme.space(2),
    paddingTop: theme.space(2),
  },
});
