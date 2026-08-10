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

/**
 * How long an agent gets to come up.
 *
 * Was 60s, which is under half the handshake budget `connect.ts` allows (180s)
 * — so a slow-but-working agent was cut off by the check rather than by the
 * thing that actually runs it, and reported as broken on the strength of a
 * timer. That is a false accusation on exactly the machines least able to
 * afford one: the first run of an npx-launched agent downloads its package, and
 * `setup` starts four of them at once on a connection that may be someone's
 * hotel wifi.
 *
 * 150s stays under the handshake budget, so a timeout here still means the
 * agent is genuinely wedged rather than merely slower than pew2's patience.
 * The wait is visible — setup names the agent it is checking — so the cost of
 * the higher ceiling is paid only by a machine that has something wrong with it.
 */
const DEFAULT_TIMEOUT_MS = 150_000;

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

  // The backstop, not the mechanism.
  //
  // Giving up out here used to be the *only* limit, and it left the agent
  // running: this function abandons the attempt, but the process belongs to
  // `connectProvider`, which had its own much longer budget and was still
  // patiently waiting on a child nobody would ever collect. A health check that
  // leaves a process per agent behind is worse than no health check.
  //
  // So the real deadline is handed to `connectProvider` below, which owns the
  // child and can kill it. This race only covers a hang that is not the
  // handshake — hence the grace, so the specific error wins the ordinary case.
  const GRACE_MS = 5_000;
  let expire: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    expire = setTimeout(
      () =>
        reject(
          // Written for the person who ran `pew2 setup`, not for whoever wrote
          // the manifest: "check the adapter's flags" was an instruction only a
          // contributor could act on, on a screen aimed at everyone else.
          new Error(
            `Timed out after ${Math.round(timeoutMs / 1000)}s — it started but never finished connecting.`,
          ),
        ),
      timeoutMs + GRACE_MS,
    );
  });

  // Set once the race is over, so the losing side knows there is nobody left to
  // return a handle to.
  let abandoned = false;

  try {
    const run = (async () => {
      handle = await connectProvider({
        provider,
        // The check's deadline is the connection's deadline. Anything else is
        // two clocks disagreeing about who owns the process, which is exactly
        // how it came to be left running.
        handshakeTimeoutMs: timeoutMs,
        // A scratch directory, not the user's. Verification really starts each
        // agent and sends it a prompt, and agents write files where they are
        // pointed — running `pew2 setup` inside a project left junk in it, which
        // is a rude thing for a health check to do.
        cwd: options.cwd ?? scratchDir(),
        onUpdate: (payload) => updates.push(payload),
        // Auto-approve during verification so the round trip can complete.
        onPermissionRequest: ({ requestId }) => handle?.answerPermission(requestId, "allow"),
      });
      // The timeout may already have won, in which case `finally` has been and
      // gone and nothing else will ever close this. Left alone, a slow agent
      // that came up at 151s stayed running for the life of the terminal — the
      // exact opposite of what a health check should leave behind, and multiplied
      // by every agent on the machine.
      if (abandoned) {
        handle.close();
        throw new Error("verification had already given up");
      }
      // No prompt. Reaching this line already proves everything the check is
      // for: the process started, spoke ACP, agreed a protocol version and
      // opened a session.
      //
      // It used to send "Hello from pew2 verify" as well, which turned a health
      // check into a real model call on the user's account for every installed
      // agent, every time they ran setup \u2014 billed, rate-limited, and leaving a
      // junk conversation in each agent's history that then showed up in the
      // app's own session list.
      return handle.sessionId;
    })();

    const sessionId = await Promise.race([run, timeout]);
    return { id, status: "ok", sessionId, updates: updates.length };
  } catch (error) {
    return { id, status: "failed", detail: describe(error) };
  } finally {
    clearTimeout(expire);
    abandoned = true;
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
