/**
 * Getting a file off this phone and into a shape the wire accepts.
 *
 * Binds the Expo pickers, the same split as `imageSaver.ts`: the rules about
 * limits, naming and rendering live in the Expo-free `../attachments`, and this
 * module does the parts that need native SDKs.
 *
 * The work that is not obvious is **downscaling**. A modern phone camera
 * produces 4–12MB per shot, and base64 adds a third on top; three of those
 * exceed what the relay's Durable Object will accept as a single message, and
 * no model needs 48 megapixels to read a screenshot. Images are therefore
 * resized to a long edge no bigger than a vision model's own working resolution
 * before their bytes are ever read.
 */
import * as DocumentPicker from "expo-document-picker";
import { File } from "expo-file-system";
import * as ImagePicker from "expo-image-picker";
import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import type { PendingAttachment } from "../attachments";
import { MAX_ATTACHMENTS } from "../attachments";

/**
 * The long edge an attached image is reduced to.
 *
 * 1568px is the largest dimension the major vision models actually use; beyond
 * it the extra pixels are discarded after upload, having cost the user's data
 * allowance on the way.
 */
const MAX_IMAGE_EDGE = 1568;

/** Below this an image is sent untouched — re-encoding would only lose quality. */
const RECOMPRESS_ABOVE_BYTES = 512 * 1024;

let nextId = 0;
function makeId(): string {
  return `attachment-${Date.now()}-${nextId++}`;
}

/** Permission outcomes a caller has to tell apart to explain itself. */
export type PickOutcome =
  | { status: "picked"; attachments: PendingAttachment[] }
  /** The user backed out. Not an error, and nothing should be said about it. */
  | { status: "cancelled" }
  | { status: "denied"; message: string }
  | { status: "error"; message: string };

function failure(error: unknown): PickOutcome {
  return {
    status: "error",
    message: error instanceof Error ? error.message : "That file could not be read.",
  };
}

/**
 * Name a file when the picker would not.
 *
 * A camera capture has no filename at all, and an Android content URI often
 * hides it. Something readable has to reach the agent, because the name is how
 * the prompt refers to it ("the error in log.txt").
 */
function assetName(uri: string, fallbackExtension: string, provided?: string | null): string {
  if (provided) return provided;
  const tail = uri.split("/").pop()?.split("?")[0];
  if (tail && tail.includes(".")) return decodeURIComponent(tail);
  return `image-${new Date().toISOString().replace(/[:.]/g, "-")}.${fallbackExtension}`;
}

function guessMimeType(name: string, provided?: string | null): string {
  if (provided) return provided;
  const extension = name.split(".").pop()?.toLowerCase() ?? "";
  const known: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    heic: "image/heic",
    txt: "text/plain",
    md: "text/markdown",
    json: "application/json",
    csv: "text/csv",
    log: "text/plain",
    patch: "text/x-patch",
    diff: "text/x-patch",
    pdf: "application/pdf",
  };
  return known[extension] ?? "application/octet-stream";
}

/**
 * Shrink an image if it is worth shrinking, and read its bytes.
 *
 * A failed manipulation falls through to the original file rather than losing
 * the attachment: an image too odd to resize is still one the daemon can accept
 * if it happens to be small enough, and the limit check downstream is the
 * authority either way.
 */
