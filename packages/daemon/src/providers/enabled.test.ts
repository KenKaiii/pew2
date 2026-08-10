import { test, expect } from "bun:test";
import { mkdtemp, writeFile, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readDisabled, retireLegacyDisabled, setEnabled, writeDisabled } from "./enabled.js";

async function env() {
  const home = await mkdtemp(join(tmpdir(), "pew2-enabled-"));
  return { PEW2_HOME: home } as NodeJS.ProcessEnv;
}

test("everything is on until something is turned off", async () => {
  // The file does not exist on a fresh machine, and the safe direction to fail
  // is "visible": an agent the user wanted must never quietly disappear.
  expect(await readDisabled(await env())).toEqual(new Set());
});

test("turning an agent off survives a reread", async () => {
  const e = await env();
  await setEnabled(["opencode"], false, e);
  expect(await readDisabled(e)).toEqual(new Set(["opencode"]));
});

test("turning it back on removes it again", async () => {
  const e = await env();
  await setEnabled(["opencode", "goose"], false, e);
  await setEnabled(["opencode"], true, e);
  expect(await readDisabled(e)).toEqual(new Set(["goose"]));
});

test("disabling the same agent twice is not an error and does not duplicate", async () => {
  const e = await env();
  await setEnabled(["goose"], false, e);
  await setEnabled(["goose"], false, e);
  expect([...(await readDisabled(e))]).toEqual(["goose"]);
});

test("a new agent installed later is on by default", async () => {
  // Why the file lists what is OFF rather than what is ON. An allowlist would
  // mean every newly installed agent stayed invisible until someone remembered
  // to add it, which is not what a tool that auto-detects should do.
  const e = await env();
  await setEnabled(["goose"], false, e);

  const disabled = await readDisabled(e);
  expect(disabled.has("some-agent-released-next-year")).toBe(false);
});

test("a corrupt file leaves every agent visible", async () => {
  // Half-written or hand-edited. Reading it as "everything is off" would hide
  // the user's entire toolchain with no explanation.
  const e = await env();
  await mkdir(e.PEW2_HOME!, { recursive: true });
  await writeFile(join(e.PEW2_HOME!, "disabled.json"), "{ not json", "utf8");

  expect(await readDisabled(e)).toEqual(new Set());
});

test("a file from a future version is ignored rather than misread", async () => {
  // Version 2 is current, so the newer-than-us case is 3. A file written by a
  // future pew2 may mean something this build cannot infer, and guessing at it
  // would hide agents on the strength of a format never seen.
  const e = await env();
  await mkdir(e.PEW2_HOME!, { recursive: true });
  await writeFile(
    join(e.PEW2_HOME!, "disabled.json"),
    JSON.stringify({ version: 3, disabled: ["opencode"] }),
    "utf8",
  );

  expect(await readDisabled(e)).toEqual(new Set());
  // And it is left alone rather than retired: only an older file is ours to
  // rewrite, or a downgrade would destroy a newer build's settings.
  expect(await retireLegacyDisabled(e)).toEqual([]);
});

test("the list is written sorted, so the file does not churn", async () => {
  // It sits in a directory people back up and occasionally read.
  const e = await env();
  await writeDisabled(["goose", "codex", "opencode"], e);
  const raw = await Bun.file(join(e.PEW2_HOME!, "disabled.json")).text();
  expect(JSON.parse(raw).disabled).toEqual(["codex", "goose", "opencode"]);
});

test("an agent that is not installed is never recorded as a choice", async () => {
  // The picker cannot select an agent that is not on this machine, so treating
  // "not chosen" as "turned off" would write it down as disabled — and it would
  // then stay hidden on the day the user finally installs it. That is exactly
  // the trap this file avoids by storing what is off rather than what is on.
  //
  // This pins the contract `cmdSetup` relies on: only ids it passes in are
  // stored, so the caller can filter and trust the result.
  const e = await env();
  await writeDisabled(["opencode"], e);

  expect(await readDisabled(e)).toEqual(new Set(["opencode"]));
  expect((await readDisabled(e)).has("codex")).toBe(false);
});

/**
 * Retiring version 1.
 *
 * Setup used to make an agent unselectable whenever verification failed, then
 * write every unselected row here — so "not signed in yet" and "the check timed
 * out on a slow first npx download" were both recorded as decisions the user
 * made. Nothing in the file tells those apart from a real choice, so the list
 * cannot be trusted and is not migrated: it is backed up and dropped.
 */
async function writeLegacy(e: NodeJS.ProcessEnv, disabled: string[]) {
  const dir = join(e.PEW2_HOME!, "providers");
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(e.PEW2_HOME!, "disabled.json"),
    JSON.stringify({ version: 1, disabled }, null, 2),
  );
}

test("a version 1 list is not read as a set of choices", async () => {
  const e = await env();
  await writeLegacy(e, ["qwen-code", "cline"]);

  // Until it is retired, it reads as empty — the safe direction. An agent
  // wrongly left on is visible and one tap fixes it; one wrongly left off is
  // invisible, which is the bug this undoes.
  expect(await readDisabled(e)).toEqual(new Set());
});

test("retiring a version 1 list reports what it turned back on", async () => {
  const e = await env();
  await writeLegacy(e, ["qwen-code", "cline"]);

  // Sorted, because it is read aloud on screen.
  expect(await retireLegacyDisabled(e)).toEqual(["cline", "qwen-code"]);
  expect(await readDisabled(e)).toEqual(new Set());

  // The old list is kept: it is the only record of what was in there, and the
  // whole premise is that we cannot be sure how much of it was meant.
  const backup = JSON.parse(
    await readFile(join(e.PEW2_HOME!, "disabled.json.v1.bak"), "utf8"),
  ) as { disabled: string[] };
  expect(backup.disabled.sort()).toEqual(["cline", "qwen-code"]);
});

test("retiring happens once, and never touches a real choice", async () => {
  const e = await env();
  await writeLegacy(e, ["qwen-code"]);
  expect(await retireLegacyDisabled(e)).toEqual(["qwen-code"]);

  // The user then makes an actual choice, in the fixed picker.
  await setEnabled(["opencode"], false, e);

  // A second run must not undo it: version 2 is trusted, so nothing is retired
  // and nothing is restored.
  expect(await retireLegacyDisabled(e)).toEqual([]);
  expect(await readDisabled(e)).toEqual(new Set(["opencode"]));
});

test("nothing to retire on a fresh machine or an already-current file", async () => {
  const e = await env();
  expect(await retireLegacyDisabled(e)).toEqual([]);

  await setEnabled(["goose"], false, e);
  expect(await retireLegacyDisabled(e)).toEqual([]);
  expect(await readDisabled(e)).toEqual(new Set(["goose"]));
});

test("turning an agent off through the CLI backs up a legacy list first", async () => {
  // `pew2 providers disable x` reads, mutates and rewrites. Without retiring
  // first, that rewrite would silently drop the version 1 file instead of
  // keeping it — the same silent loss, just through a different door.
  const e = await env();
  await writeLegacy(e, ["cline"]);

  await setEnabled(["goose"], false, e);

  expect(await readDisabled(e)).toEqual(new Set(["goose"]));
  const backup = JSON.parse(
    await readFile(join(e.PEW2_HOME!, "disabled.json.v1.bak"), "utf8"),
  ) as { disabled: string[] };
  expect(backup.disabled).toEqual(["cline"]);
});
