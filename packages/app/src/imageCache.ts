/**
 * A byte-accounted LRU for desktop images pulled onto the phone.
 *
 * Every picture the agent names by path is fetched over the socket and kept as
 * a base64 `data:` URI so the transcript can paint it without asking again.
 * Held forever, that map is unbounded: the daemon allows 8MB per image, which
 * inflates to ~11M base64 characters and ~21MB of retained UTF-16 string, so a
 * long image-heavy conversation walks the app into an OS kill.
 *
 * So the map is a cache with a ceiling, and the least recently *used* entries
 * go when a new one does not fit. Eviction is safe because `ChatImage` asks for
 * its source on every mount and cells recycle — scrolling back re-fetches, which
 * costs a round trip instead of a crash.
 *
 * The one rule a caller must not break: an evicted uri has to be dropped from
 * the "already requested" guard too, or the picture spins for ever. `putImage`
 * returns exactly that list.
 *
 * Pure and Expo-free so it can be tested under `bun test`, which cannot parse
 * React Native's Flow syntax.
 */

/**
 * The part of a cached image this module needs to see.
 *
 * Structural rather than an import of `ImageEntry` from `useDaemon`, which
 * pulls React in and would drag a hook module into a pure unit test.
 */
export interface CachedImage {
  readonly status: string;
  /** Present only once the bytes arrived; that string *is* the memory cost. */
  readonly dataUri?: string;
}

/**
 * Roughly two full-size images, in retained bytes.
 *
 * Small enough that a scrolled-past gallery cannot pin hundreds of megabytes,
 * large enough that the images actually on screen — and the one just scrolled
 * past, which is about to come back — are never re-fetched.
 */
export const DEFAULT_IMAGE_CACHE_BYTES = 48 * 1024 * 1024;

/**
 * Charged for every entry regardless of payload.
 *
 * A `loading` or `error` entry carries no bytes worth counting, but it still
 * holds a uri, an object and two map slots — and there is no other bound on how
 * many of them a transcript can create. Charging a flat cost makes the byte
 * ceiling bound the entry count as well (~12k entries at the default).
 */
const ENTRY_OVERHEAD_BYTES = 4096;

export interface ImageCache<T extends CachedImage = CachedImage> {
  /** What the UI renders. Replaced, never mutated, so React sees the change. */
  readonly images: Readonly<Record<string, T>>;
  /** Uris least-recently-used first: the eviction order. */
  readonly order: readonly string[];
  /** Accounted size of everything in `images`, including per-entry overhead. */
  readonly bytes: number;
  readonly limit: number;
}

/** An empty cache. `limit` is in accounted bytes, not entries. */
export function emptyImageCache<T extends CachedImage = CachedImage>(
  limit: number = DEFAULT_IMAGE_CACHE_BYTES,
): ImageCache<T> {
  return { images: {}, order: [], bytes: 0, limit };
}

/**
 * What one entry costs.
 *
 * A JS string is UTF-16, so a base64 payload retains two bytes per character —
 * the number that matters here is what the heap holds, not what the wire moved.
 */
export function imageBytes(entry: CachedImage): number {
  return ENTRY_OVERHEAD_BYTES + (entry.dataUri ? entry.dataUri.length * 2 : 0);
}

export interface PutImageResult<T extends CachedImage = CachedImage> {
  readonly cache: ImageCache<T>;
  /**
   * Uris dropped to make room, newest-evicted last.
   *
   * The caller must forget these in its request-dedup set too, or they can
   * never be fetched again.
   */
  readonly evicted: readonly string[];
}

/**
 * Store an image, evicting least-recently-used entries until it fits.
 *
 * Re-putting a uri refreshes its recency and replaces its accounted size rather
 * than counting it twice — the same picture arrives as `loading` and then as
 * `ready`, and a fetch that failed can be retried.
 *
 * An entry larger than the whole limit is still stored: refusing it would mean
 * a picture that can never be displayed, and it will be evicted by the next
 * arrival anyway. It does empty the cache first, which is the honest cost.
 */
export function putImage<T extends CachedImage>(
  cache: ImageCache<T>,
  uri: string,
  entry: T,
): PutImageResult<T> {
  const images: Record<string, T> = { ...cache.images, [uri]: entry };
  const previous = cache.images[uri];
  const order = cache.order.filter((known) => known !== uri);
  order.push(uri);
  let bytes = cache.bytes + imageBytes(entry) - (previous ? imageBytes(previous) : 0);

  const evicted: string[] = [];
  // The newest entry is last in `order` and so is never its own victim, which
  // is what keeps an oversized image storable.
  while (bytes > cache.limit && order.length > 1) {
    const oldest = order.shift()!;
    const dropped = images[oldest];
    if (dropped) bytes -= imageBytes(dropped);
    delete images[oldest];
    evicted.push(oldest);
  }

  return { cache: { images, order, bytes, limit: cache.limit }, evicted };
}

/**
 * Mark a uri as just used, so scrolling back over a picture protects it.
 *
 * Returns the same cache when the uri is unknown or already newest, so callers
 * can skip a state update.
 */
export function touchImage<T extends CachedImage>(
  cache: ImageCache<T>,
  uri: string,
): ImageCache<T> {
  if (!(uri in cache.images)) return cache;
  if (cache.order[cache.order.length - 1] === uri) return cache;
  const order = cache.order.filter((known) => known !== uri);
  order.push(uri);
  return { ...cache, order };
}
