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
import { memo, useEffect, useRef, useState } from "react";
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
import { touchSlop } from "./controls";
import { Glass } from "./Glass";
import { haptics } from "./haptics";
import { HistorySkeleton } from "./Skeleton";
import { orderProvidersByRecency } from "../providerRecency";
import { formatHistoryMetadata } from "../historyMetadata";
import { recentSessionsForProvider } from "../sessionHistory";
import { useReducedMotion } from "./useReducedMotion";
import { ProjectSelect } from "./ProjectSelect";
import { ProjectMenu } from "./ProjectMenu";
import { sessionsInProject, type Project } from "../projects";
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
  /**
   * Starts a conversation in `cwd`.
   *
   * Always called with one: the only button that reaches this is beside a named
   * project, which is what replaced a header button that could not say where
   * its chat would go.
   */
  onNewConversation: (cwd: string) => void;
  /** Projects the selected agent has worked in, newest first. */
  projects: Project[];
  /** The chosen one, or undefined for all of them. */
  selectedProjectPath?: string;
  /** `undefined` clears the filter back to every project. */
  onSelectProject: (path?: string) => void;
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

/**
 * The dot beside a conversation title: working, or finished while you were
 * away.
 *
 * Two states rather than one because they ask for opposite things. A pulsing
 * dot says "still going, nothing to do"; a solid one says "this came back, go
 * read it". Both are on the row you would tap anyway, so noticing and acting
 * are the same gesture.
 */
function SessionStatus({
  busy,
  unread,
  reduceMotion,
}: {
  busy: boolean;
  unread: boolean;
  reduceMotion: boolean;
}) {
  const pulse = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    pulse.stopAnimation();
    if (!busy || reduceMotion) {
      pulse.setValue(1);
      return;
    }
    // Never fully out: a dot that disappears reads as a rendering glitch in a
    // list, where the neighbouring rows have no dot at all.
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 0.3,
          duration: 700,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(pulse, {
          toValue: 1,
          duration: 700,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [busy, pulse, reduceMotion]);

  // Working outranks unread: a session that answered and was prompted again
  // from the desktop is, right now, working.
  if (!busy && !unread) return null;
  return (
    <Animated.View
      // Spoken, because colour alone carries this for everyone else. The role
      // is what makes a bare View announce its label at all, and it matches the
      // connection dot above.
      accessibilityRole="text"
      accessibilityLabel={busy ? "Working" : "New reply"}
      style={[
        styles.statusDot,
        busy ? styles.statusWorking : styles.statusUnread,
        busy && { opacity: pulse },
      ]}
    />
  );
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
        <View style={styles.sessionLine}>
          <Text style={styles.sessionTitle} numberOfLines={1}>
            {session.title}
          </Text>
          {/* The agent keeps running when you leave a conversation, so the
              drawer is where you find out what is still going and what came
              back while you were elsewhere. */}
          <SessionStatus
            busy={session.busy === true}
            unread={session.unread === true}
            reduceMotion={reduceMotion}
          />
        </View>
        {metadata ? (
          <Text style={styles.sessionMeta} numberOfLines={1}>
            {metadata}
          </Text>
        ) : null}
      </Pressable>
    </Animated.View>
  );
}

