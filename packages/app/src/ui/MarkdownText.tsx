import { createElement, memo, useMemo } from "react";
import * as Clipboard from "expo-clipboard";
import * as WebBrowser from "expo-web-browser";
import { Alert, Linking, Platform, StyleSheet, Text, View } from "react-native";
import Markdown, {
  type MarkdownStyles,
  type RenderFunction,
  type RenderRules,
} from "react-native-markdown-renderer";
import { theme } from "../theme";
import { ChatImage } from "./ChatImage";
import { isDisplayableImage } from "../images";
import { writeToClipboard } from "./clipboard";
import { CopyButton } from "./CopyButton";
import { linkTarget } from "./links";
import { fencedCodeContainerStyle, fencedCodeTextStyle } from "./markdownCodeStyles";
import { boundedMarkdownParagraphStyle, boundedMarkdownRootStyle } from "./messageLayoutStyles";
import { splitMarkdownBlocks } from "./markdownBlocks";

export type MarkdownTone = "body" | "thought" | "system";

const BLOCK_GAP = theme.space(2.5);
// Read once so markdown style maps remain stable plain objects.
const StyleSheetHairline = StyleSheet.hairlineWidth;
const monospace = Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" });

function trimTrailingNewline(text: string): string {
  return text.endsWith("\n") ? text.slice(0, -1) : text;
}

function CodeBlock({
  content,
  containerStyle,
  contentStyle,
  textStyle,
}: {
  content: string;
  containerStyle: object;
  contentStyle: object;
  textStyle: object;
}) {
  return (
    <View style={containerStyle}>
      <View style={codeBlockChrome.header}>
        {/* The same control the whole reply carries under it. A code block gets
            its own because a fence is the thing most often wanted on its own —
            and because holding it selects, but cannot reach past its own
            scroll. */}
        <CopyButton text={content} accessibilityLabel="Copy code" />
      </View>
      <View style={contentStyle}>
        <Text selectable style={textStyle}>
          {content}
        </Text>
      </View>
    </View>
  );
}

const codeBlockChrome = StyleSheet.create({
  header: {
    minHeight: 36,
    alignItems: "flex-end",
    justifyContent: "center",
    paddingHorizontal: theme.space(1.5),
    borderBottomWidth: StyleSheetHairline,
    borderBottomColor: theme.color.border,
    backgroundColor: theme.color.surfaceRaised,
  },
});

const renderCodeBlock: RenderFunction = (node, _children, _parents, styles) => {
  const content = trimTrailingNewline(node.content);
  return (
    <CodeBlock
      key={node.key}
      content={content}
      containerStyle={styles.codeBlockContainer as object}
      contentStyle={styles.codeBlockContent as object}
      textStyle={styles.codeBlock as object}
    />
  );
};

/**
 * The parser marks images as *block* tokens, so an `![](x.png)` sits directly
 * under its paragraph rather than inside the grouped text run.
 */
function hasImageChild(node: { children?: { type?: string }[] }): boolean {
  return (node.children ?? []).some((child) => child?.type === "image");
}

/**
 * `![alt](src)` — including `![](.gg/generated/plot.png)`, which is how most
 * agents announce a picture they just made.
 *
 * The library's own image rule renders a bare `Image` with the source as given,
 * so a desktop path produced a permanently blank box. `ChatImage` knows how to
 * bring that file across from the daemon; anything that is not a picture
 * renders nothing, so a stray `![](notes.md)` is not a broken frame.
 */
const renderImage: RenderFunction = (node) => {
  const src: string = node.attributes?.src ?? "";
  const alt: string = node.attributes?.alt ?? "";
  if (!isDisplayableImage(src)) return null;
  return <ChatImage key={node.key} image={{ src, alt: alt || undefined }} />;
};

