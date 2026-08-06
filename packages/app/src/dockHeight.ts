/**
 * Which dock height the reading area should clear right now.
 *
 * The dock is two different sizes: taller at rest, where it carries the context
 * row, and shorter while you type, where that row gives the draft the room.
 *
 * Measuring only the current one made every keyboard open pay a round trip. The
 * row unmounts, the platform lays the dock out, `onLayout` reports, React
 * re-renders, and only then does the transcript take up the new inset — by
 * which time the keyboard is already up, so the thread re-seats a few frames
 * behind it. Keeping both means the height for the state being entered is
 * already known and lands in the same commit as the state change itself.
 */
export type DockHeights = {
  /** Measured while the keyboard is up. Zero until that has happened once. */
  typing: number;
  /** Measured with the keyboard down. Zero until that has happened once. */
  resting: number;
};

/**
 * @param heights What each state last measured.
 * @param typing Whether the keyboard is up.
 * @param fallback Analytic height, for before anything has been measured.
 * @returns The height to inset the transcript by.
 */
export function dockHeightFor(heights: DockHeights, typing: boolean, fallback: number): number {
  const wanted = typing ? heights.typing : heights.resting;
  // The other state's measurement beats the analytic guess: it is a real
  // measurement of this dock on this screen, and the two differ only by the
  // context row. This is reachable only on the first keyboard open of a launch.
  return wanted || heights.resting || heights.typing || fallback;
}

/**
 * Fold a fresh measurement in, keeping the object identical when nothing moved.
 *
 * The dock lays out repeatedly during the keyboard's own animation. Returning a
 * new object each time would re-render the transcript on those frames, which is
 * the per-frame relayout the whole lift architecture exists to avoid.
 */
export function recordDockHeight(
  heights: DockHeights,
  typing: boolean,
  height: number,
): DockHeights {
  const key = typing ? "typing" : "resting";
  if (heights[key] === height) return heights;
  return { ...heights, [key]: height };
}
