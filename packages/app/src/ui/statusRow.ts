/**
 * The height of the transcript's status row, at the reader's text size.
 *
 * Four things take turns in the one slot under the last message: the dots, the
 * activity line, the turn receipt, and — when none of them apply — an empty
 * spacer that exists purely to hold the space. They must be exactly the same
 * height, or the transcript shifts the moment an agent starts working, which is
 * the most visible frame in the app.
 *
 * That agreement used to be four copies of `height: theme.line.body`, which is
 * a constant. The text inside them is not: React Native multiplies both
 * `fontSize` and an explicit `lineHeight` by the OS font scale, so at a large
 * Dynamic Type setting the text outgrew the box that was supposed to be one
 * line tall — clipped glyphs, and the receipt no longer matching the spacer it
 * replaces. The height has to come from the same number the text does.
 *
 * Takes its base line rather than importing the theme, and so stays Expo- and
 * React-Native-free like `pairingLink.ts`: `theme.ts` imports `Easing` from
 * react-native, which `bun test` cannot parse. `useStatusRowHeight` is the hook
 * that supplies both the theme's line and the live scale.
 */

/**
 * Where the row stops growing.
 *
 * 200% is the figure WCAG asks text to survive, so everything up to it scales
 * fully. Past it — iOS's accessibility sizes reach roughly 310% — a one-line
 * decoration would eat a third of the screen to say "working", so both the row
 * and the text in it stop here together. Capping only one of the two is what
 * clips; capping neither is what pushes the reply off the fold.
 */
export const STATUS_ROW_MAX_FONT_SCALE = 2;

/** One line of `baseLine` at `fontScale`, clamped and rounded to a whole pixel. */
export function statusRowHeight(baseLine: number, fontScale: number): number {
  // Below 1 is a scale the app never renders smaller for: the row is already at
  // its minimum useful height, and shrinking it would only break the rhythm the
  // other direction.
  const scale = Number.isFinite(fontScale)
    ? Math.min(Math.max(fontScale, 1), STATUS_ROW_MAX_FONT_SCALE)
    : 1;
  return Math.round(baseLine * scale);
}
