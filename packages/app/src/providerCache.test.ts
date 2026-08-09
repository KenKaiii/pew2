import { expect, test } from "bun:test";
import { MAX_CACHED_PROVIDERS, fromCachedProviders, toCachedProviders } from "./providerCache";
import type { Provider } from "./useDaemon";

const provider = (id: string, extra: Partial<Provider> = {}): Provider => ({
  id,
  name: id,
  description: "A long description nothing in this app ever renders",
  available: true,
  ...extra,
});

test("a list survives a round trip with what the picker needs", () => {
  const stored = toCachedProviders([
    provider("claude-code", { name: "Claude Code", color: "#d97757" }),
    provider("codex", { available: false, unavailableReason: "Not installed" }),
  ]);
  const restored = fromCachedProviders(stored);

  expect(restored).toEqual([
    { id: "claude-code", name: "Claude Code", description: "", available: true, color: "#d97757" },
    // No remembered reason: offline the phone cannot see why, and the last
    // answer would go on accusing a machine that has since been fixed.
    { id: "codex", name: "codex", description: "", available: false },
  ]);
});

test("an empty list is not written over a good one", () => {
  // The daemon sends an empty `providers` frame while it is still probing.
  expect(toCachedProviders([])).toBeUndefined();
});

test("nothing stored means no providers, exactly as before the cache existed", () => {
  expect(fromCachedProviders(null)).toEqual([]);
  expect(fromCachedProviders(undefined)).toEqual([]);
  expect(fromCachedProviders("")).toEqual([]);
});

test("junk from an older build is ignored rather than half-read", () => {
  expect(fromCachedProviders("not json")).toEqual([]);
  expect(fromCachedProviders('{"id":"solo"}')).toEqual([]);
  // Records missing the fields that identify an agent are skipped; good ones
  // beside them still load.
  expect(fromCachedProviders('[{"name":"no id"},null,7,{"id":"ok","name":"Ok"}]')).toEqual([
    { id: "ok", name: "Ok", description: "", available: false },
  ]);
});

test("an agent is only ready if the record explicitly says so", () => {
  // A build that never wrote `available` must not promise an agent is there.
  expect(fromCachedProviders('[{"id":"a","name":"A"}]')[0]?.available).toBe(false);
  expect(fromCachedProviders('[{"id":"a","name":"A","available":"yes"}]')[0]?.available).toBe(false);
});

test("an implausible list is capped at both ends", () => {
  const many = Array.from({ length: MAX_CACHED_PROVIDERS + 10 }, (_, i) => provider(`p${i}`));
  expect(fromCachedProviders(toCachedProviders(many))).toHaveLength(MAX_CACHED_PROVIDERS);
  // And a stored file that got past an older cap is still capped on read.
  const oversized = JSON.stringify(
    Array.from({ length: 100 }, (_, i) => ({ id: `p${i}`, name: `P${i}` })),
  );
  expect(fromCachedProviders(oversized)).toHaveLength(MAX_CACHED_PROVIDERS);
});

test("the payload stays small enough for the keychain", () => {
  const realistic = Array.from({ length: 12 }, (_, i) =>
    provider(`provider-${i}`, {
      name: `Provider Number ${i}`,
      color: "#d97757",
      available: false,
      unavailableReason: "x".repeat(500),
    }),
  );
  // SecureStore warns past 2048 bytes; descriptions and reasons are dropped
  // precisely so a full install still fits with room to spare.
  expect(toCachedProviders(realistic)!.length).toBeLessThan(2048);
});
