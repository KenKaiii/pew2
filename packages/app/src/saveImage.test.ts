import { expect, test } from "bun:test";
import { extensionForMime, parseDataUri, saveFileName } from "./saveImage";

test("data URIs split into mime and payload", () => {
  expect(parseDataUri("data:image/png;base64,AAAB")).toEqual({
    mimeType: "image/png",
    base64: "AAAB",
  });
  expect(parseDataUri("https://x.dev/a.png")).toBeUndefined();
});

test("extensions follow the bytes, defaulting to png", () => {
  expect(extensionForMime("image/jpeg")).toBe("jpg");
  expect(extensionForMime("IMAGE/PNG")).toBe("png");
  expect(extensionForMime(undefined)).toBe("png");
});

test("saved files keep the name the agent gave them", () => {
  expect(saveFileName({ src: "/tmp/agents/chart v2.png", mimeType: "image/png" })).toBe(
    "chart-v2.png",
  );
  // The mime type describes the actual bytes, so it beats the path's claim.
  expect(saveFileName({ src: "/tmp/shot.png", mimeType: "image/jpeg" })).toBe("shot.jpg");
});

test("a remote source keeps its own extension when nothing has typed it yet", () => {
  // Defaulting to png here would save webp bytes under a name some galleries
  // then refuse to import.
  expect(saveFileName({ src: "https://x.dev/a/b.webp?v=2" })).toBe("b.webp");
  expect(saveFileName({ src: "/tmp/shot.jpeg" })).toBe("shot.jpg");
  // An unknown extension is not trusted — png remains the fallback.
  expect(saveFileName({ src: "/tmp/shot.tiff" })).toBe("shot.png");
});

test("an inline picture with no name gets a searchable timestamp", () => {
  const name = saveFileName(
    { src: "data:image/png;base64,AA", mimeType: "image/png" },
    new Date("2026-08-01T12:34:56.000Z"),
  );
  // No colons: illegal in Android file names.
  expect(name).toBe("pew2-2026-08-01-12-34-56.png");
});

test("a dotfile source does not become a hidden file in the camera roll", () => {
  expect(saveFileName({ src: "/tmp/.plot.png", mimeType: "image/png" })).toBe("plot.png");
  // Nothing left but the extension: falls through to the timestamp.
  expect(
    saveFileName({ src: "/tmp/.png", mimeType: "image/png" }, new Date("2026-08-01T00:00:00Z")),
  ).toBe("pew2-2026-08-01-00-00-00.png");
});

test("alt text names a picture that arrived inline with one", () => {
  expect(saveFileName({ src: "data:image/png;base64,AA", alt: "Sales chart" })).toBe(
    "Sales-chart.png",
  );
});
