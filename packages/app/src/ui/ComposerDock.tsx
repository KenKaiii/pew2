/**
 * The composer and the context row above it, holding the draft themselves.
 *
 * The draft used to be state on the root component. Every keystroke therefore
 * re-rendered the entire app: the whole element tree rebuilt, every `useMemo`
 * comparison re-run, every callback with the draft in its dependencies made
 * fresh — and `send` was one, so the memoised composer never bailed out either.
 * The transcript and the drawer bailed out, being memoised, but only after the
 * work of asking had already been done a hundred elements deep.
 *
 * That cost fell on the JS thread at exactly the wrong moment. A wrapped line
 * measures, writes its new height, and animates \u2014 while the same thread is
 * rebuilding the app because a character arrived. The box lagged the caret on
 * every return and every auto-wrap, and no amount of work inside `Composer`
 * could fix it, because the stall was above `Composer` entirely.
 *
 * So the draft lives here, one small subtree, and typing re-renders this and
 * nothing else. Everything the root still needs \u2014 reading the draft to send it,
 * replacing it from a slash command or from dictation \u2014 goes through the
 * imperative handle below rather than back up into shared state, which would
 * restore the very coupling this exists to remove.
 */
import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { View, type StyleProp, type ViewStyle } from "react-native";
import { SETTLE_MS, heightAction } from "../settledHeight";
import type { PendingAttachment } from "../attachments";
import type { ContextUsage } from "../contextUsage";
import type { Workspace } from "../useDaemon";
import type { Dictation } from "./useDictation";
import { Composer, type ComposerHandle } from "./Composer";
import { ContextBar } from "./ContextBar";

export interface ComposerDockHandle {
  /**
   * The current draft, read without a render.
   *
   * A getter and not a value, because the point of this component is that the
   * root does not re-render when the draft changes. Sending is the only thing
   * that needs the text, and it needs it once, at the moment of sending.
   */
  getDraft(): string;
  /** Replace the draft, as a slash command or dictation does. */
  setDraft(text: string): void;
  focus(): void;
}

interface Props {
  /** The keyboard is up, which hides the context row. */
  typing: boolean;
  workspace?: Workspace;
  usage?: ContextUsage;
  showCommands: boolean;
  onCommands: () => void;
  /**
   * Send the draft, answering whether it actually went.
   *
   * Handed the text rather than reading it from shared state, so the root never
   * needs the draft as a value and never re-renders as it changes.
   *
   * The answer decides whether the draft is cleared. Sending can be refused —
   * no agent is available to start a conversation with — and a refusal has to
   * leave the words in the box: they were never delivered, and clearing them
   * would destroy a message the user still needs.
   */
  onSend: (text: string) => boolean;
  busy?: boolean;
  onStop?: () => void;
  editable?: boolean;
  placeholder?: string;
  attachments: PendingAttachment[];
  onAttach: () => void;
  onRemoveAttachment: (id: string) => void;
  dictation: Dictation;
  style?: StyleProp<ViewStyle>;
  /**
   * This dock's height, reported once it has stopped changing.
   *
   * Not `onLayout`, deliberately. The composer grows with an animation, so raw
   * layout events arrive on every frame of it, and anything that turns one into
   * a state update re-renders the app about ten times per wrapped line — on the
   * exact frames the animation needs. See `settledHeight.ts`.
   */
  onHeightSettled?: (height: number) => void;
}

function ComposerDockView(
  {
    typing,
    workspace,
    usage,
    showCommands,
    onCommands,
    onSend,
    busy,
    onStop,
    editable,
    placeholder,
    attachments,
    onAttach,
    onRemoveAttachment,
    dictation,
    style,
    onHeightSettled,
  }: Props,
  ref: React.Ref<ComposerDockHandle>,
) {
  const [draft, setDraft] = useState("");
  // Mirrors the draft for the handle below. Reading state through a ref keeps
  // `getDraft` stable across renders, so a parent holding this handle is not
  // itself re-rendered by every character \u2014 which would undo the whole point.
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const composer = useRef<ComposerHandle>(null);

  useImperativeHandle(
    ref,
    () => ({
      getDraft: () => draftRef.current,
      setDraft,
      focus: () => composer.current?.focus(),
    }),
    [],
  );

  const send = useCallback(() => {
    // Cleared here rather than by the parent, because the draft belongs to this
    // component now — but only once the message has actually gone. A send the
    // parent refuses leaves the words where they are, which is the difference
    // between a message that did not send and a message that was destroyed.
    if (onSend(draftRef.current.trim())) setDraft("");
  }, [onSend]);

  // The last height handed upwards, and the timer waiting to hand up the next.
  //
  // Refs, not state: this is measurement plumbing, and storing it in state
  // would re-render the dock on every animation frame — the cost being avoided.
  const reported = useRef(0);
  const settling = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(settling.current), []);

  const measure = useCallback(
    (height: number) => {
      switch (heightAction(reported.current, height)) {
        case "ignore":
          return;
        case "report-now":
          reported.current = height;
          onHeightSettled?.(height);
          return;
        case "defer":
          // Restarted on every frame of the growth, so it only ever fires once
          // the composer has stopped moving.
          clearTimeout(settling.current);
          settling.current = setTimeout(() => {
            reported.current = height;
            onHeightSettled?.(height);
          }, SETTLE_MS);
      }
    },
    [onHeightSettled],
  );

  return (
    <View style={style} onLayout={(event) => measure(event.nativeEvent.layout.height)}>
      {/* The context row shows what the next prompt acts on — project, context
          fill, uncommitted work, and the commands the agent offers (an empty
          sheet is worse than no button). Never while typing: the draft is the
          subject then, and the row would only crowd it. */}
      {!typing && (showCommands || workspace || usage) && (
        <ContextBar
          workspace={workspace}
          usage={usage}
          showCommands={showCommands}
          onCommands={onCommands}
        />
      )}
      <Composer
        ref={composer}
        value={draft}
        onChangeText={setDraft}
        onSend={send}
        busy={busy}
        onStop={onStop}
        editable={editable}
        placeholder={placeholder}
        attachments={attachments}
        onAttach={onAttach}
        onRemoveAttachment={onRemoveAttachment}
        dictation={dictation}
      />
    </View>
  );
}

export const ComposerDock = memo(forwardRef<ComposerDockHandle, Props>(ComposerDockView));
