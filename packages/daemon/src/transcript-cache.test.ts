import { test, expect } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTranscript, writeTranscript } from "./transcript-cache.js";

async function env() {
  const home = await mkdtemp(join(tmpdir(), "pew2-transcript-"));
  return { PEW2_HOME: home } as NodeJS.ProcessEnv;
}

const update = (text: string, role = "user") => ({
  sessionId: "s1",
  update: { sessionUpdate: `${role}_message_chunk`, content: { type: "text", text } },
});

test("a stored transcript comes back exactly as it went in", async () => {
  // The whole point: reopening a conversation paints from this instead of
  // waiting two to three seconds for the agent process to spawn and replay.
  const e = await env();
  await writeTranscript("opencode", "ses_1", [update("hello"), update("hi", "agent")], e);

  const back = await readTranscript("opencode", "ses_1", e);
  expect(back).toHaveLength(2);
  expect((back![0] as any).update.content.text).toBe("hello");
});

test("no cache is not an error, just a slower open", async () => {
  const e = await env();
  expect(await readTranscript("opencode", "never-seen", e)).toBeUndefined();
});

test("a transcript never paints into the wrong conversation", async () => {
  // Ids reach the filesystem, so two conversations must not be able to collide
  // into one file and show each other's messages.
  const e = await env();
  await writeTranscript("opencode", "ses_a", [update("from A")], e);
  await writeTranscript("opencode", "ses_b", [update("from B")], e);

  expect((await readTranscript("opencode", "ses_a", e))![0]).toMatchObject({
    update: { content: { text: "from A" } },
  });
  expect((await readTranscript("opencode", "ses_b", e))![0]).toMatchObject({
    update: { content: { text: "from B" } },
  });
});

test("an id full of path characters cannot escape the cache directory", async () => {
  // `../../` in a session id would otherwise write wherever it pointed.
  const e = await env();
  await writeTranscript("opencode", "../../escape", [update("nope")], e);

  expect(await readTranscript("opencode", "../../escape", e)).toHaveLength(1);
  // And it did not land under a sibling of the cache directory.
  expect(await readTranscript("opencode", "escape", e)).toBeUndefined();
});

test("providers do not share a conversation id", async () => {
  const e = await env();
  await writeTranscript("opencode", "same-id", [update("opencode")], e);
  await writeTranscript("github-copilot", "same-id", [update("copilot")], e);

  expect((await readTranscript("opencode", "same-id", e))![0]).toMatchObject({
    update: { content: { text: "opencode" } },
  });
});

test("an empty replay is not written", async () => {
  // A conversation with nothing in it must not leave a file that then reads as
  // a real but empty transcript on the next open.
  const e = await env();
  await writeTranscript("opencode", "ses_empty", [], e);
  expect(await readTranscript("opencode", "ses_empty", e)).toBeUndefined();
});

test("a very long conversation keeps its most recent updates", async () => {
  // The tail is what is on screen. Storing everything would have the daemon
  // parsing megabytes on a tap, which is the cost this exists to avoid.
  const e = await env();
  const many = Array.from({ length: 600 }, (_, i) => update(`line ${i}`));
  await writeTranscript("opencode", "ses_long", many, e);

  const back = await readTranscript("opencode", "ses_long", e);
  expect(back!.length).toBeLessThanOrEqual(400);
  expect((back!.at(-1) as any).update.content.text).toBe("line 599");
});

test("two ids that scrub to the same filename do not show each other's messages", async () => {
  // Scrubbing maps every unsafe character to `_`, so `a/b` and `a_b` land on
  // one file. The stored id is what stops the second one painting the first
  // one's conversation.
  const e = await env();
  await writeTranscript("opencode", "a/b", [update("from a slash b")], e);

  expect(await readTranscript("opencode", "a_b", e)).toBeUndefined();
  expect((await readTranscript("opencode", "a/b", e))![0]).toMatchObject({
    update: { content: { text: "from a slash b" } },
  });
});