function SidebarView({
  open,
  providers,
  sessions,
  activeProviderId,
  activeSessionId,
  onSelectProvider,
  onOpenSession,
  onNewConversation,
  projects,
  selectedProjectPath,
  onSelectProject,
  machineLabel,
  machineRemote,
  connectionStatus,
  onUnpair,
  historyLoading = false,
  reduceMotion = false,
}: SidebarProps) {
  const insets = useSafeAreaInsets();
  const [menuOpen, setMenuOpen] = useState(false);
  // Measured rather than computed: the chip row above scrolls horizontally and
  // the select row's own height comes from the type inside it, so the only
  // honest place to hang the menu from is where the row actually ended up.
  const [menuTop, setMenuTop] = useState(0);

  // Closing the drawer, or switching app, ends the menu.
  //
  // The drawer is only translated off screen, never unmounted, so an open menu
  // survives both and is waiting on top of the history the next time the drawer
  // is pulled out. Switching app matters twice over: the projects underneath it
  // belong to the agent, so the list would silently become another agent's
  // while open.
  useEffect(() => {
    setMenuOpen(false);
  }, [open, activeProviderId]);

  // Most recently used app first, so the daily driver is never off-screen
  // behind apps that were tried once.
  const orderedProviders = orderProvidersByRecency(providers, sessions);

  const selectedProject = projects.find((project) => project.path === selectedProjectPath);
  // Narrowed before the recent-work cap, or a project's older conversations
  // would be cut away by a window they were never in.
  const visible = recentSessionsForProvider(
    sessionsInProject(sessions, selectedProject),
    activeProviderId,
  );
  // Spoken only. The dot beside the title carries this at a glance; a screen
  // reader gets the sentence, including which computer it is about.
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
            {/* The dot rides with the title rather than sitting in the footer:
                connection state is the first thing to check when the drawer is
                opened, and it belongs to the list of apps it describes. */}
            <View style={styles.headerTitleRow}>
              <Text style={styles.headerTitle}>Connected Apps</Text>
              <View
                style={[styles.connectionDot, { backgroundColor: connectionColor }]}
                accessibilityRole="text"
                accessibilityLabel={`${connectionLabel} to ${machineLabel}. ${
                  machineRemote ? "Reachable from anywhere." : "Same network only."
                }`}
              />
            </View>
            {/* No button here. A "new chat" in the drawer header sits above the
                app chips and the project selector both, so it could only mean
                "somewhere" — it started one wherever the agent last was, which
                is misleading precisely when it matters. The action now lives
                beside the project it applies to. */}
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

          {/* Under the apps, above the history: it belongs to the app chosen
              above and it governs the list below. */}
          <ProjectSelect
            selected={selectedProject}
            count={projects.length}
            open={menuOpen}
            onToggle={() => setMenuOpen((was) => !was)}
            onLayout={(event) => {
              const { y, height } = event.nativeEvent.layout;
              setMenuTop(y + height);
            }}
          />

          {/* "Latest chats", not "Chat history": the list is capped at the
              newest conversations, and calling that history promises an archive
              it does not have — the project selector above is what reaches the
              rest. */}
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionLabel}>Latest chats</Text>

            {/* Only with a project chosen, and that is the whole point: a "new
                chat" button with no project named cannot say where the chat
                would go, which is exactly the ambiguity this replaces. Here it
                is unambiguous — the project is on screen directly above it. */}
            {selectedProject && (
              <NewChatChip
                project={selectedProject}
                onPress={() => onNewConversation(selectedProject.path)}
              />
            )}
          </View>

          {/* A provider can hold hundreds of conversations. Rendering them
              all in a ScrollView was the stall when switching to a well-used
              app; a windowed list mounts only what is on screen. */}
          <FlatList
            // Remount on app selection: this resets a previously scrolled list
            // to its newest session and gives each new row one clean entrance.
            key={`${activeProviderId ?? "all-providers"}:${selectedProjectPath ?? "all"}`}
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
                  {selectedProject
                    ? `No conversations in ${selectedProject.name} yet. Send a message to start one there.`
                    : "No conversations yet. Send a message to start one."}
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

          {/* Connection state is the dot beside the title now, so this row is
              just the one action it always carried. The host name stays out of
              sight and in the spoken label. */}
          <View style={styles.machine}>
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

          {/* Last child, so it paints over the history it drops across. Inside
              the panel rather than over the whole screen: it is the drawer's
              own menu, and the panel's clip keeps it off the conversation. */}
          <ProjectMenu
            visible={menuOpen}
            projects={projects}
            selectedPath={selectedProjectPath}
            top={menuTop}
            onSelect={(path) => {
              onSelectProject(path);
              setMenuOpen(false);
            }}
            onClose={() => setMenuOpen(false)}
          />
      </View>
    </View>
  );
}

/**
 * "+ New chat", beside the heading, once a project is chosen.
 *
 * It appears and disappears with the project selection, so it arrives rather
 * than pops: scale and fade from the right, anchored where it sits. An element
 * that materialises next to a heading the user was already reading is the kind
 * of change that gets noticed as a glitch and not as an offer.
 *
 * Entrance only. It unmounts with the selection, and animating that out would
 * mean holding a button that no longer applies to what the list is showing.
 */
