/**
 * A picture inside the transcript.
 *
 * Three sources reach this one component: bytes that travelled with the message
 * (`data:`), a URL the phone can fetch itself, and — the case that made images
 * appear blank — a path on the *desktop*, which only the daemon can read. The
 * last is resolved over the same socket as everything else, so the component
 * shows a placeholder, then the picture, then a reason if it never arrives.
 *
 * The resolver arrives by context rather than props because images also appear
 * inside markdown, several renderer levels below anything this app controls.
 */
import { createContext, memo, useContext, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Image,
  Pressable,
  StyleSheet,
  Text,
  View,
  type ImageErrorEventData,
  type NativeSyntheticEvent,
} from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import { theme } from "../theme";
import { haptics } from "./haptics";
import { ImageViewer } from "./ImageViewer";
import { imageSourceKind, isDisplayableImage, type ChatImage as ChatImageModel } from "../images";
import type { ImageEntry } from "../useDaemon";

export interface ImageResolver {
  images: Record<string, ImageEntry>;
  fetchImage: (uri: string) => void;
  retryImage: (uri: string) => void;
}

/**
 * Default resolver: no daemon. Desktop paths then report that plainly instead
 * of spinning, which is also what fixtures and tests see.
 */
const ImageResolverContext = createContext<ImageResolver | undefined>(undefined);

export const ImageResolverProvider = ImageResolverContext.Provider;

/** Tall enough to be worth looking at, short enough to scroll past. */
const MAX_HEIGHT = 340;
const DEFAULT_RATIO = 4 / 3;

type Resolved =
  | { status: "ready"; uri: string }
  | { status: "loading" }
  | { status: "error"; message: string; retry?: () => void };

/**
 * Turn a source into something `Image` can take.
 *
 * Local paths are requested on mount and whenever the path changes. The request
 * is deduped by the daemon hook, so a recycled cell scrolling back into view
 * costs nothing.
 */
function useResolvedSource(src: string, origin?: "device"): Resolved {
  const resolver = useContext(ImageResolverContext);
  // A photo attached from this phone is already local to the renderer. It looks
  // exactly like an agent's `file://` path, so only the flag can tell them
  // apart — and asking the daemon for it would fail permanently.
  const kind = origin === "device" ? "remote" : imageSourceKind(src);
  const entry = kind === "local" ? resolver?.images[src] : undefined;
  const fetchImage = resolver?.fetchImage;

  useEffect(() => {
    if (kind !== "local" || !fetchImage) return;
    fetchImage(src);
  }, [kind, src, fetchImage]);

  if (kind !== "local") return { status: "ready", uri: src };
  if (!resolver) return { status: "error", message: "This image is on your computer" };
  if (!entry || entry.status === "loading") return { status: "loading" };
  if (entry.status === "error") {
    return {
      status: "error",
      message: entry.message,
      retry: () => resolver.retryImage(src),
    };
  }
  return { status: "ready", uri: entry.dataUri };
}

function Placeholder({
  ratio,
  children,
}: {
  ratio: number;
  children: React.ReactNode;
}) {
  return <View style={[styles.frame, styles.placeholder, { aspectRatio: ratio }]}>{children}</View>;
}

function ChatImageView({ image }: { image: ChatImageModel }) {
  const resolved = useResolvedSource(image.src, image.origin);
  // Sized from the picture itself once it decodes; until then a stable box, so
  // the transcript does not jump as each image lands.
  const [ratio, setRatio] = useState(DEFAULT_RATIO);
  const [failed, setFailed] = useState<string | undefined>(undefined);
  const [viewing, setViewing] = useState(false);

  // A new source is a new picture: keep neither its predecessor's failure nor a
  // viewer opened on the picture this cell used to hold.
  useEffect(() => {
    setFailed(undefined);
    setViewing(false);
  }, [image.src]);

  // A device attachment is displayable by construction: it was chosen from a
  // photo library, so its own extension is not the authority its mime type is.
  if (image.origin !== "device" && !isDisplayableImage(image.src) && resolved.status !== "ready") {
    return null;
  }

  if (resolved.status === "loading") {
    return (
      <Placeholder ratio={ratio}>
        <ActivityIndicator color={theme.color.textDim} />
      </Placeholder>
    );
  }

  if (resolved.status === "error" || failed) {
    const message = resolved.status === "error" ? resolved.message : failed!;
    // A decode failure is retried locally; a fetch failure goes back to the
    // daemon, which is the half that can actually be temporarily unreachable.
    const retry = resolved.status === "error" ? resolved.retry : () => setFailed(undefined);
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Image failed to load. ${message}. Tap to retry`}
        onPress={retry}
        style={({ pressed }) => [
          styles.frame,
          styles.errorCard,
          pressed && { backgroundColor: theme.color.surfacePressed },
        ]}
      >
        <Ionicons name="image-outline" size={20} color={theme.color.textDim} />
        <Text style={styles.errorText} numberOfLines={3}>
          {message}
        </Text>
        {!!retry && <Text style={styles.retryText}>Tap to retry</Text>}
      </Pressable>
    );
  }

  const onError = (event: NativeSyntheticEvent<ImageErrorEventData>) =>
    setFailed(
      event.nativeEvent?.error
        ? String(event.nativeEvent.error)
        : "Could not display this image",
    );

  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${image.alt || "Image from the agent"}. Tap to view and save`}
        onPress={() => {
          haptics.tap();
          setViewing(true);
        }}
      >
        <Image
          source={{ uri: resolved.uri }}
          // `contain` and a measured ratio together: a wide screenshot keeps its
          // shape instead of being cropped to a square thumbnail.
          resizeMode="contain"
          onLoad={(event) => {
            const { width, height } = event.nativeEvent.source ?? {};
            if (width && height) setRatio(width / height);
          }}
          onError={onError}
          style={[styles.frame, { aspectRatio: ratio }]}
        />
      </Pressable>
      {/* Mounted only while open: a Modal per image in a recycling list would
          keep a native window alive for every picture ever scrolled past. */}
      {viewing && (
        <ImageViewer
          image={image}
          resolvedSrc={resolved.uri}
          visible
          onClose={() => setViewing(false)}
        />
      )}
    </>
  );
}

export const ChatImage = memo(
  ChatImageView,
  (before, after) =>
    before.image.src === after.image.src &&
    before.image.alt === after.image.alt &&
    before.image.origin === after.image.origin,
);

/** The image strip under a message's text. */
export function ChatImages({ images }: { images: readonly ChatImageModel[] }) {
  if (images.length === 0) return null;
  return (
    <View style={styles.stack}>
      {images.map((image, index) => (
        // Keyed by position, not by source: an inline picture's `src` is the
        // whole base64 payload, and React hashes every key on every render.
        // The array is only ever appended to, so position is stable.
        <ChatImage key={index} image={image} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  // The markdown block above ends on a negative margin, so the strip provides
  // its own separation from text rather than relying on the paragraph's.
  stack: { width: "100%", gap: theme.space(2), marginTop: theme.space(1) },
  frame: {
    width: "100%",
    maxHeight: MAX_HEIGHT,
    borderRadius: theme.radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.color.border,
    backgroundColor: theme.color.surface,
    overflow: "hidden",
  },
  placeholder: { alignItems: "center", justifyContent: "center" },
  errorCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.space(2),
    paddingHorizontal: theme.space(3),
    paddingVertical: theme.space(3),
  },
  errorText: { flex: 1, color: theme.color.textDim, fontSize: theme.font.small },
  retryText: { color: theme.color.accent, fontSize: theme.font.tiny, fontWeight: "600" },
});
