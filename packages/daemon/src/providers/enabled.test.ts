import { test, expect } from "bun:test";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readDisabled, setEnabled, writeDisabled } from "./enabled.js";

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
  const e = await env();
  await mkdir(e.PEW2_HOME!, { recursive: true });
  await writeFile(
    join(e.PEW2_HOME!, "disabled.json"),
    JSON.stringify({ version: 2, disabled: ["opencode"] }),
    "utf8",
  );

  expect(await readDisabled(e)).toEqual(new Set());
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
