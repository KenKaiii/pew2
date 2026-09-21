/** Dev-only native gate, using the same rules/styles as production Markdown. */
import { Text, View } from "react-native";
import type { RenderRules } from "react-native-markdown-renderer";
import { StreamingMarkdown } from "./StreamingMarkdown";
import { markdownRules, markdownStyles, openLink } from "./MarkdownText";
import { useSmoothText } from "./useSmoothText";
import { safePrefixLength } from "../smoothText";
import { theme } from "../theme";

export function MarkdownStreamHarness({ text, identity, live }: { text: string; identity: string; live: boolean }) {
  const smooth = useSmoothText(text, identity, live);
  const unicodeOK = safePrefixLength("a👩🏽‍💻b", 4) === 1;
  return <View accessibilityLiveRegion="none" style={{ padding: theme.space(4), backgroundColor: theme.color.bg }}>
    <Text style={{ color: theme.color.text, fontSize: 14, lineHeight: 20 }}>Native prototype · grapheme check: {unicodeOK ? "pass" : "FAIL"}</Text>
    <StreamingMarkdown source={smooth.text} animate={smooth.animating} rules={markdownRules as RenderRules} style={markdownStyles.body} onLinkPress={openLink} />
  </View>;
}
