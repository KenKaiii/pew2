import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  attachmentDir,
  attachmentFileName,
  attachmentLimitError,
  base64Bytes,
  discardAttachments,
  safeSegment,
  storeAttachments,
} from "./attachments.js";
import { POSIX_MODES } from "./testing/platform.js";

const b64 = (text: string) => Buffer.from(text).toString("base64");
const bytes = (count: number) => Buffer.alloc(count, 7).toString("base64");

describe("safeSegment", () => {
  test("keeps an ordinary filename intact", () => {
    expect(safeSegment("screenshot.png", "x")).toBe("screenshot.png");
  });

  test("neutralises traversal and separators", () => {
    // The whole point: nothing a phone sends may escape its own directory.
    expect(safeSegment("../../etc/passwd", "x")).not.toContain("/");
    expect(safeSegment("../../etc/passwd", "x")).not.toContain("..");
    expect(safeSegment("a\\b.txt", "x")).toBe("a_b.txt");
  });

  test("falls back when nothing usable survives", () => {
    // "..", "." and "" all resolve to a directory rather than a file in it.
    expect(safeSegment("..", "fallback")).toBe("fallback");
    expect(safeSegment("   ", "fallback")).toBe("fallback");
    expect(safeSegment("/", "fallback")).toBe("fallback");
  });

  test("caps length", () => {
    expect(safeSegment("a".repeat(500), "x")).toHaveLength(64);
  });
});

describe("attachmentFileName", () => {
  test("prefixes with the index so duplicate names survive", () => {
    // Two photos from a camera roll are very often both `image.jpg`.
    expect(attachmentFileName("image.jpg", 0)).toBe("0-image.jpg");
    expect(attachmentFileName("image.jpg", 1)).toBe("1-image.jpg");
  });
});

describe("base64Bytes", () => {
  test("counts decoded bytes without decoding", () => {
    for (const size of [0, 1, 2, 3, 1000, 4096]) {
      expect(base64Bytes(bytes(size))).toBe(size);
    }
  });
});

describe("attachmentLimitError", () => {
  const attachment = (name: string, data: string) => ({ name, mimeType: "text/plain", data });

  test("passes a reasonable set", () => {
    expect(attachmentLimitError([attachment("a.txt", b64("hi"))])).toBeUndefined();
  });

  test("rejects too many files", () => {
    const many = Array.from({ length: 6 }, (_, i) => attachment(`${i}.txt`, b64("hi")));
    expect(attachmentLimitError(many)).toMatch(/Too many/);
  });

  test("names the file that is too big", () => {
    const error = attachmentLimitError([attachment("huge.bin", bytes(9 * 1024 * 1024))]);
    expect(error).toContain("huge.bin");
  });

  test("rejects a total over budget even when each file is legal", () => {
    const two = [
      attachment("a.bin", bytes(7 * 1024 * 1024)),
      attachment("b.bin", bytes(7 * 1024 * 1024)),
    ];
    expect(attachmentLimitError(two)).toMatch(/total/i);
  });
});

describe("storeAttachments", () => {
  test("writes the bytes and reports where", async () => {
    const root = await mkdtemp(join(tmpdir(), "pew2-test-"));
    const stored = await storeAttachments(
      "sess-1",
      [{ name: "notes.txt", mimeType: "text/plain", data: b64("hello") }],
      root,
    );

    expect(stored).toHaveLength(1);
    expect(stored[0]!.size).toBe(5);
    expect(await readFile(stored[0]!.path, "utf8")).toBe("hello");
  });

  test("a hostile name stays inside the session directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "pew2-test-"));
    const stored = await storeAttachments(
      "sess-1",
      [{ name: "../../escaped.txt", mimeType: "text/plain", data: b64("nope") }],
      root,
    );
    expect(dirname(stored[0]!.path)).toBe(attachmentDir("sess-1", root));
  });

  test("refuses a set over the limits rather than truncating it", async () => {
    const root = await mkdtemp(join(tmpdir(), "pew2-test-"));
    // Silently dropping one would leave a prompt referring to a file the agent
    // never received.
    await expect(
      storeAttachments("sess-1", [{ name: "x.bin", mimeType: "application/octet-stream", data: bytes(9 * 1024 * 1024) }], root),
    ).rejects.toThrow(/limit/);
  });

  test("discard removes the session's files", async () => {
    const root = await mkdtemp(join(tmpdir(), "pew2-test-"));
    await storeAttachments("sess-1", [{ name: "a.txt", mimeType: "text/plain", data: b64("a") }], root);
    await discardAttachments("sess-1", root);
    await expect(readdir(attachmentDir("sess-1", root))).rejects.toThrow();
  });

  test("discarding a session that never had attachments is not an error", async () => {
    const root = await mkdtemp(join(tmpdir(), "pew2-test-"));
    await discardAttachments("never", root);
  });

  test("what lands on disk is readable only by its owner", async () => {
    // These live in a shared temp directory, at a path derived from a session
    // id, and `image.fetch` allows that directory as a root. At the default
    // 0755/0644 a photo someone sent to their own machine was readable by every
    // other account on it.
    const root = await mkdtemp(join(tmpdir(), "pew2-test-"));
    const stored = await storeAttachments(
      "sess-1",
      [{ name: "shot.png", mimeType: "image/png", data: b64("png") }],
      root,
    );

    // Guarded, not deleted: Windows has no permission bits. NTFS uses ACLs and
    // `stat().mode` is a synthesised value there, so this assertion would be
    // testing Node's emulation rather than the daemon.
    if (POSIX_MODES) {
      const file = await stat(stored[0]!.path);
      const dir = await stat(attachmentDir("sess-1", root));
      expect(file.mode & 0o077).toBe(0);
      expect(dir.mode & 0o077).toBe(0);
    }
  });
});