function NewChatChip({ project, onPress }: { project: Project; onPress: () => void }) {
  const reduceMotion = useReducedMotion();
  const enter = useRef(new Animated.Value(reduceMotion ? 1 : 0)).current;

  useEffect(() => {
    if (reduceMotion) {
      enter.setValue(1);
      return;
    }
    const animation = Animated.spring(enter, {
      toValue: 1,
      damping: 24,
      stiffness: 300,
      mass: 0.8,
      useNativeDriver: true,
    });
    animation.start();
    return () => animation.stop();
  }, [reduceMotion, enter]);

  return (
    <Animated.View
      style={{
        opacity: enter,
        transform: [
          { scale: enter.interpolate({ inputRange: [0, 1], outputRange: [0.88, 1] }) },
          // Slides in from the right edge it is pinned to, so the growth reads
          // as coming from outside the panel rather than out of the heading.
          { translateX: enter.interpolate({ inputRange: [0, 1], outputRange: [12, 0] }) },
        ],
      }}
    >
      <Glass radius={theme.radius.pill} interactive>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`New chat in ${project.name}`}
          hitSlop={touchSlop(theme.space(1))}
          onPress={() => {
            haptics.tap();
            onPress();
          }}
          style={({ pressed }) => [styles.newChip, pressed && styles.pressed]}
        >
          <Ionicons name="add" size={16} color={theme.color.text} />
          <Text style={styles.newChipText}>New chat</Text>
        </Pressable>
      </Glass>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  machine: {
    flexDirection: "row",
    alignItems: "center",
    // Right-aligned: Forget keeps the edge it has always sat on, now that the
    // status text that used to fill this row is gone.
    justifyContent: "flex-end",
    marginHorizontal: theme.gutter,
    marginTop: theme.space(2),
    paddingTop: theme.space(3),
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.color.border,
  },
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
    // Same gutter and the same row height as the conversation's top bar, so
    // the title and the hamburger beside it share one baseline.
    paddingHorizontal: theme.gutter,
    height: theme.size.control,
    marginBottom: theme.space(3),
  },
  headerTitleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.space(2),
  },
  // Colour is the whole message, so it needs no glyph and no label beside it.
  connectionDot: { width: 8, height: 8, borderRadius: 4 },
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

  // A heading, not a caption: the drawer has two sections and they are peers,
  // so this matches "Connected Apps" exactly rather than sitting below it in
  // the hierarchy. Its own padding moved to the row that now holds it.
  sectionLabel: {
    color: theme.color.text,
    fontFamily: theme.display.bold,
    fontSize: theme.font.title,
    letterSpacing: 0.4,
  },
  // The heading and its action share a baseline: the button is what you do to
  // the section it names, so it belongs on that line rather than above the list.
  sectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.space(2),
    paddingHorizontal: theme.gutter,
    paddingTop: theme.space(5),
    paddingBottom: theme.space(2),
    // Always the chip's height, whether or not the chip is there. Otherwise
    // choosing a project grows this row and shoves the whole list down a
    // centimetre — the button's own spring lands on top of a jump.
    minHeight: theme.size.control + theme.space(7),
  },
  newChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.space(1),
    height: theme.size.control,
    paddingHorizontal: theme.space(3),
  },
  newChipText: {
    color: theme.color.text,
    fontSize: theme.font.small,
  },

  sessions: { flex: 1 },
  // The row's own inset is subtracted from the list inset so session text lands
  // on exactly the same left rail as the "Latest chats" label, while the
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
  sessionLine: { flexDirection: "row", alignItems: "center", gap: theme.space(2) },
  statusDot: { width: 7, height: 7, borderRadius: 4 },
  // The agent's own accent: this is the agent doing something.
  statusWorking: { backgroundColor: theme.color.accent },
  statusUnread: { backgroundColor: theme.color.success },
  sessionTitle: {
    color: theme.color.text,
    fontSize: theme.font.body,
    lineHeight: theme.line.body,
    // Yields to the status dot rather than pushing it off the row.
    flexShrink: 1,
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

// Memoized: a streamed chunk re-renders the screen many times a second, and
// none of those chunks change anything here.
export const Sidebar = memo(SidebarView);
