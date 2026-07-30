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
import { Dimensions, FlatList, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { theme } from "../theme";
import { Orb } from "./Orb";
import { touchSlop } from "./controls";
import { haptics } from "./haptics";
import { HistorySkeleton } from "./Skeleton";
import { orderProvidersByRecency } from "../providerRecency";
import { folderName } from "../projectFolder";
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
  /** Host and port of the paired machine. Never the token. */
  machineLabel: string;
  /** True when reached via a relay, so it works away from home. */
  machineRemote: boolean;
  onUnpair: () => void;
  /**
   * Agents are still answering what conversations they hold. Without this the
   * drawer claims "No conversations yet" for the first seconds after connect —
   * a false empty state on machines with plenty of history.
   */
  historyLoading?: boolean;
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
  machineLabel,
  machineRemote,
  onUnpair,
  historyLoading = false,
}: SidebarProps) {
  const insets = useSafeAreaInsets();

  // Most recently used app first, so the daily driver is never off-screen
  // behind apps that were tried once.
  const orderedProviders = orderProvidersByRecency(providers, sessions);

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
              onPress={() => {
                haptics.tap();
                onNewConversation();
              }}
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
            {orderedProviders.map((provider) => (
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
                onPress={() => {
                  haptics.select();
                  onSelectProvider(provider.id);
                }}
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

          {/* A provider can hold hundreds of conversations. Rendering them
              all in a ScrollView was the stall when switching to a well-used
              app; a windowed list mounts only what is on screen. */}
          <FlatList
            style={styles.sessions}
            contentContainerStyle={styles.sessionsContent}
            showsVerticalScrollIndicator={false}
            data={visible}
            keyExtractor={(session) => session.id}
            initialNumToRender={18}
            maxToRenderPerBatch={18}
            windowSize={9}
            removeClippedSubviews
            ListEmptyComponent={
              historyLoading ? (
                <HistorySkeleton />
              ) : (
                <Text style={styles.empty}>
                  No conversations yet. Send a message to start one.
                </Text>
              )
            }
            renderItem={({ item: session }) => (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={session.title}
                accessibilityState={{ selected: session.id === activeSessionId }}
                onPress={() => {
                  haptics.tap();
                  onOpenSession(session.id);
                }}
                style={({ pressed }) => [
                  styles.session,
                  session.id === activeSessionId && styles.sessionActive,
                  pressed && styles.pressed,
                ]}
              >
                <Text style={styles.sessionTitle} numberOfLines={1}>
                  {session.title}
                </Text>
                {/* Which project this conversation belongs to — how people
                    actually tell sessions apart. The message count only
                    stands in when no directory is known (locally started
                    sessions). */}
                {folderName(session.cwd) ? (
                  <Text style={styles.sessionMeta} numberOfLines={1}>
                    {folderName(session.cwd)}
                  </Text>
                ) : (
                  !(session.agentSessionId && session.turns.length === 0) && (
                    <Text style={styles.sessionMeta}>
                      {session.turns.length} message
                      {session.turns.length === 1 ? "" : "s"}
                    </Text>
                  )
                )}
              </Pressable>
            )}
          />

          {/* Which machine this phone is driving. Easy to lose track of once
              more than one has been paired, and the only way to undo it. */}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Paired with ${machineLabel}, ${
              machineRemote ? "reachable from anywhere" : "same network only"
            }. Double tap to disconnect.`}
            // Unpairing is the one destructive action in the drawer, so it is
            // the one that must not feel like an ordinary tap.
            onPress={() => {
              haptics.warned();
              onUnpair();
            }}
            style={({ pressed }) => [styles.machine, pressed && styles.pressed]}
          >
            <Ionicons
              // Whether this works away from home is the single most useful
              // fact about a pairing, so it is the icon rather than a footnote.
              name={machineRemote ? "globe-outline" : "wifi-outline"}
              size={14}
              color={theme.color.textFaint}
            />
            <Text style={styles.machineText} numberOfLines={1}>
              {machineLabel}
            </Text>
            <Text style={styles.machineAction}>Disconnect</Text>
          </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  machine: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.space(2),
    marginHorizontal: theme.gutter,
    marginTop: theme.space(2),
    paddingTop: theme.space(3),
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.color.border,
  },
  machineText: { color: theme.color.textFaint, fontSize: 12, flex: 1 },
  machineAction: { color: theme.color.textFaint, fontSize: 12 },

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
    fontFamily: theme.display.bold,
    fontSize: theme.font.title,
    letterSpacing: 0.4,
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