const markdownRules: Partial<RenderRules> = {
  // Every inline run that is *not* a paragraph — a heading, a list item, a table
  // cell — bottoms out here, and this is the outermost Text of those blocks.
  //
  // That is why `selectable` is said twice, here and on the paragraph below.
  // Nested Text is virtual on both platforms: it is flattened into the one
  // native text view its top-level Text creates, and the native selection
  // gesture belongs to that view. So the flag only does anything on the
  // outermost Text of a block, and there are two kinds of those.
  textgroup: (node, children, _parents, styles) =>
    createElement(
      Text,
      { ["key"]: node.key, selectable: true, style: styles.text as never },
      children,
    ),
  // A paragraph must be one measured Text block. The library's default uses a
  // wrapping row of Text children; inside a list that row reports one-line
  // height while its text paints several lines, so following items overlap it.
  // One exception: a paragraph holding an image becomes a column, because
  // nesting a View in text layout collapses a percentage-width picture on iOS.
  // Only the Text branch is selectable — a View is not text and `selectable`
  // means nothing on it.
  paragraph: (node, children, _parents, styles) =>
    hasImageChild(node)
      ? createElement(View, { ["key"]: node.key, style: styles.paragraph as never }, children)
      : createElement(
          Text,
          { ["key"]: node.key, selectable: true, style: styles.paragraph as never },
          children,
        ),
  code_block: renderCodeBlock,
  fence: renderCodeBlock,
  image: renderImage,
  // CommonMark preserves raw HTML. Show it as source instead of handing chat
  // output to a web view or leaving the renderer's unstyled black fallback.
  html_block: renderCodeBlock,
  html_inline: (node, _children, _parents, styles) =>
    createElement(
      Text,
      { ["key"]: node.key, style: styles.codeInline as never },
      node.content,
    ),
};

