import { test, expect } from "bun:test";
import { mkdtemp, mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readConfigPrefs, writeConfigPref } from "./config-prefs.js";

async function tempEnv() {
  const home = await mkdtemp(join(tmpdir(), "pew2-prefs-"));
  return { PEW2_HOME: home } as NodeJS.ProcessEnv;
}

test("a chosen selector reads back for that provider", async () => {
  const env = await tempEnv();
  await writeConfigPref("claude-code", "__acp_model", "opus", env);

  expect(await readConfigPrefs("claude-code", env)).toEqual({
    __acp_model: "opus",
  });
});

test("a second choice merges instead of replacing the first", async () => {
  const env = await tempEnv();
  await writeConfigPref("claude-code", "__acp_model", "opus", env);
  await writeConfigPref("claude-code", "__acp_mode", "plan", env);

  // Picking a mode must not forget the model: they are separate pills, and the
  // user set both deliberately.
  expect(await readConfigPrefs("claude-code", env)).toEqual({
    __acp_model: "opus",
    __acp_mode: "plan",
  });
});

test("providers keep their own settings", async () => {
  const env = await tempEnv();
  await writeConfigPref("claude-code", "__acp_model", "opus", env);
  await writeConfigPref("ggcoder", "__acp_model", "sonnet", env);

  expect(await readConfigPrefs("claude-code", env)).toEqual({
    __acp_model: "opus",
  });
  expect(await readConfigPrefs("ggcoder", env)).toEqual({
    __acp_model: "sonnet",
  });
});

test("re-choosing overwrites rather than accumulating", async () => {
  const env = await tempEnv();
  await writeConfigPref("claude-code", "__acp_model", "opus", env);
  await writeConfigPref("claude-code", "__acp_model", "haiku", env);

  expect(await readConfigPrefs("claude-code", env)).toEqual({
    __acp_model: "haiku",
  });
});

test("booleans survive the round trip", async () => {
  const env = await tempEnv();
  await writeConfigPref("claude-code", "fast", true, env);

  expect(await readConfigPrefs("claude-code", env)).toEqual({ fast: true });
});

test("an unknown provider has no preferences, not an error", async () => {
  expect(await readConfigPrefs("nobody", await tempEnv())).toEqual({});
});

test("a corrupt file is a miss, so a session still starts", async () => {
  const env = await tempEnv();
  await mkdir(env.PEW2_HOME!, { recursive: true });
  await writeFile(join(env.PEW2_HOME!, "config-prefs.json"), "{not json");

  expect(await readConfigPrefs("claude-code", env)).toEqual({});
  // And it recovers: the next write replaces the unreadable file.
  await writeConfigPref("claude-code", "__acp_model", "opus", env);
  expect(await readConfigPrefs("claude-code", env)).toEqual({
    __acp_model: "opus",
  });
});

test("the file is written whole, and readable only by its owner", async () => {
  // Two things at once, because they share a cause: this is a document rewritten
  // from scratch on every change, so a `writeFile` interrupted between truncate
  // and fill loses every provider's settings rather than one, and the process
  // umask decides who else on the machine gets to read the result.
  const env = await tempEnv();
  await writeConfigPref("claude-code", "__acp_model", "opus", env);

  const path = join(env.PEW2_HOME!, "config-prefs.json");
  expect((await stat(path)).mode & 0o077).toBe(0);

  // Nothing left behind: a temp file that survives is a file the next reader
  // may find instead of the real one.
  const stray = (await readdir(env.PEW2_HOME!)).filter((name) => name.endsWith(".tmp"));
  expect(stray).toEqual([]);
});