async function readImage(uri: string, name: string, mimeType: string): Promise<PendingAttachment> {
  const original = new File(uri);
  const originalSize = original.size ?? 0;

  if (originalSize > 0 && originalSize <= RECOMPRESS_ABOVE_BYTES) {
    return {
      id: makeId(),
      name,
      mimeType,
      data: await original.base64(),
      size: originalSize,
      localUri: uri,
    };
  }

  try {
    const context = ImageManipulator.manipulate(uri);
    // The cap is on the *long* edge, and only the source knows which one that
    // is: a portrait photo constrained by `width` comes back taller than the
    // limit, and a narrow one is scaled *up* — the opposite of why this runs.
    // So the image is loaded once to be measured, then resized on the edge
    // that is actually too big; only that dimension is passed, and the other
    // follows from the aspect ratio.
    const loaded = await context.renderAsync();
    const longEdge = Math.max(loaded.width, loaded.height);
    const rendered =
      longEdge > MAX_IMAGE_EDGE
        ? await context
            .resize(
              loaded.width >= loaded.height
                ? { width: MAX_IMAGE_EDGE }
                : { height: MAX_IMAGE_EDGE },
            )
            .renderAsync()
        : // Already small enough to send as-is dimensionally, but it got here
          // by being heavy, so it still goes through the JPEG recompress below.
          loaded;
    const saved = await rendered.saveAsync({ format: SaveFormat.JPEG, compress: 0.8 });
    const file = new File(saved.uri);
    return {
      id: makeId(),
      // The name follows the bytes: claiming `.png` for JPEG data would have the
      // daemon write a file no tool can open by its extension.
      name: name.replace(/\.[^.]*$/, "") + ".jpg",
      mimeType: "image/jpeg",
      data: await file.base64(),
      size: file.size ?? 0,
      localUri: saved.uri,
    };
  } catch {
    return {
      id: makeId(),
      name,
      mimeType,
      data: await original.base64(),
      size: originalSize,
      localUri: uri,
    };
  }
}

/** Photos from the library. Multi-select, capped at what one message can hold. */
export async function pickPhotos(room: number = MAX_ATTACHMENTS): Promise<PickOutcome> {
  try {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      return {
        status: "denied",
        message: "Photo access is off for pew2. Turn it on in Settings to attach pictures.",
      };
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      allowsMultipleSelection: true,
      selectionLimit: Math.max(1, room),
      // Deliberately not `base64: true`: that would decode the *original* photo
      // into a JS string, which is the allocation the resize exists to avoid.
      quality: 1,
      exif: false,
    });
    if (result.canceled) return { status: "cancelled" };

    const attachments: PendingAttachment[] = [];
    for (const asset of result.assets) {
      const name = assetName(asset.uri, "jpg", asset.fileName);
      attachments.push(await readImage(asset.uri, name, guessMimeType(name, asset.mimeType)));
    }
    return { status: "picked", attachments };
  } catch (error) {
    return failure(error);
  }
}

/** A photo taken now. The reason to reach for a phone at all. */
export async function takePhoto(): Promise<PickOutcome> {
  try {
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) {
      return {
        status: "denied",
        message: "Camera access is off for pew2. Turn it on in Settings to take a photo.",
      };
    }

    const result = await ImagePicker.launchCameraAsync({
      mediaTypes: ["images"],
      quality: 1,
      exif: false,
    });
    if (result.canceled) return { status: "cancelled" };

    const asset = result.assets[0];
    if (!asset) return { status: "cancelled" };
    const name = assetName(asset.uri, "jpg", asset.fileName);
    return {
      status: "picked",
      attachments: [await readImage(asset.uri, name, guessMimeType(name, asset.mimeType))],
    };
  } catch (error) {
    return failure(error);
  }
}

/** Anything else: a log, a diff, a PDF. No permission prompt on either platform. */
export async function pickFiles(room: number = MAX_ATTACHMENTS): Promise<PickOutcome> {
  try {
    const result = await DocumentPicker.getDocumentAsync({
      type: "*/*",
      multiple: room > 1,
      // Required: an Android content:// URI is not readable as a file until it
      // has been copied somewhere this app owns.
      copyToCacheDirectory: true,
    });
    if (result.canceled) return { status: "cancelled" };

    const attachments: PendingAttachment[] = [];
    for (const asset of result.assets.slice(0, Math.max(1, room))) {
      const name = assetName(asset.uri, "bin", asset.name);
      const mimeType = guessMimeType(name, asset.mimeType);
      // A picture chosen through the file browser is still a picture, and is
      // worth the same downscale a camera roll photo gets.
      if (mimeType.startsWith("image/")) {
        attachments.push(await readImage(asset.uri, name, mimeType));
        continue;
      }
      const file = new File(asset.uri);
      attachments.push({
        id: makeId(),
        name,
        mimeType,
        data: await file.base64(),
        size: asset.size ?? file.size ?? 0,
        localUri: asset.uri,
      });
    }
    return { status: "picked", attachments };
  } catch (error) {
    return failure(error);
  }
}
