/**
 * Putting a picture from the transcript into the phone's camera roll.
 *
 * The bytes are always already local by the time this runs — inline base64, or
 * a data URI the daemon sent for a file on the desktop — so saving is: write a
 * real file into the cache and hand its path to the media library. A remote
 * `https://` source is downloaded first, since the media library takes local
 * paths only.
 *
 * This module binds the native SDKs; the naming rules live in the Expo-free
 * `saveImage.ts` so they stay testable.
 */
import { Directory, File, Paths } from "expo-file-system";
import * as MediaLibrary from "expo-media-library";
import * as Sharing from "expo-sharing";
import { Platform } from "react-native";
import { parseDataUri, saveFileName } from "../saveImage";
import type { ChatImage } from "../images";

export type SaveResult =
  | { status: "saved" }
  /** Saved via the share sheet instead, because the library was refused. */
  | { status: "shared" }
  | { status: "denied" }
  | { status: "error"; message: string };

/** Anything left in the scratch directory beyond this is from a previous save. */
const SCRATCH_TTL_MS = 60 * 60 * 1000;

/**
 * Cache scratch space, swept on the way in.
 *
 * Files cannot simply be deleted after sharing: on Android `shareAsync`
 * resolves when the intent is launched, not when the receiving app has finished
 * reading, so an eager delete hands over a file that vanishes mid-read. Old
 * copies are cleared on the *next* save instead, by which time nothing is
 * reading them — and the OS may reclaim the cache directory regardless.
 */
function scratchDirectory(): Directory {
  const directory = new Directory(Paths.cache, "pew2-images");
  directory.create({ intermediates: true, idempotent: true });
  const cutoff = Date.now() - SCRATCH_TTL_MS;
  try {
    for (const entry of directory.list()) {
      // `modificationTime` is already milliseconds since epoch, and is null for
      // a file that cannot be read — which is exactly one worth clearing.
      if (entry instanceof File && (entry.modificationTime ?? 0) < cutoff) entry.delete();
    }
  } catch {
    // Housekeeping only: a sweep that fails must never fail the save itself.
  }
  return directory;
}

/**
 * Materialise the picture as a file this device can hand to the OS.
 *
 * `resolvedSrc` is what is actually on screen: for a desktop path that is the
 * data URI the daemon returned, not the path itself, which means saving never
 * needs a second round trip to the computer.
 */
async function materialise(image: ChatImage, resolvedSrc: string): Promise<File> {
  const parsed = parseDataUri(resolvedSrc);
  const name = saveFileName({
    src: image.src,
    alt: image.alt,
    mimeType: parsed?.mimeType ?? image.mimeType,
  });
  const file = new File(scratchDirectory(), name);

  if (parsed) {
    file.create({ overwrite: true });
    file.write(parsed.base64, { encoding: "base64" });
    return file;
  }

  const downloaded = await File.downloadFileAsync(resolvedSrc, file);
  // Re-wrapped rather than returned: the static resolves to the base class,
  // which has none of the instance helpers the caller uses.
  return new File(downloaded.uri);
}

/**
 * Save one picture, asking for permission if it has not been granted.
 *
 * Permission is requested write-only: pew2 puts pictures in, it never reads the
 * user's library, and asking for full access to answer a save is a permission
 * prompt nobody should have to accept.
 */
export async function saveImageToDevice(
  image: ChatImage,
  resolvedSrc: string,
): Promise<SaveResult> {
  let file: File | undefined;
  try {
    const permission = await MediaLibrary.requestPermissionsAsync(true);
    file = await materialise(image, resolvedSrc);

    if (!permission.granted) {
      // Refusing the camera roll should not mean losing the picture: the share
      // sheet saves, AirDrops or messages the same file without any permission.
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(file.uri, { mimeType: image.mimeType ?? "image/png" });
        return { status: "shared" };
      }
      return { status: "denied" };
    }

    await MediaLibrary.saveToLibraryAsync(file.uri);
    // The camera roll owns its own copy now, so the scratch one is dead weight.
    // Safe to delete here, unlike after a share, because nothing else is
    // holding it open.
    try {
      file.delete();
    } catch {
      // A completed save must not report failure over its own housekeeping.
    }
    return { status: "saved" };
  } catch (error) {
    return {
      status: "error",
      message: error instanceof Error ? error.message : "Could not save this image",
    };
  }
}

/** Share sheet, for sending the picture somewhere other than the camera roll. */
export async function shareImage(image: ChatImage, resolvedSrc: string): Promise<SaveResult> {
  try {
    if (!(await Sharing.isAvailableAsync())) {
      return { status: "error", message: "Sharing is not available on this device" };
    }
    const file = await materialise(image, resolvedSrc);
    await Sharing.shareAsync(file.uri, {
      mimeType: image.mimeType ?? "image/png",
      // iOS reads this as the target type; Android ignores it.
      UTI: Platform.OS === "ios" ? "public.image" : undefined,
    });
    // Deliberately not deleted: see `scratchDirectory`.
    return { status: "shared" };
  } catch (error) {
    return {
      status: "error",
      message: error instanceof Error ? error.message : "Could not share this image",
    };
  }
}
