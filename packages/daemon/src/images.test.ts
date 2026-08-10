import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  historyImages,
  imageMimeType,
  loadImage,
  nodeImageFs,
  toLocalPath,
} from "./images";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

async function project() {
  const root = await mkdtemp(join(tmpdir(), "pew2-images-"));
  await mkdir(join(root, "out"), { recursive: true });
  await writeFile(join(root, "out", "plot.png"), PNG);
  return root;
}

test("agent paths resolve the way agents actually write them", () => {
  expect(toLocalPath("out/plot.png", "/work/app")).toBe("/work/app/out/plot.png");
  expect(toLocalPath("/work/app/out/plot.png", "/work/app")).toBe("/work/app/out/plot.png");
  expect(toLocalPath("file:///work/app/out/plot.png", "/work")).toBe("/work/app/out/plot.png");
  expect(toLocalPath("~/shots/a.png", "/work", "/Users/me")).toBe("/Users/me/shots/a.png");
  // Not a file on this machine: must never be read as a relative filename.
  expect(toLocalPath("https://x.dev/a.png", "/work")).toBeUndefined();
  expect(toLocalPath("data:image/png;base64,AA", "/work")).toBeUndefined();
});

test("only formats the app can paint are offered", () => {
  expect(imageMimeType("a.PNG")).toBe("image/png");
  expect(imageMimeType("a.jpeg")).toBe("image/jpeg");
  // No renderer ships for SVG, so inlining it would produce an empty frame.
  expect(imageMimeType("a.svg")).toBeUndefined();
  expect(imageMimeType("notes.md")).toBeUndefined();
});

test("an image in the session's project is inlined", async () => {
  const root = await project();
  const image = await loadImage("out/plot.png", { cwd: root });
  expect(image.mimeType).toBe("image/png");
  expect(image.dataUri).toBe(`data:image/png;base64,${PNG.toString("base64")}`);
});

/**
 * A file already open, standing in for one that need not exist here.
 *
 * `loadImage` reads size and kind from the descriptor rather than the path, so a
 * stub has to answer as one.
 */
function openStub(size: number) {
  return {
    size,
    isFile: () => true,
    read: async () => PNG,
    close: async () => {},
  };
}

test("a path outside the project is refused", async () => {
  const root = await project();
  // A real, readable image that simply belongs to another directory — the token
  // is a bearer secret, not auth, and a stolen one must not turn into "read any
  // file on this machine as a picture".
  const elsewhere = resolve(import.meta.dir, "../../app/assets/icon.png");
  await expect(loadImage(elsewhere, { cwd: root, env: {} })).rejects.toThrow(
    /outside this session's project/,
  );
});

test("a symlink is judged by where it points, not how it is spelled", async () => {
  const root = await project();
  await symlink("/Users/someone-else/private/photo.png", join(root, "link.png"));

  // Spelled inside the project, so only resolving first catches it. The stub
  // stands in for a target that need not exist on the machine running this.
  const fs = {
    realpath: async (path: string) =>
      path.endsWith("link.png") ? "/Users/someone-else/private/photo.png" : path,
    open: async () => openStub(PNG.length),
  };
  await expect(loadImage("link.png", { cwd: root, env: {}, fs })).rejects.toThrow(
    /outside this session's project/,
  );
});

test("the temp directory is readable, because generated images land there", async () => {
  const temp = await mkdtemp(join(tmpdir(), "pew2-generated-"));
  await writeFile(join(temp, "out.png"), PNG);
  const image = await loadImage(join(temp, "out.png"), { cwd: await project(), env: {} });
  expect(image.mimeType).toBe("image/png");
});

test("failures explain themselves rather than rendering blank", async () => {
  const root = await project();
  // Awaited: an unawaited rejection assertion passes whatever the code does.
  await expect(loadImage("out/missing.png", { cwd: root })).rejects.toThrow(/was not found/);
  await expect(loadImage("out/plot.svg", { cwd: root })).rejects.toThrow(/not an image/);
  await expect(loadImage("https://x.dev/a.png", { cwd: root })).rejects.toThrow(
    /not a file on this machine/,
  );
});

test("a picture too large to send says so instead of stalling the socket", async () => {
  const root = await project();
  const fs = {
    realpath: async (path: string) => path,
    open: async () => openStub(40 * 1024 * 1024),
  };
  await expect(loadImage("out/plot.png", { cwd: root, fs })).rejects.toThrow(/too large/);
});

test("stored history keeps its pictures, whatever API shape they were saved in", () => {
  // Local replay flattens messages to text; without this a resumed thread lost
  // every screenshot it contained while the live stream showed them fine.
  expect(
    historyImages([
      { type: "text", text: "look" },
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "QQ" } },
      { type: "image", mimeType: "image/png", data: "BB" },
      { type: "image_url", image_url: { url: "data:image/gif;base64,CC" } },
      // Not this daemon's to fetch, and the app can load it itself.
      { type: "image_url", image_url: { url: "https://x.dev/a.png" } },
    ]),
  ).toEqual([
    { type: "image", mimeType: "image/jpeg", data: "QQ" },
    { type: "image", mimeType: "image/png", data: "BB" },
    { type: "image", mimeType: "image/gif", data: "CC" },
  ]);

  expect(historyImages("plain string content")).toEqual([]);
});

test("a file swapped for a symlink after the check is not followed", async () => {
  // The window between resolving a path and reading it. The name passed every
  // check as a real file inside the project; by the time the bytes are read it
  // points at something else entirely, and re-resolving on each call meant the
  // size limit and the containment check described a file that was no longer
  // the one being sent.
  const root = await project();
  const target = join(root, "out", "plot.png");
  await writeFile(target, PNG);

  // Exactly what an attacker with write access to that directory does.
  await rm(target);
  await symlink("/etc/passwd", target);

  // The check is stubbed to answer as it did a moment earlier: a plain file,
  // inside the project. Everything after it is the real filesystem.
  const fs = { realpath: async (path: string) => path, open: nodeImageFs.open };
  await expect(loadImage("out/plot.png", { cwd: root, env: {}, fs })).rejects.toThrow(
    /was not found/,
  );

  // And a genuine file at that path still reads, so this refuses the swap rather
  // than refusing everything.
  await rm(target);
  await writeFile(target, PNG);
  expect((await loadImage("out/plot.png", { cwd: root, env: {}, fs })).mimeType).toBe(
    "image/png",
  );
});

test("a windows drive letter is a path, not a URI scheme", () => {
  // `C:\Users\me\shot.png` matched the scheme test, so on Windows every
  // absolute path was refused as "not a file on this machine" and no
  // agent-produced image could load at all. A scheme needs two or more
  // characters; a drive letter is exactly one.
  expect(toLocalPath("C:\\Users\\me\\shot.png", "C:\\work")).toBeDefined();
  expect(toLocalPath("c:/Users/me/shot.png", "C:\\work")).toBeDefined();

  // The schemes it must still refuse, which is what the check is for.
  expect(toLocalPath("https://x.dev/a.png", "/work")).toBeUndefined();
  expect(toLocalPath("data:image/png;base64,AA", "/work")).toBeUndefined();
  expect(toLocalPath("mcp://server/a.png", "/work")).toBeUndefined();

  // Drive-relative: a path on C:'s *current directory*, wherever that is. Not
  // something an agent means, and it would resolve outside the session's cwd.
  expect(toLocalPath("C:notes.png", "/work")).toBeUndefined();
});
