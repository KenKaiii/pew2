/**
 * Provider verification, as a function rather than a printer.
 *
 * `verify` is the only thing in pew2 that proves a provider actually works: it
 * spawns the process, completes the ACP handshake, sends a real prompt and
 * counts what came back. That makes it the pass/fail signal a coding agent
 * needs, so it has to be callable — and structured — rather than console output
 * to be scraped.
 */
import { connectProvider } from "../acp/connect.js";
import { isAvailable, unavailableReason, type LoadedProvider } from "./registry.js";

export type VerifyStatus = "ok" | "failed" | "skipped";

export interface VerifyReport {
  id: string;
  status: VerifyStatus;
  /** The agent's own session id. Present only on success. */
  sessionId?: string;
  /**
   * How many `session/update` notifications arrived.
   *
   * Zero with `status: "ok"` is the interesting case: the process started and
   * answered the handshake but streamed nothing, which almost always means it
   * is not really in ACP mode.
   */
  updates?: number;
  /** Why it failed, or why it was skipped. */
  detail?: string;
}

export interface VerifyOptions {
  cwd?: string;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 60_000;

export async function verifyProvider(
  provider: LoadedProvider,
  options: VerifyOptions = {},
): Promise<VerifyReport> {
  const id = provider.manifest.id;

  if (!isAvailable(provider)) {
    return { id, status: "skipped", detail: unavailableReason(provider) };
  }
  if (provider.manifest.pew.transport !== "acp") {
    return {
      id,
      status: "skipped",
      detail: `Transport '${provider.manifest.pew.transport}' cannot be verified`,
    };
  }

  const updates: unknown[] = [];
  let handle: Awaited<ReturnType<typeof connectProvider>> | undefined;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // An agent that never answers must not hang the whole run. Racing rather than
  // `process.exit` keeps every other provider verifiable, which matters when
  // `setup` verifies all of them in one pass.
  let expire: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    expire = setTimeout(
      () =>
        reject(
          new Error(
            `Timed out after ${Math.round(timeoutMs / 1000)}s — the process started but never completed the ACP handshake. Check the adapter's flags.`,
          ),
        ),
      timeoutMs,
    );
  });

  try {
    const run = (async () => {
      handle = await connectProvider({
        provider,
        cwd: options.cwd ?? process.cwd(),
        onUpdate: (payload) => updates.push(payload),
        // Auto-approve during verification so the round trip can complete.
        onPermissionRequest: ({ requestId }) => handle?.answerPermission(requestId, "allow"),
      });
      await handle.prompt("Hello from pew2 verify.");
      return handle.sessionId;
    })();

    const sessionId = await Promise.race([run, timeout]);
    return { id, status: "ok", sessionId, updates: updates.length };
  } catch (error) {
    return { id, status: "failed", detail: (error as Error).message };
  } finally {
    clearTimeout(expire);
    handle?.close();
  }
}

export async function verifyAll(
  providers: LoadedProvider[],
  options: VerifyOptions = {},
): Promise<VerifyReport[]> {
  const reports: VerifyReport[] = [];
  // Sequential on purpose: several agents spawning at once compete for the same
  // npx cache and produce confusing, interleaved failures.
  for (const provider of providers) reports.push(await verifyProvider(provider, options));
  return reports;
}
