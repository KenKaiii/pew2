/**
 * Reading an image off the desktop's disk for a phone that cannot see it.
 *
 * Agents display pictures by *naming a file*: an ACP `resource_link`, an
 * embedded resource, or plain markdown like `![](.gg/generated/plot.png)`. On
 * the machine running the agent that renders; on the phone it is a blank box.
 * The daemon is the only process that can read that path, so it turns it into
 * a data URI the app can paint.
 *
 * The path arrives from the *agent*, not from a trusted UI, so it is treated as
 * untrusted input: resolved, symlink-followed, then checked to be inside a root
 * the user already exposed by running a session there. Everything here is pure
 * apart from the two injected fs calls, so the containment rules are testable.
 */
import { readFile, realpath, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, resolve, sep, extname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Formats React Native's `Image` can actually paint. SVG is deliberately absent:
 * it needs a renderer the app does not ship, and inlining it would produce a
 * silent empty frame rather than a picture.
 */
const MIME_BY_EXTENSION: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".heic": "image/heic",
  ".heif": "image/heif",
};

/**
 * Above this the transfer costs more than the picture is worth on a phone.
 *
 * Base64 inflates by a third, so 8MB leaves roughly 11MB on the wire — inside
 * the Durable Object's 32 MiB received-message ceiling, which is the hard limit
 * the remote path would otherwise hit as a socket that simply dies. The daemon
 * ships no image library and cannot downscale, so it declines and says why.
 */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/** The mime type for a path, or undefined when it is not a paintable image. */
export function imageMimeType(path: string): string | undefined {
  return MIME_BY_EXTENSION[extname(path).toLowerCase()];
}

/**
 * Turn whatever the agent wrote into an absolute path.
 *
 * `file://` URLs, `~`, and paths relative to the session's working directory
 * are all normal in agent output. A URI with any other scheme is not on this
 * disk and returns undefined, so callers never accidentally read `http:` as a
 * relative filename.
 */
export function toLocalPath(
  uri: string,
  cwd: string,
  home: string = homedir(),
): string | undefined {
  const raw = uri.trim();
  if (!raw) return undefined;

  if (raw.startsWith("file://")) {
    try {
      return fileURLToPath(raw);
    } catch {
      return undefined;
    }
  }
  // Any other scheme (http:, data:, mcp:) is not a file on this machine.
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw)) return undefined;

  if (raw === "~") return home;
  if (raw.startsWith("~/")) return resolve(home, raw.slice(2));
  return isAbsolute(raw) ? resolve(raw) : resolve(cwd, raw);
}

/** True when `path` is `root` or sits underneath it. */
function isInside(path: string, root: string): boolean {
  const base = resolve(root);
  return path === base || path.startsWith(base.endsWith(sep) ? base : base + sep);
}

/**
 * The directories an image may be read from.
 *
 * The session's own working directory is the point: the user pointed an agent
 * at that project, so its files are already in play. The temp directory is
 * included because generation tools routinely write there before anything is
 * committed. Nothing else — the pairing token is a bearer secret, and a stolen
 * one must not turn into "read any file on the machine as a picture".
 */
export function allowedImageRoots(cwd: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const roots = [resolve(cwd), resolve(tmpdir())];
  if (env.PEW2_IMAGE_ROOTS) {
    for (const extra of env.PEW2_IMAGE_ROOTS.split(":")) {
      if (extra.trim()) roots.push(resolve(extra.trim()));
    }
  }
  return roots;
}

/** An ACP image block, as the app's content parser expects to receive it. */
export interface ImageBlock {
  type: "image";
  mimeType: string;
  data: string;
}

/**
 * Pictures inside a message read from an agent's own on-disk history.
 *
 * The JSONL formats are not ACP: an attached or generated image is stored the
 * way the underlying model API took it — Anthropic's `{ source: { data } }`, or
 * an OpenAI-style `image_url`. Local replay flattens messages to text, so
 * without this a resumed conversation silently lost every picture it contained
 * while the live stream showed them fine.
 */
export function historyImages(content: unknown): ImageBlock[] {
  if (!Array.isArray(content)) return [];
  const images: ImageBlock[] = [];
  for (const part of content as any[]) {
    if (!part || typeof part !== "object") continue;

    // Anthropic: { type: "image", source: { type: "base64", media_type, data } }
    const source = part.source;
    if (part.type === "image" && source?.type === "base64" && typeof source.data === "string") {
      images.push({
        type: "image",
        mimeType: typeof source.media_type === "string" ? source.media_type : "image/png",
        data: source.data,
      });
      continue;
    }

    // Already ACP-shaped, which is what GG Coder stores.
    if (part.type === "image" && typeof part.data === "string") {
      images.push({
        type: "image",
        mimeType: typeof part.mimeType === "string" ? part.mimeType : "image/png",
        data: part.data,
      });
      continue;
    }

    // OpenAI: { type: "image_url", image_url: { url: "data:image/png;base64,..." } }
    const url = part.image_url?.url ?? part.imageUrl?.url;
    if (typeof url === "string") {
      const match = /^data:([^;,]+);base64,(.+)$/s.exec(url);
      // Only inline data: a remote URL in stored history is not this daemon's
      // to fetch, and the app can load it itself.
      if (match) images.push({ type: "image", mimeType: match[1]!, data: match[2]! });
    }
  }
  return images;
}

export interface LoadedImage {
  dataUri: string;
  mimeType: string;
}

export interface ImageFs {
  realpath: (path: string) => Promise<string>;
  stat: (path: string) => Promise<{ size: number; isFile: () => boolean }>;
  readFile: (path: string) => Promise<Buffer>;
}

const nodeFs: ImageFs = { realpath, stat, readFile };

/**
 * Read one image and inline it, or explain why not.
 *
 * Throws with a sentence meant for the user: the app renders the failure in
 * place of the picture, and "blank box, no reason" is the bug this whole path
 * exists to remove.
 */
export async function loadImage(
  uri: string,
  options: { cwd: string; env?: NodeJS.ProcessEnv; fs?: ImageFs; home?: string },
): Promise<LoadedImage> {
  const fs = options.fs ?? nodeFs;
  const path = toLocalPath(uri, options.cwd, options.home);
  if (!path) throw new Error(`'${uri}' is not a file on this machine`);

  const mimeType = imageMimeType(path);
  if (!mimeType) throw new Error(`'${uri}' is not an image this app can display`);

  // Resolve symlinks *before* the containment check: `project/link -> /etc` is
  // otherwise inside the root by spelling alone.
  let real: string;
  try {
    real = resolve(await fs.realpath(path));
  } catch {
    throw new Error(`'${uri}' was not found`);
  }

  // Roots are resolved the same way as the file. On macOS `/tmp` and
  // `/var/folders/...` are symlinks, so comparing a real path against a spelled
  // root rejects files that are plainly inside the project.
  const roots = await Promise.all(
    allowedImageRoots(options.cwd, options.env).map(async (root) => {
      try {
        return resolve(await fs.realpath(root));
      } catch {
        return root;
      }
    }),
  );
  if (!roots.some((root) => isInside(real, root))) {
    throw new Error(`'${uri}' is outside this session's project directory`);
  }

  const info = await fs.stat(real);
  if (!info.isFile()) throw new Error(`'${uri}' is not a file`);
  if (info.size > MAX_IMAGE_BYTES) {
    throw new Error(
      `'${uri}' is ${Math.round(info.size / 1024 / 1024)}MB, too large to send to the app`,
    );
  }

  const bytes = await fs.readFile(real);
  return { mimeType, dataUri: `data:${mimeType};base64,${bytes.toString("base64")}` };
}
