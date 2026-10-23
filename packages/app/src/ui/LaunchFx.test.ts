import { expect, test } from "bun:test";

// LaunchFx imports React Native and Skia, which bun cannot load, so its source
// is read instead (the same approach as canvasOverlay.test.ts).
const source = await Bun.file(new URL("LaunchFx.tsx", import.meta.url).pathname).text();

test("every full-screen effect canvas sits inside a touch-through View", () => {
  // Skia's Android view ignores `pointerEvents`: a bare full-screen Canvas took
  // every touch, so holding Ken (and Close, and Back) did nothing on Android.
  // The only Canvas in the file is FxCanvas's, wrapped in a plain View.
  expect(source.match(/<Canvas\b/g)).toHaveLength(1);
  expect(source).toMatch(
    /<View style=\{StyleSheet\.absoluteFill\} pointerEvents="none">\s*<Canvas\b/,
  );
});

test("the launch, calling and pop effects all draw through FxCanvas", () => {
  for (const fx of ["LaunchFx", "CallingFx", "PopFx"]) {
    const start = source.indexOf(`export function ${fx}(`);
    expect(start).toBeGreaterThan(-1);
    const next = source.indexOf("\nexport function ", start + 1);
    const body = source.slice(start, next === -1 ? undefined : next);
    expect(body).toContain("<FxCanvas ");
  }
});