function stylesFor(
  color: string,
  fontSize: number,
  lineHeight: number,
): Partial<MarkdownStyles> {
  return {
    // No negative margin here, unlike the single-render version this replaced.
    // Each block now carries its own trailing `BLOCK_GAP`, and the cancellation
    // that keeps a message from ending in dead space belongs once, on the
    // wrapper around all of them — applied per block it would instead collapse
    // the gap between every pair of paragraphs.
    root: boundedMarkdownRootStyle,
    text: { color, fontSize, lineHeight },
    paragraph: {
      color,
      fontSize,
      lineHeight,
      ...boundedMarkdownParagraphStyle,
      marginTop: 0,
      marginBottom: BLOCK_GAP,
    },
    strong: { color, fontWeight: "700" },
    em: { color, fontStyle: "italic" },
    strikethrough: { color, textDecorationLine: "line-through" },
    link: { color: theme.color.accent, textDecorationLine: "underline" },
    headingContainer: {
      flexDirection: "row",
      marginTop: theme.space(1),
      marginBottom: BLOCK_GAP,
    },
    heading: { color, fontWeight: "700" },
    heading1: { color, fontSize: fontSize + 7, lineHeight: lineHeight + 7 },
    heading2: { color, fontSize: fontSize + 4, lineHeight: lineHeight + 4 },
    heading3: { color, fontSize: fontSize + 2, lineHeight: lineHeight + 2 },
    heading4: { color, fontSize, lineHeight },
    heading5: { color, fontSize: fontSize - 1, lineHeight },
    heading6: { color, fontSize: fontSize - 2, lineHeight },
    heading1Container: {
      paddingBottom: theme.space(1.5),
      borderBottomWidth: StyleSheetHairline,
      borderBottomColor: theme.color.border,
    },
    heading2Container: {
      paddingBottom: theme.space(1),
      borderBottomWidth: StyleSheetHairline,
      borderBottomColor: theme.color.border,
    },
    codeInline: {
      color: theme.color.text,
      backgroundColor: theme.color.surfacePressed,
      borderRadius: theme.radius.sm,
      paddingHorizontal: theme.space(1),
      fontFamily: monospace,
      fontSize: Math.max(12, fontSize - 1),
      lineHeight: Math.max(18, lineHeight - 2),
    },
    codeBlockContainer: {
      ...fencedCodeContainerStyle,
      marginBottom: BLOCK_GAP,
      backgroundColor: theme.color.surface,
      borderWidth: StyleSheetHairline,
      borderColor: theme.color.border,
      borderRadius: theme.radius.md,
    },
    codeBlockContent: {
      width: "100%",
      maxWidth: "100%",
      minWidth: 0,
    },
    codeBlock: {
      color: theme.color.text,
      // The renderer's default code style is GitHub-light (#f6f8fa). The dark
      // container owns the surface; the inner Text must not repaint it white.
      ...fencedCodeTextStyle,
      paddingHorizontal: theme.space(3),
      paddingVertical: theme.space(2.5),
      fontFamily: monospace,
      fontSize: Math.max(12, fontSize - 1),
      lineHeight: Math.max(18, lineHeight - 2),
    },
    pre: { marginBottom: 0 },
    blockquote: {
      borderLeftWidth: 3,
      borderLeftColor: theme.color.textDim,
      paddingLeft: theme.space(3),
      paddingRight: 0,
      marginBottom: BLOCK_GAP,
    },
    list: { marginBottom: BLOCK_GAP },
    // minWidth: 0 is essential inside the marker row; without it, long list
    // paragraphs keep their intrinsic width and paint past the chat rail.
    listItem: { flex: 1, minWidth: 0 },
    listUnorderedItem: { flexDirection: "row", alignItems: "flex-start", marginTop: 2 },
    listOrderedItem: { flexDirection: "row", alignItems: "flex-start", marginTop: 2 },
    listUnorderedItemIcon: {
      color,
      marginLeft: theme.space(1),
      marginRight: theme.space(2),
      fontSize,
      lineHeight,
    },
    listOrderedItemIcon: {
      color: theme.color.textDim,
      marginLeft: 0,
      marginRight: theme.space(2),
      fontSize,
      lineHeight,
    },
    listUnorderedItemText: { color, fontSize, lineHeight },
    listOrderedItemText: { color, fontSize, lineHeight },
    hr: {
      height: StyleSheetHairline,
      backgroundColor: theme.color.border,
      marginTop: theme.space(2),
      marginBottom: theme.space(4.5),
    },
    table: {
      borderWidth: StyleSheetHairline,
      borderColor: theme.color.border,
      borderRadius: theme.radius.sm,
      overflow: "hidden",
      marginBottom: BLOCK_GAP,
    },
    tableHeader: { backgroundColor: theme.color.surfaceRaised },
    tableHeaderCell: {
      flex: 1,
      paddingVertical: theme.space(2),
      paddingHorizontal: theme.space(2),
      borderWidth: StyleSheetHairline,
      borderColor: theme.color.border,
      color,
      fontWeight: "700",
    },
    tableRow: {
      flexDirection: "row",
      borderBottomWidth: StyleSheetHairline,
      borderBottomColor: theme.color.border,
    },
    tableRowCell: {
      flex: 1,
      paddingVertical: theme.space(2),
      paddingHorizontal: theme.space(2),
      borderWidth: StyleSheetHairline,
      borderColor: theme.color.border,
      color,
    },
    image: {
      flex: 0,
      width: "100%",
      height: 220,
      resizeMode: "contain",
      marginBottom: BLOCK_GAP,
      borderRadius: theme.radius.md,
    },
  };
}

// Kept outside render: the markdown renderer memoises its AST renderer by the
// identity of these objects while streamed chunks update only the source text.
const markdownStyles: Record<MarkdownTone, Partial<MarkdownStyles>> = {
  body: stylesFor(theme.color.text, theme.font.body, theme.line.body),
  thought: stylesFor(theme.color.textDim, theme.font.small, 20),
  system: stylesFor(theme.color.danger, theme.font.small, 20),
};

