/**
 * The sidebar drawer.
 *
 * Agents across the top, their conversations below. Switching agent refilters
 * the list in place, so moving between Claude, Codex and your own app is one
 * tap and never a new screen.
 *
 * Rendered on frosted glass: the conversation stays faintly visible behind it,
 * which keeps the drawer feeling like a layer over your session rather than a
 * page you navigated to.
 */
import { useEffect, useRef } from "react";
import {
  Animated,
  Dimensions,
  Easing,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { BlurView } from "expo-blur";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { theme } from "../theme";
import { Orb } from "./Orb";
import { touchSlop } from "./controls";
import { useReducedMotion } from "./useReducedMotion";
import type { Provider, Session } from "../useDaemon";

const WIDTH = Math.min(Dimensions.get("window").width * 0.86, 340);

interface SidebarProps {
  open: boolean;
  onClose: () => void;
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
  onClose,
  providers,
  sessions,
  activeProviderId,
  activeSessionId,
  onSelectProvider,
  onOpenSession,
  onNewConversation,
}: SidebarProps) {
  const progress = useRef(new Animated.Value(0)).current;
  const reduceMotion = useReducedMotion();
  const insets = useSafeAreaInsets();

  useEffect(() => {
    const animation = Animated.timing(progress, {
      toValue: open ? 1 : 0,
      // One curve, decelerating: the panel arrives rather than snapping.
      duration: reduceMotion ? 0 : 260,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    });
    animation.start();
    return () => animation.stop();
  }, [open, reduceMotion, progress]);

  const translateX = progress.interpolate({
    inputRange: [0, 1],
    outputRange: [-WIDTH, 0],
  });

  const visible = sessions.filter(
    (session) => !activeProviderId || session.providerId === activeProviderId,
  );

  return (
    <View style={styles.host} pointerEvents={open ? "auto" : "none"}>
      <Animated.View style={[styles.scrim, { opacity: progress }]}>
        <Pressable
          style={styles.scrimPress}
          accessibilityRole="button"
          accessibilityLabel="Close menu"
          onPress={onClose}
        />
      </Animated.View>

      <Animated.View style={[styles.panel, { width: WIDTH, transform: [{ translateX }] }]}>
        <BlurView intensity={60} tint="dark" style={StyleSheet.absoluteFill} />
        <View style={styles.panelTint} />

        <View style={[styles.panelInner, { paddingTop: insets.top + theme.space(3) }]}>
          <View style={styles.header}>
            <Text style={styles.headerTitle}>Agents</Text>
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
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  host: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
  scrim: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "rgba(0,0,0,0.55)",
  },
  scrimPress: { flex: 1 },
  panel: {
    position: "absolute",
    top: 0,
    left: 0,
    bottom: 0,
    overflow: "hidden",
    borderRightWidth: StyleSheet.hairlineWidth,
    borderRightColor: "rgba(255,255,255,0.10)",
  },
  // Glass needs a tint behind it or the true-black canvas shows through as mud.
  panelTint: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "rgba(28,28,32,0.55)",
  },
  panelInner: { flex: 1, paddingBottom: theme.space(4) },

  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: theme.space(4),
    paddingBottom: theme.space(3),
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
    backgroundColor: "rgba(255,255,255,0.10)",
  },

  agentRow: { paddingHorizontal: theme.space(4), gap: theme.space(2) },
  agentChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.space(2),
    height: theme.size.chip,
    paddingHorizontal: theme.space(3.5),
    borderRadius: theme.radius.pill,
    backgroundColor: "rgba(255,255,255,0.07)",
  },
  agentChipActive: {
    backgroundColor: "rgba(255,255,255,0.16)",
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
    paddingHorizontal: theme.space(4),
    paddingTop: theme.space(6),
    paddingBottom: theme.space(2),
  },

  sessions: { flex: 1 },
  sessionsContent: { paddingHorizontal: theme.space(3), gap: theme.space(1) },
  session: {
    paddingHorizontal: theme.space(3),
    paddingVertical: theme.space(3),
    borderRadius: theme.radius.md,
    gap: 2,
  },
  sessionActive: { backgroundColor: "rgba(255,255,255,0.10)" },
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
    paddingHorizontal: theme.space(3),
  },
});
