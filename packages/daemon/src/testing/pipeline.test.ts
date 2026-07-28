/**
 * End-to-end pipeline tests against the local echo agent.
 *
 * These run with no API key and no network, so they are safe to run in CI and
 * are the regression net for the provider contract itself.
 */
import { test, expect } from "bun:test";
import { loadProviders } from "../providers/registry.js";
import { connectProvider } from "../acp/connect.js";
import { SessionLog } from "../session/log.js";

async function echoProvider() {
  const { providers } = await loadProviders();
  const provider = providers.find((p) => p.manifest.id === "echo");
  if (!provider) throw new Error("echo provider missing");
  return provider;
}

test("streams incremental updates and records them in order", async () => {
  const log = new SessionLog("test-session");
  const handle = await connectProvider({
    provider: await echoProvider(),
    cwd: process.cwd(),
    onUpdate: (payload) => log.append(payload),
    onPermissionRequest: () => {},
  });

  await handle.prompt("hello world");
  handle.close();

  expect(log.events.length).toBeGreaterThan(1);

  // Sequence numbers must be gapless and monotonic — this is what makes
  // reconnect-and-replay correct on the phone.
  const seqs = log.events.map((e) => e.seq);
  expect(seqs).toEqual(seqs.map((_, i) => i));

  const text = log.events
    .map((e) => (e as any).payload?.update?.content?.text ?? "")
    .join("");
  expect(text).toContain("hello world");
}, 60_000);

test("permission request round-trips through the client", async () => {
  const log = new SessionLog("test-permission");
  let sawRequest = false;

  const handle = await connectProvider({
    provider: await echoProvider(),
    cwd: process.cwd(),
    onUpdate: (payload) => log.append(payload),
    onPermissionRequest: ({ requestId }) => {
      sawRequest = true;
      handle.answerPermission(requestId, "allow");
    },
  });

  await handle.prompt("please ask for permission");
  handle.close();

  expect(sawRequest).toBe(true);
  const text = log.events
    .map((e) => (e as any).payload?.update?.content?.text ?? "")
    .join("");
  expect(text).toContain("You chose: allow");
}, 60_000);

test("replay after a cursor returns only newer events", () => {
  const log = new SessionLog("s");
  log.append({ n: 1 });
  log.append({ n: 2 });
  log.append({ n: 3 });

  expect(log.since(0).map((e) => (e.payload as any).n)).toEqual([2, 3]);
  expect(log.since(2)).toHaveLength(0);
});
