import { describe, expect, test } from "bun:test";
import {
  addAttachments,
  attachmentImages,
  attachmentRejection,
  formatSize,
  isImageAttachment,
  toWireAttachments,
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_TOTAL_BYTES,
  type PendingAttachment,
} from "./attachments";

const file = (over: Partial<PendingAttachment> = {}): PendingAttachment => ({
  id: "1",
  name: "shot.jpg",
  mimeType: "image/jpeg",
  data: "AAAA",
  size: 1024,
  localUri: "file:///var/mobile/shot.jpg",
  ...over,
});

describe("isImageAttachment", () => {
  test("classifies by mime type, not extension", () => {
    expect(isImageAttachment(file({ name: "no-extension" }))).toBe(true);
    expect(isImageAttachment(file({ mimeType: "application/pdf" }))).toBe(false);
  });

  test("SVG is not a picture here, because nothing can paint it", () => {
    // A device attachment skips the source check in ChatImage, so an SVG
    // admitted here would reserve a permanently empty frame. images.ts refuses
    // the same format and the two halves have to agree.
    expect(isImageAttachment(file({ mimeType: "image/svg+xml" }))).toBe(false);
    expect(attachmentImages([file({ mimeType: "image/svg+xml" })])).toEqual([]);
  });
});

describe("attachmentRejection", () => {
  test("accepts a normal pick", () => {
    expect(attachmentRejection([], [file()])).toBeUndefined();
  });

  test("says how much room is left rather than just refusing", () => {
    const existing = Array.from({ length: MAX_ATTACHMENTS - 1 }, (_, i) => file({ id: `${i}` }));
    expect(attachmentRejection(existing, [file(), file()])).toMatch(/Only 1 more file fits/);
  });

  test("names the oversized file", () => {
    const huge = file({ name: "video.mov", size: 20 * 1024 * 1024 });
    const message = attachmentRejection([], [huge]);
    expect(message).toContain("video.mov");
    expect(message).toContain("MB");
  });

  test("catches a total over budget when each file is legal", () => {
    const big = () => file({ size: 7 * 1024 * 1024 });
    expect(attachmentRejection([big()], [big()])).toMatch(/one message/);
  });

  test("picking nothing is not a rejection", () => {
    // Cancelling the picker must not put an error on screen.
    expect(attachmentRejection([], [])).toBeUndefined();
  });
});

describe("addAttachments", () => {
  test("adds what fits", () => {
    expect(addAttachments([], [file()]).attachments).toHaveLength(1);
  });

  test("leaves the list untouched when the pick is refused", () => {
    const existing = [file({ id: "keep" })];
    const result = addAttachments(existing, [file({ size: 20 * 1024 * 1024 })]);
    expect(result.attachments).toEqual(existing);
    expect(result.rejected).toBeDefined();
  });
});

describe("attachmentImages", () => {
  test("marks a phone-local file so it is not fetched from the desktop", () => {
    // Both are `file://`; only the flag says which machine holds the bytes.
    expect(attachmentImages([file()])[0]).toMatchObject({ origin: "device" });
  });

  test("falls back to inline bytes when there is no local uri", () => {
    const image = attachmentImages([file({ localUri: undefined })])[0]!;
    expect(image.src.startsWith("data:image/jpeg;base64,")).toBe(true);
    expect(image.origin).toBeUndefined();
  });

  test("skips non-images", () => {
    expect(attachmentImages([file({ mimeType: "application/pdf" })])).toHaveLength(0);
  });
});

describe("toWireAttachments", () => {
  test("drops device-only fields", () => {
    expect(toWireAttachments([file()])).toEqual([
      { name: "shot.jpg", mimeType: "image/jpeg", data: "AAAA" },
    ]);
  });
});

describe("formatSize", () => {
  test("scales the unit", () => {
    expect(formatSize(512)).toBe("512 B");
    expect(formatSize(2048)).toBe("2 KB");
    expect(formatSize(5 * 1024 * 1024)).toBe("5.0 MB");
  });
});

test("the limits match the protocol's, which the daemon enforces", async () => {
  // Duplicated rather than imported: Metro cannot resolve @pew2/protocol's
  // `.js`-suffixed TS imports, so importing it there breaks the bundle. This
  // test is what keeps the two copies honest — drift would show as the phone
  // cheerfully uploading files the daemon then refuses.
  const { wire } = await import("@pew2/protocol");
  expect(MAX_ATTACHMENTS).toBe(wire.MAX_ATTACHMENTS);
  expect(MAX_ATTACHMENT_BYTES).toBe(wire.MAX_ATTACHMENT_BYTES);
  expect(MAX_ATTACHMENTS_TOTAL_BYTES).toBe(wire.MAX_ATTACHMENTS_TOTAL_BYTES);
});
