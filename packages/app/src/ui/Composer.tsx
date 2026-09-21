/** Beam-reference composer: utility row, stable text field, settings + send.
 * Draft ownership stays in ComposerDock; native layout owns text growth.
 */
import { forwardRef, memo, useImperativeHandle, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, useWindowDimensions, View } from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import { theme } from "../theme";
import { haptics } from "./haptics";
import { CommandToken } from "./CommandToken";
import { splitCommand } from "../slashCommands";
import { AttachmentChips } from "./AttachmentChips";
import { ComposerBeam } from "./ComposerBeam";
import type { PendingAttachment } from "../attachments";
import type { Dictation } from "./useDictation";

const EMPTY_ATTACHMENTS: readonly PendingAttachment[] = [];
const EMPTY_SELECTORS: readonly ComposerSelector[] = [];
export interface ComposerAnchor { x: number; y: number }
export interface ComposerSelector {
  id: string;
  value: string;
  label: string;
  onPress: (anchor: ComposerAnchor) => void;
}
export interface ComposerHandle { focus(): void }
interface ComposerProps {
  value: string;
  onChangeText: (text: string) => void;
  onSend: () => void;
  busy?: boolean;
  onStop?: () => void;
  placeholder?: string;
  editable?: boolean;
  attachments?: readonly PendingAttachment[];
  onAttach?: () => void;
  onRemoveAttachment?: (id: string) => void;
  dictation?: Dictation;
  selectors?: readonly ComposerSelector[];
}

function Selector({ value, label, onPress }: ComposerSelector) {
  const target = useRef<View>(null);
  return (
    <Pressable
      ref={target}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint="Opens available options"
      onPress={() => target.current?.measureInWindow((x, y) => { haptics.tap(); onPress({ x, y }); })}
      style={({ pressed }) => [styles.selectorTarget, pressed && styles.pressed]}
    >
      <View style={styles.tag}>
        <Text numberOfLines={1} style={styles.tagText}>{value}</Text>
        <Ionicons name="chevron-down" size={12} color={theme.composer.ink} />
      </View>
    </Pressable>
  );
}

