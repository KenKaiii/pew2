/**
 * Where a top-bar pill starts, so its dropdown can open underneath it.
 *
 * Split out of App.tsx and free of react-native imports so the recycling
 * behaviour below can be unit tested against the exact event shape that crashed.
 */

export type PillX = { model: number; mode: number };

/** The only part of an onLayout event this needs, minus react-native's types. */
interface LayoutEventLike {
  nativeEvent?: { layout?: { x?: number } } | null;
}

/**
 * Read a pill's x offset out of an onLayout event and fold it into state.
 *
 * The read happens here, synchronously, before the returned updater is queued.
 * React recycles the synthetic event, so touching `nativeEvent` from inside a
 * setState updater — which runs later — hits a nulled-out object and throws
 * "Cannot read property 'layout' of null". Anything missing is skipped rather
 * than crashing the top bar: a menu at the default gutter beats no UI at all.
 */
export function withLayoutX(
  event: LayoutEventLike | null | undefined,
  key: keyof PillX,
): (prev: PillX) => PillX {
  const x = event?.nativeEvent?.layout?.x;
  if (typeof x !== "number" || !Number.isFinite(x)) return (prev) => prev;
  return (prev) => (prev[key] === x ? prev : { ...prev, [key]: x });
}
