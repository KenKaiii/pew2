/**
 * Provider verification, as a function rather than a printer.
 *
 * `verify` is the only thing in pew2 that proves a provider actually works: it
 * spawns the process, completes the ACP handshake, sends a real prompt and
 * counts what came back. That makes it the pass/fail signal a coding agent
 * needs, so it has to be callable — and structured — rather than console output
 * to be scraped.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
        // A scratch directory, not the user's. Verification really starts each
        // agent and sends it a prompt, and agents write files where they are
        // pointed — running `pew2 setup` inside a project left junk in it, which
        // is a rude thing for a health check to do.
        cwd: options.cwd ?? scratchDir(),
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
    return { id, status: "failed", detail: describe(error) };
  } finally {
    clearTimeout(expire);
    handle?.close();
  }
}

/**
 * Where verification runs agents.
 *
 * Created once per process under the system temp directory. Not cleaned up on
 * purpose: an agent may still be shutting down when verification returns, and
 * deleting the directory underneath it turns a clean exit into an error in the
 * log. The OS clears temp itself.
 */
let scratch: string | undefined;
function scratchDir(): string {
  if (!scratch) {
    scratch = mkdtempSync(join(tmpdir(), "pew2-verify-"));
  }
  return scratch;
}

/**
 * The most specific thing an agent said about a failure.
 *
 * JSON-RPC puts a generic string in `message` and the real explanation in
 * `data`, so reading `message` alone turns "Configuration value not found:
 * GOOSE_PROVIDER" into "Internal error" — a fixable setup step reported as an
 * unexplained crash. That single word is the difference between a user running
 * one command and a user filing an issue.
 */
export function describe(error: unknown): string {
  if (typeof error !== "object" || error === null) return String(error);

  const data = (error as { data?: unknown }).data;
  if (typeof data === "string" && data.trim()) return data.trim();
  // Some agents nest it one deeper, as `{ data: { message } }`.
  if (typeof data === "object" && data !== null) {
    const nested = (data as { message?: unknown }).message;
    if (typeof nested === "string" && nested.trim()) return nested.trim();
  }

  const message = (error as { message?: unknown }).message;
  if (typeof message === "string" && message.trim()) return message.trim();

  // `error` is an object and nothing readable was found on it, so `String()`
  // here renders the literal text "[object Object]" — which is exactly the
  // unexplained crash this function exists to prevent. It gets worse
  // downstream: that string reaches `needsSetup()` on the setup screen, matches
  // none of its patterns, and files an agent that only needed signing in under
  // "Not working".
  if (error instanceof Error) return error.name;
  try {
    const json = JSON.stringify(error);
    if (json && json !== "{}" && json !== "null") return json;
  } catch {
    // Circular, or something that refuses to serialise. Nothing to show.
  }
  return "the agent failed without saying why";
}

/**
 * How many agents to start at once.
 *
 * Verification spawns each agent for real and waits on a network round trip, so
 * running them one at a time made `pew2 setup` take the sum of every agent's
 * startup — forty seconds on a normal machine, which is long enough that people
 * assume it has hung.
 *
 * Bounded rather than unlimited because the first run of an `npx` provider
 * downloads its package, and a dozen of those at once thrash the same cache
 * directory. Four keeps the wall time close to the slowest agent without
 * turning a cold machine into a stampede.
 */
const CONCURRENCY = 4;

export async function verifyAll(
  providers: LoadedProvider[],
  options: VerifyOptions = {},
): Promise<VerifyReport[]> {
  const reports: VerifyReport[] = new Array(providers.length);
  let next = 0;

  // A fixed pool pulling from a shared cursor, so a slow agent holds one slot
  // instead of stalling a whole batch — which a chunked loop would do.
  const worker = async () => {
    for (;;) {
      const index = next++;
      if (index >= providers.length) return;
      // Results land by index, so the order the caller sees never depends on
      // which agent happened to finish first.
      reports[index] = await verifyProvider(providers[index]!, options);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, providers.length) }, worker),
  );
  return reports;
}
