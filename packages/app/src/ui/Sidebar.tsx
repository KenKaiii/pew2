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
import { useEffect, useRef } from "react";
import {
  Alert,
  Animated,
  Dimensions,
  Easing,
  FlatList,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { theme } from "../theme";
import { Orb } from "./Orb";
import { CircleButton, touchSlop } from "./controls";
import { Glass } from "./Glass";
import { haptics } from "./haptics";
import { HistorySkeleton } from "./Skeleton";
import { orderProvidersByRecency } from "../providerRecency";
import { formatHistoryMetadata } from "../historyMetadata";
import { recentSessionsForProvider } from "../sessionHistory";
import type { Provider, Session, Status } from "../useDaemon";

export const DRAWER_WIDTH = Math.min(Dimensions.get("window").width * 0.88, 380);

interface SidebarProps {
  open: boolean;
  providers: Provider[];
  sessions: Session[];
  activeProviderId?: string;
  activeSessionId?: string;
  onSelectProvider: (id: string) => void;
  onOpenSession: (id: string) => void;
  onNewConversation: () => void;
  /** Host and port, retained for accessible detail and the Forget confirmation. */
  machineLabel: string;
  /** True when reached via a relay, so it works away from home. */
  machineRemote: boolean;
  connectionStatus: Status;
  onUnpair: () => void;
  /**
   * Agents are still answering what conversations they hold. Without this the
   * drawer claims "No conversations yet" for the first seconds after connect —
   * a false empty state on machines with plenty of history.
   */
  historyLoading?: boolean;
  /** Honor the phone's Reduce Motion accessibility preference. */
  reduceMotion?: boolean;
}

const MAX_STAGGERED_ROWS = 14;
const ROW_STAGGER_MS = 18;
const ROW_REVEAL_MS = 180;

function selectedProviderTint(color: string = theme.color.orb) {
  return {
    // Carry the agent's identity beyond the small orb while keeping white text
    // comfortably legible on every manifest colour.
    backgroundColor: `${color}3d`,
    borderColor: `${color}8c`,
  };
}

interface SessionRowProps {
  session: Session;
  index: number;
  active: boolean;
  reduceMotion: boolean;
  onOpen: () => void;
}

function SessionRow({ session, index, active, reduceMotion, onOpen }: SessionRowProps) {
  // Only the initial viewport cascades. Rows virtualized in later should appear
  // immediately, rather than fading under the user's finger while they scroll.
  const shouldAnimate = !reduceMotion && index < MAX_STAGGERED_ROWS;
  const entrance = useRef(new Animated.Value(shouldAnimate ? 0 : 1)).current;

  useEffect(() => {
    entrance.stopAnimation();
    if (!shouldAnimate) {
      entrance.setValue(1);
      return;
    }
    entrance.setValue(0);
    const animation = Animated.timing(entrance, {
      toValue: 1,
      delay: index * ROW_STAGGER_MS,
      duration: ROW_REVEAL_MS,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    });
    animation.start();
    return () => animation.stop();
  }, [entrance, index, shouldAnimate]);

  const metadata = formatHistoryMetadata(session);
  return (
    <Animated.View
      style={{
        opacity: entrance,
        transform: [
          {
            translateY: entrance.interpolate({
              inputRange: [0, 1],
              outputRange: [7, 0],
            }),
          },
        ],
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={session.title}
        accessibilityState={{ selected: active }}
        onPress={onOpen}
        style={({ pressed }) => [
          styles.session,
          active && styles.sessionActive,
          pressed && styles.pressed,
        ]}
      >
        <Text style={styles.sessionTitle} numberOfLines={1}>
          {session.title}
        </Text>
        {metadata ? (
          <Text style={styles.sessionMeta} numberOfLines={1}>
            {metadata}
          </Text>
        ) : null}
      </Pressable>
    </Animated.View>
  );
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
  connectionStatus,
  onUnpair,
  historyLoading = false,
  reduceMotion = false,
}: SidebarProps) {
  const insets = useSafeAreaInsets();

  // Most recently used app first, so the daily driver is never off-screen
  // behind apps that were tried once.
  const orderedProviders = orderProvidersByRecency(providers, sessions);

  const visible = recentSessionsForProvider(sessions, activeProviderId);
  const connectionLabel =
    connectionStatus === "online"
      ? "Healthy connection"
      : connectionStatus === "connecting"
        ? "Connecting…"
        : "Connection interrupted";
  const connectionColor =
    connectionStatus === "online"
      ? theme.color.success
      : connectionStatus === "connecting"
        ? theme.color.textDim
        : theme.color.danger;

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
            <CircleButton
              label="New conversation"
              onPress={onNewConversation}
              size={theme.size.control}
            >
              <Ionicons name="create-outline" size={18} color={theme.color.text} />
            </CircleButton>
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
              <Glass
                key={provider.id}
                radius={theme.radius.pill}
                interactive={provider.available}
                style={!provider.available && styles.chipDisabled}
              >
                <Pressable
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
                    provider.id === activeProviderId && selectedProviderTint(provider.color),
                    pressed && provider.available && styles.pressed,
                  ]}
                >
                  <Orb color={provider.color} size={18} />
                  <Text style={styles.agentChipText} numberOfLines={1}>
                    {provider.name}
                  </Text>
                </Pressable>
              </Glass>
            ))}
          </ScrollView>

          <Text style={styles.sectionLabel}>Chat history</Text>

          {/* A provider can hold hundreds of conversations. Rendering them
              all in a ScrollView was the stall when switching to a well-used
              app; a windowed list mounts only what is on screen. */}
          <FlatList
            // Remount on app selection: this resets a previously scrolled list
            // to its newest session and gives each new row one clean entrance.
            key={activeProviderId ?? "all-providers"}
            style={styles.sessions}
            contentContainerStyle={styles.sessionsContent}
            showsVerticalScrollIndicator={false}
            data={visible}
            extraData={`${activeSessionId ?? ""}:${reduceMotion}`}
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
            renderItem={({ item: session, index }) => (
              <SessionRow
                session={session}
                index={index}
                active={session.id === activeSessionId}
                reduceMotion={reduceMotion}
                onOpen={() => {
                  haptics.tap();
                  onOpenSession(session.id);
                }}
              />
            )}
          />

          {/* Connection health is the useful glanceable fact. Keep the host out
              of sight but in the spoken label for troubleshooting. */}
          <View style={styles.machine}>
            <Ionicons
              name={
                connectionStatus === "online"
                  ? "checkmark-circle-outline"
                  : connectionStatus === "connecting"
                    ? "sync-outline"
                    : "alert-circle-outline"
              }
              size={15}
              color={connectionColor}
            />
            <Text
              style={[styles.machineText, { color: connectionColor }]}
              numberOfLines={1}
              accessibilityLabel={`${connectionLabel} to ${machineLabel}. ${
                machineRemote ? "Reachable from anywhere." : "Same network only."
              }`}
            >
              {connectionLabel}
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Forget pairing with ${machineLabel}`}
              hitSlop={touchSlop(theme.size.touch)}
              onPress={() => {
                haptics.tap();
                Alert.alert(
                  "Forget this computer?",
                  "You'll need to scan or paste its pairing link to connect again.",
                  [
                    { text: "Cancel", style: "cancel" },
                    {
                      text: "Forget",
                      style: "destructive",
                      onPress: () => {
                        haptics.warned();
                        onUnpair();
                      },
                    },
                  ],
                );
              }}
              style={({ pressed }) => pressed && styles.pressed}
            >
              <Text style={styles.machineAction}>Forget</Text>
            </Pressable>
          </View>
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
  machineAction: { color: theme.color.danger, fontSize: 12, fontWeight: "600" },

  // The drawer is the lower layer: it stays put while the conversation slides
  // right to reveal it, so it needs no transform of its own.
  panel: {
    position: "absolute",
    top: 0,
    left: 0,
    bottom: 0,
    backgroundColor: theme.color.drawer,
    // Curved on the inner edge — the side the conversation slides off — so the
    // two read as cards in one stack rather than a panel behind a card.
    borderTopRightRadius: theme.radius.pane,
    borderBottomRightRadius: theme.radius.pane,
    overflow: "hidden",
    // The canvas behind this panel is nearly its own colour, so once the drawer
    // is fully out the corners have nothing to read against. This rim draws
    // them, at the same weight as every other glass edge in the app. Only on the
    // curved side: the other three meet the screen edge, where a line would be
    // an outline around the whole app rather than the shape of this card.
    borderRightWidth: 1,
    borderRightColor: "rgba(255,255,255,0.28)",
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
