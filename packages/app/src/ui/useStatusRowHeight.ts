import { useWindowDimensions } from "react-native";
import { theme } from "../theme";
import { statusRowHeight } from "./statusRow";

/**
 * The status row's height at the reader's current text size.
 *
 * `useWindowDimensions` rather than `PixelRatio.getFontScale()`: the scale is
 * read once at module load by the latter, and Dynamic Type can be changed while
 * the app is running — on both platforms the change arrives as a dimensions
 * event, so this re-renders and the rows resize with the text instead of
 * clipping until the next cold start.
 */
export function useStatusRowHeight(): number {
  return statusRowHeight(theme.line.body, useWindowDimensions().fontScale);
}
