/**
 * A health check must not leave the patient running.
 *
 * `pew2 setup` starts every installed agent to find out whether it works. That
 * is the only way to know — but it means setup's failure modes are *processes*,
 * not just wrong words on a screen.
 *
 * Two clocks used to own the same child. `verifyProvider` gave up after its own
 * timeout and returned, while `connectProvider` — which owns the process and is
 * the only thing that can kill it — was still waiting on a much longer budget
 * for a child nobody would ever collect. Every agent that answered the handshake
 * and then stalled left a live process behind, one per agent per run of setup,
 * until the machine was rebooted.
 *
 * These spawn real processes and count them, because that is the only assertion
 * that would have caught it.
 */
import { test, expect } from "bun:test";
import { writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { verifyProvider } from "./verify.js";
import type { LoadedProvider } from "./registry.js";

/** A marker in argv, so only this test's children are ever counted or killed. */
const MARK = `pew2-verify-leak-${process.pid}`;

function liveChildren(): number {
  try {
    const out = execSync(`ps -ax -o command | grep -c '[${MARK[0]}]${MARK.slice(1)}'`).toString();
    return Number(out.trim()) || 0;
  } catch {
    // grep exits 1 when nothing matches, which is the answer, not an error.
    return 0;
  }
}

/** An agent that answers `initialize` and then goes silent, as a wedged one does. */
async function stallingAgent(stage: "handshake" | "session"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pew2-leak-"));
  const file = join(dir, "agent.mjs");
  await writeFile(
    file,
    `
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    ${
      stage === "handshake"
        ? "// Never answers anything at all."
        : `if (msg.method === "initialize") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } }) + "\\n");
    }
    // session/new: deliberately unanswered.`
    }
  }
});
setInterval(() => {}, 1 << 30);
`,
  );
  return file;
}

function provider(script: string): LoadedProvider {
  return {
    manifest: {
      id: "staller",
      name: "Staller",
      pew: { transport: "acp", env: [] },
    },
    source: "test",
    command: process.execPath,
    args: [script, MARK],
    missingEnv: [],
    commandMissing: false,
  } as unknown as LoadedProvider;
}

test("an agent that never answers the handshake is killed, not abandoned", async () => {
  const script = await stallingAgent("handshake");
  expect(liveChildren()).toBe(0);

  const report = await verifyProvider(provider(script), { timeoutMs: 2000 });
  expect(report.status).toBe("failed");

  // Generous, because killing is asynchronous — but bounded, because "it exits
  // eventually" is exactly what was untrue before.
  await new Promise((r) => setTimeout(r, 1500));
  expect(liveChildren()).toBe(0);
});

test("an agent that stalls after the handshake is killed too", async () => {
  // The ordinary not-signed-in shape: the agent comes up fine and then never
  // completes `session/new`. This was the leak that actually fired on a real
  // machine, since `connectProvider` bounded the handshake and nothing else.
  //
  // Only the invariant is asserted, not the wording. Under `bun test` the web
  // stream bridging the child's stdio tears down early, so the run ends on
  // "connection closed" rather than the session timeout — an artefact of the
  // harness, not of the daemon, which runs under `bun run` and reports
  // "answered the handshake but never opened a session" for this exact script.
  // That sentence is asserted where it can be tested honestly, as a pure
  // classification, in `cli/setup-view.test.ts`.
  //
  // Whichever of the two fires, the rule holds and is the thing worth pinning:
  // when verification returns, nothing it started is still running.
  const script = await stallingAgent("session");
  expect(liveChildren()).toBe(0);

  const report = await verifyProvider(provider(script), { timeoutMs: 2000 });
  expect(report.status).toBe("failed");

  await new Promise((r) => setTimeout(r, 1500));
  expect(liveChildren()).toBe(0);
});
