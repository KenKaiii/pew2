/** GG word segmentation + 220ms ease-out opacity, with native text flow.
 * No glyph blur: unsupported by the iOS text renderer. See DESIGN.md.
 */
import { memo, useEffect, useMemo, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import Animated, { cancelAnimation, Easing, useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import Markdown, { AstRenderer, renderRules, styles as defaultStyles, type ASTNode, type MarkdownStyles, type RenderRules } from "react-native-markdown-renderer";
import { normalizeMarkdownKeys, splitWords, isProsePath } from "./markdownIdentity";

function FadingText({ text }: { text: string }) {
  const opacity = useSharedValue(0);
  useEffect(() => {
    opacity.value = withTiming(1, { duration: 220, easing: Easing.out(Easing.ease) });
    return () => cancelAnimation(opacity);
  }, [opacity]);
  const style = useAnimatedStyle(() => ({ opacity: opacity.value }));
  return <Animated.Text accessible={false} style={style}>{text}</Animated.Text>;
}
const Word = memo(function Word({ text, animate }: { text: string; animate: boolean }) {
  // Only a new word mounts the animator. Growing the same word never restarts it.
  const [running, setRunning] = useState(animate);
  useEffect(() => {
    if (!running) return;
    const timer = setTimeout(() => setRunning(false), 220);
    return () => clearTimeout(timer);
  }, [running]);
  return running ? <FadingText text={text} /> : <Text>{text}</Text>;
});

function Prose({ content, animate, budget }: { content: string; animate: boolean; budget: number }) {
  // Initial history stays plain. On settle, release all word wrappers; a later
  // burst starts from the settled prefix instead of animating old words again.
  const [baseline, setBaseline] = useState(content);
  if (!animate && baseline !== content) setBaseline(content);
  if (!animate || budget <= 0) return <Text>{content}</Text>;
  let offset = 0;
  let used = 0;
  return <Text>{splitWords(content).map((part, index) => {
    const start = offset;
    offset += part.length;
    if (/^\s/.test(part) || start < baseline.length || used >= budget) return part;
    used++;
    return <Word key={index} text={part} animate />;
  })}</Text>;
}

interface Props {
  source: string;
  animate: boolean;
  rules: RenderRules;
  style: Partial<MarkdownStyles>;
  onLinkPress: (url: string) => boolean | void;
}
export function StreamingMarkdown({ source, animate, rules, style, onLinkPress }: Props) {
  const renderer = useMemo(() => {
    const merged: MarkdownStyles = { ...defaultStyles };
    for (const [key, value] of Object.entries(style)) {
      merged[key] = { ...StyleSheet.flatten(merged[key] as object), ...StyleSheet.flatten(value as object) };
    }
    return (nodes: ASTNode[]) => {
      let budget = 128;
      const ast = new AstRenderer({
        ...renderRules, ...rules,
        text: (node, _children, parents, styles) => {
          if (!isProsePath(parents.map((p) => p.type))) return renderRules.text!(node, [], parents, styles);
          const allowance = Math.min(budget, splitWords(node.content).filter((part) => !/^\s/.test(part)).length);
          budget -= allowance;
          return <Prose key={node.key} content={node.content} animate={animate} budget={allowance} />;
        },
      }, merged, { onLinkPress });
      return <View key="markdown-root" style={merged.root as object}>{normalizeMarkdownKeys(nodes).map((node) => ast.renderNode(node, []))}</View>;
    };
  }, [animate, rules, style, onLinkPress]);
  return <Markdown renderer={renderer}>{source}</Markdown>;
}