function ComposerView({
  value, onChangeText, onSend, busy = false, onStop,
  placeholder = "Build anything...", editable = true,
  attachments = EMPTY_ATTACHMENTS, onAttach, onRemoveAttachment,
  dictation, selectors = EMPTY_SELECTORS,
}: ComposerProps, ref: React.Ref<ComposerHandle>) {
  const input = useRef<TextInput>(null);
  useImperativeHandle(ref, () => ({ focus: () => input.current?.focus() }), []);
  const [atCeiling, setAtCeiling] = useState(false);
  const { fontScale, height: viewportHeight } = useWindowDimensions();
  const minTextHeight = Math.max(theme.space(16), theme.line.body * fontScale);
  const maxTextHeight = Math.max(minTextHeight, Math.min(8 * theme.line.body * fontScale, viewportHeight * 0.25));
  const split = splitCommand(value);
  const canSend = editable && !dictation?.listening && (value.trim().length > 0 || attachments.length > 0);
  const showMic = !busy && (!canSend || !!dictation?.listening);
  const sendDisabled = busy ? !onStop : showMic ? !dictation?.available || !editable : !canSend;
  const actionLabel = busy ? "Stop generating" : showMic ? dictation?.listening ? "Stop dictating" : dictation?.available ? "Dictate a message" : "Voice input unavailable" : "Send message";
  return (
    <View style={styles.stack}>
      {attachments.length > 0 && <AttachmentChips attachments={attachments} onRemove={onRemoveAttachment} />}
      <View style={styles.card}>
        <Pressable
          style={StyleSheet.absoluteFill}
          accessible={false} importantForAccessibility="no" disabled={!editable}
          onPress={() => input.current?.focus()}
        />
          {split && (
            <Pressable
              style={({ pressed }) => [styles.commandTarget, pressed && styles.pressed]}
              accessibilityRole="button" accessibilityLabel={`Remove ${split.command}`}
              onPress={() => { onChangeText(split.rest.replace(/^ /, "")); input.current?.focus(); }}
            >
              <View style={styles.tag}>
                <CommandToken text={split.command} size={theme.font.small} lineHeight={18} />
                <Ionicons name="close" size={13} color={theme.composer.ink} />
              </View>
            </Pressable>
          )}
        {/* Do not constrain this wrapper's height: UIKit otherwise reports the
            clipped viewport as content height, hiding new lines and the caret. */}
        <View style={styles.textArea}>
          <TextInput
            ref={input} style={[styles.input, { minHeight: minTextHeight, maxHeight: maxTextHeight }]}
            value={split ? split.rest.replace(/^ /, "") : value}
            onChangeText={(text) => onChangeText(split ? `${split.command} ${text}` : text)}
            onContentSizeChange={({ nativeEvent }) => {
              const capped = nativeEvent.contentSize.height >= maxTextHeight;
              if (capped !== atCeiling) setAtCeiling(capped);
            }}
            placeholder={placeholder} placeholderTextColor={theme.composer.placeholder}
            multiline editable={editable} accessibilityLabel="Message"
            submitBehavior="newline" scrollEnabled={atCeiling}
          />
        </View>
        <View style={styles.bottomRow} pointerEvents="box-none">
          <Pressable
            style={({ pressed }) => [styles.iconTarget, pressed && styles.pressed]}
            accessibilityRole="button" accessibilityLabel="Add attachment"
            accessibilityState={{ disabled: !onAttach || !editable }} disabled={!onAttach || !editable}
            onPress={() => { haptics.tap(); onAttach?.(); }}
          >
            <Ionicons name="add" size={22} color={theme.composer.ink} />
          </Pressable>
          <View style={styles.selectors} pointerEvents="box-none">
            {selectors.map((selector) => <Selector key={selector.id} {...selector} />)}
          </View>
          <Pressable
            style={({ pressed }) => [styles.iconTarget, pressed && styles.pressed]}
            accessibilityRole="button" accessibilityLabel={actionLabel}
            accessibilityState={{ disabled: sendDisabled }} disabled={sendDisabled}
            onPress={() => {
              if (busy) { haptics.warned(); onStop?.(); }
              else if (showMic) dictation?.toggle();
              else { haptics.sent(); onSend(); }
            }}
          >
            <View style={[styles.sendPill, ((!showMic && !sendDisabled) || dictation?.listening) && styles.selected]}>
              <Ionicons name={busy ? "square" : showMic ? dictation?.listening ? "mic" : "mic-outline" : "arrow-up"} size={busy ? 13 : 18} color={(!showMic && !sendDisabled) || dictation?.listening ? theme.color.bg : theme.composer.ink} />
            </View>
          </Pressable>
        </View>
        <ComposerBeam active={busy} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  stack: { gap: theme.space(2) },
  card: { backgroundColor: theme.composer.fill, borderRadius: theme.composer.radius, borderWidth: 1, borderColor: theme.composer.border, padding: theme.space(1) },
  iconTarget: { width: theme.size.touch, height: theme.size.touch, alignItems: "center", justifyContent: "center" },
  sendPill: { width: 32, height: 32, borderRadius: theme.radius.pill, backgroundColor: theme.composer.chip, alignItems: "center", justifyContent: "center" },
  selected: { backgroundColor: theme.color.text },
  pressed: { opacity: 0.65 },
  textArea: { marginHorizontal: theme.space(2), marginTop: theme.space(2) },
  input: { padding: 0, color: theme.color.text, fontSize: theme.font.body, lineHeight: theme.line.body, textAlignVertical: "top" },
  bottomRow: { flexDirection: "row", alignItems: "center", gap: theme.space(1) },
  selectors: { flex: 1, flexDirection: "row", alignItems: "center", minWidth: 0 },
  selectorTarget: { minWidth: theme.size.touch, minHeight: theme.size.touch, flexShrink: 1, justifyContent: "center", paddingHorizontal: theme.space(1) },
  commandTarget: { minHeight: theme.size.touch, flexShrink: 1, justifyContent: "center" },
  tag: { flexDirection: "row", alignItems: "center", gap: theme.space(1), paddingHorizontal: theme.space(2), paddingVertical: theme.space(1.5), borderRadius: theme.radius.pill, backgroundColor: theme.composer.chip },
  tagText: { color: theme.composer.ink, fontSize: theme.font.small, lineHeight: 17, flexShrink: 1 },
});
export const Composer = memo(forwardRef<ComposerHandle, ComposerProps>(ComposerView));