/**
 * Opening a link from a message.
 *
 * A web page opens *inside* the app. Leaving is unusually expensive here: an
 * agent is running on the other end of this socket, and backgrounding the app
 * to read a doc page is how a permission request sits unanswered with the
 * agent stopped, waiting on a phone that is showing Safari. The in-app browser
 * is one swipe from the conversation and never drops the connection.
 *
 * Anything else — `mailto:`, `tel:`, another app's scheme — has no page to
 * render and goes to the OS, which is the one thing that knows what to do with
 * it. Whether a scheme is safe to open at all is `links.ts`.
 *
 * And a link that cannot be opened now says so. It used to resolve `canOpenURL`
 * and then quietly drop the URL when the answer was no: the tap did nothing at
 * all, which reads as the transcript being dead rather than as the link being
 * unopenable. The alert carries the URL and offers the clipboard, so a link to
 * an app this phone does not have is still a link the user can use.
 */
function openLink(url: string): void {
  void (async () => {
    const target = linkTarget(url);
    try {
      if (target === "browser") {
        await WebBrowser.openBrowserAsync(url, {
          // The transcript's own surface, so the browser arrives as part of
          // this app rather than as a white flash out of it.
          toolbarColor: theme.color.surface,
          controlsColor: theme.color.accent,
        });
        return;
      }
      if (target === "external") {
        await Linking.openURL(url);
        return;
      }
    } catch {
      // Falls through to the same alert as an unsupported scheme: from the
      // reader's side, a handler that rejected and a handler that does not
      // exist are the same event.
    }
    Alert.alert("Can't open this link", url, [
      {
        text: "Copy link",
        onPress: () => void writeToClipboard(url, Clipboard.setStringAsync),
      },
      { text: "OK", style: "cancel" },
    ]);
  })();
}

/**
 * One top-level block.
 *
 * Memoised on its own source text, which is the entire point: while a reply
 * streams, every block above the one being written is byte-identical from chunk
 * to chunk, so this bails out before the renderer parses anything. Only the
 * final block does real work per chunk.
 */
const MarkdownBlock = memo(function MarkdownBlock({
  source,
  tone,
}: {
  source: string;
  tone: MarkdownTone;
}) {
  return (
    <Markdown
      rules={markdownRules as RenderRules}
      style={markdownStyles[tone]}
      onLinkPress={openLink}
      // No `allowedImageHandlers`: that list only gates the library's own image
      // rule, which is replaced above precisely because it cannot load a file
      // that lives on the desktop.
    >
      {source}
    </Markdown>
  );
});

function MarkdownTextView({ text, tone = "body" }: { text: string; tone?: MarkdownTone }) {
  // Splitting is a parse, so it is memoised too — but it is only the block
  // tokeniser, not the inline pass or the element tree, and it is the one piece
  // of work that unavoidably sees the whole message.
  const blocks = useMemo(() => splitMarkdownBlocks(text), [text]);

  return (
    <View style={blockLayout.root}>
      {blocks.map((source, index) => (
        <MarkdownBlock
          // Index, deliberately. Blocks are an ordered decomposition of one
          // string: block 2 is always the third thing in this message, and
          // during streaming it grows in place rather than being reordered or
          // removed. Keying by content would instead throw away and remount the
          // block being written on every single chunk — exactly the work this
          // whole file is arranged to avoid — and would collapse the two
          // identical paragraphs a message is perfectly entitled to contain.
          key={index}
          source={source}
          tone={tone}
        />
      ))}
    </View>
  );
}

const blockLayout = StyleSheet.create({
  root: {
    // This wrapper now stands where the single Markdown root used to, so it has
    // to keep that root's bounding. Without it a long code line has nothing to
    // shrink against — a View defaults to `flexShrink: 0` — and would push the
    // message wider than its rail.
    ...boundedMarkdownRootStyle,
    // The message ends flush: the last block contributes a trailing `BLOCK_GAP`
    // like every other, and this takes exactly that back.
    marginBottom: -BLOCK_GAP,
  },
});

/**
 * Memoised at the message level as well, so a turn that is merely re-rendered
 * — a sibling streaming, the keyboard opening — does no markdown work at all.
 */
export const MarkdownText = memo(MarkdownTextView);
