/**
 * Image cache tests.
 *
 * The rules here are the ones that decide whether a long image-heavy transcript
 * settles or walks the app into an OS kill: a hard byte ceiling, eviction of the
 * least recently used entry, and an eviction list the caller can use to clear
 * its request-dedup guard.
 */
import { test, expect } from "bun:test";
import {
  DEFAULT_IMAGE_CACHE_BYTES,
  emptyImageCache,
  imageBytes,
  putImage,
  touchImage,
  type CachedImage,
} from "./imageCache";

/** An entry of a known accounted size, so the tests can do arithmetic. */
function ready(bytes: number): CachedImage {
  // Two heap bytes per UTF-16 character, matching `imageBytes`.
  return { status: "ready", dataUri: "d".repeat(Math.max(0, bytes / 2)) };
}

const ENTRY_OVERHEAD = imageBytes({ status: "loading" });

test("stores an image and accounts its bytes", () => {
  const { cache, evicted } = putImage(emptyImageCache(), "a.png", ready(1000));

  expect(cache.images["a.png"]).toEqual({ status: "ready", dataUri: "d".repeat(500) });
  expect(cache.bytes).toBe(ENTRY_OVERHEAD + 1000);
  expect(evicted).toEqual([]);
});

test("evicts least recently used until the new entry fits", () => {
  const limit = ENTRY_OVERHEAD * 3 + 3000;
  let cache = emptyImageCache(limit);
  for (const uri of ["a", "b", "c"]) cache = putImage(cache, uri, ready(1000)).cache;

  const result = putImage(cache, "d", ready(1000));

  // "a" is the oldest, and one eviction is enough to make room.
  expect(result.evicted).toEqual(["a"]);
  expect(Object.keys(result.cache.images).sort()).toEqual(["b", "c", "d"]);
  expect(result.cache.bytes).toBeLessThanOrEqual(limit);
});

test("evicts as many entries as the newcomer needs, oldest first", () => {
  const limit = ENTRY_OVERHEAD * 4 + 4000;
  let cache = emptyImageCache(limit);
  for (const uri of ["a", "b", "c", "d"]) cache = putImage(cache, uri, ready(1000)).cache;

  // Four times the payload of the entries it displaces, so one eviction is not
  // enough — and the order it takes them in is the order they were used.
  const result = putImage(cache, "big", ready(4000));

  expect(result.evicted).toEqual(["a", "b"]);
  expect(Object.keys(result.cache.images).sort()).toEqual(["big", "c", "d"]);
  expect(result.cache.bytes).toBeLessThanOrEqual(limit);
});

test("an image larger than the whole cache is still stored", () => {
  // Refusing it would mean a picture that can never be displayed. It empties
  // the cache, and the next arrival evicts it.
  const cache = emptyImageCache(10_000);

  const result = putImage(putImage(cache, "a", ready(1000)).cache, "huge", ready(64_000));

  expect(result.evicted).toEqual(["a"]);
  expect(result.cache.images["huge"]).toBeDefined();
});

test("re-putting a uri refreshes recency instead of double-counting", () => {
  const limit = ENTRY_OVERHEAD * 3 + 3000;
  let cache = emptyImageCache(limit);
  for (const uri of ["a", "b", "c"]) cache = putImage(cache, uri, ready(1000)).cache;

  // The same picture arrives twice — `loading` then `ready`, or a retry.
  const again = putImage(cache, "a", ready(1000));
  expect(again.evicted).toEqual([]);
  expect(again.cache.bytes).toBe(cache.bytes);

  // "a" is now the newest, so "b" is what goes when the next one lands.
  const next = putImage(again.cache, "d", ready(1000));
  expect(next.evicted).toEqual(["b"]);
});

test("a loading placeholder replaced by bytes is accounted once", () => {
  const loading = putImage(emptyImageCache(), "a", { status: "loading" }).cache;

  const settled = putImage(loading, "a", ready(2000)).cache;

  expect(settled.bytes).toBe(ENTRY_OVERHEAD + 2000);
  expect(settled.order).toEqual(["a"]);
});

test("entry overhead bounds the number of payload-free entries", () => {
  // `loading` and `error` entries carry no bytes worth counting, and nothing
  // else limits how many of them a transcript can create.
  let cache = emptyImageCache(ENTRY_OVERHEAD * 2);
  for (const uri of ["a", "b", "c"]) {
    cache = putImage(cache, uri, { status: "error" }).cache;
  }

  expect(Object.keys(cache.images).sort()).toEqual(["b", "c"]);
});

test("touch protects a picture that was scrolled back to", () => {
  const limit = ENTRY_OVERHEAD * 2 + 2000;
  let cache = emptyImageCache(limit);
  for (const uri of ["a", "b"]) cache = putImage(cache, uri, ready(1000)).cache;

  const result = putImage(touchImage(cache, "a"), "c", ready(1000));

  expect(result.evicted).toEqual(["b"]);
});

test("touch is identity for an unknown or already-newest uri", () => {
  const cache = putImage(emptyImageCache(), "a", ready(100)).cache;

  expect(touchImage(cache, "a")).toBe(cache);
  expect(touchImage(cache, "missing")).toBe(cache);
});

test("the default ceiling holds a couple of full-size images", () => {
  // The daemon caps one image at 8MB, which is ~11M base64 chars and ~21MB of
  // retained string. Two must fit, or scrolling between two pictures thrashes.
  const oneImage = imageBytes(ready(21 * 1024 * 1024));

  expect(DEFAULT_IMAGE_CACHE_BYTES).toBeGreaterThan(oneImage * 2);
});

test("an empty cache reports nothing held", () => {
  const cache = emptyImageCache();

  expect(cache.images).toEqual({});
  expect(cache.bytes).toBe(0);
  expect(cache.limit).toBe(DEFAULT_IMAGE_CACHE_BYTES);
});
