/**
 * The `/command` at the head of a draft, lit by a travelling sheen.
 *
 * A command is not ordinary prose — it is the one word in the box that changes
 * what the agent will do — so it is set in the accent colour and weighted to say
 * so. The sheen marks it as *live*: the app recognised the token and will act on
 * it, as opposed to text that merely begins with a slash.
 *
 * Drawn as an overlay above the composer rather than inside it, because a
 * gradient cannot be a text style. The token the `TextInput` holds is rendered
 * transparent and this sits exactly on top; the two agree because a command is
 * always at offset zero and both use the same font metrics.
 */
import { memo } from "react";
import { theme } from "../theme";
import { ShimmerText } from "./ShimmerText";

/** One pass of the sheen. Unhurried, so it reads as a sheen and not a flicker. */
const SWEEP_DURATION = 1800;

/** Pause between passes, so it is punctuation rather than a loading bar. */
const SWEEP_GAP = 900;

function CommandTokenView({
  text,
  size = theme.font.body,
  lineHeight = theme.line.body,
}: {
  text: string;
  /** Defaults to body text; the composer badge sets its own, smaller scale. */
  size?: number;
  lineHeight?: number;
}) {
  return (
    <ShimmerText
      text={text}
      // The accent is what the token is when the sheen is elsewhere, and its
      // whole appearance under reduced motion.
      color={theme.color.accent}
      size={size}
      lineHeight={lineHeight}
      weight="700"
      duration={SWEEP_DURATION}
      gap={SWEEP_GAP}
    />
  );
}


export const CommandToken = memo(CommandTokenView);
