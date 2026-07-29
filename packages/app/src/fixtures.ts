/**
 * Development fixtures.
 *
 * Illustrative sample data used to exercise the chat history, long-response
 * rendering and multi-agent grouping without needing several real agents
 * installed and several real sessions run. This is clearly marked sample
 * content, not captured user data.
 *
 * Set EXPO_PUBLIC_PEW2_FIXTURES=0 to see the genuine empty state. Fixtures are
 * seeded at init and real sessions are appended ahead of them, so a live
 * session is never overwritten. Their ids all carry FIXTURE_PREFIX and
 * `isFixtureSession` gates them out of anything that talks to the daemon.
 *
 * They carry no `configOptions` on purpose. Those drive the live top bar, so a
 * sample model selector would claim a capability the real agent may not have
 * and then vanish the moment a session opened.
 */
import type { Session, Turn } from "./useDaemon";

/** Enabled by default in development so the UI can be reviewed with content. */
export const USE_FIXTURES =
  __DEV__ && process.env.EXPO_PUBLIC_PEW2_FIXTURES !== "0";

/** Every fixture id starts with this so they can be told from real sessions. */
export const FIXTURE_PREFIX = "fixture-";

/** True for local sample sessions the daemon has no record of. */
export function isFixtureSession(sessionId: string): boolean {
  return sessionId.startsWith(FIXTURE_PREFIX);
}

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function turns(sessionId: string, entries: [Turn["role"], string][]): Turn[] {
  return entries.map(([role, text], index) => ({
    id: `${sessionId}:${index}`,
    role,
    text,
  }));
}

/**
 * Deliberately varied: a long multi-paragraph answer, a short exchange, a
 * failure, and an interrupted run — so the thread is reviewed against the
 * states it will actually meet rather than one happy path.
 */
export function sampleSessions(now: number = Date.now()): Session[] {
  return [
    {
      id: "fixture-auth-refactor",
      providerId: "claude-code",
      title: "Refactor the auth module to use the new token store",
      startedAt: now - 25 * 60 * 1000,
      configOptions: [],
      turns: turns("fixture-auth-refactor", [
        ["user", "Refactor the auth module to use the new token store"],
        [
          "thought",
          "Reading src/auth/session.ts and the new store interface before changing anything.",
        ],
        [
          "agent",
          "I've moved authentication onto the new token store.\n\nThe old module kept the refresh token in memory and rebuilt it on every request, which meant a dropped connection silently logged the user out. The new store persists it and exposes a single `refresh()` that callers can await, so a reconnect resumes the existing session instead of starting a new one.\n\nThree files changed:\n\nsrc/auth/session.ts now delegates to the store rather than owning state. The exported API is unchanged, so nothing downstream needed editing.\n\nsrc/auth/tokens.ts is new. It wraps the store, handles expiry with a 60 second safety margin, and serialises concurrent refreshes so ten parallel requests trigger one network call rather than ten.\n\nsrc/auth/index.ts re-exports the same surface as before.\n\nOne thing worth your attention: the old code treated a 401 during refresh as a transient error and retried twice. I've made it fail immediately and clear the stored token, because retrying a rejected refresh just delays the login prompt. Tell me if you'd rather keep the retry.",
        ],
        ["user", "Good. Add a test for the concurrent refresh case"],
        [
          "agent",
          "Added `tokens.test.ts` covering the serialisation path.\n\nIt fires twenty simultaneous `refresh()` calls against a store stubbed to resolve after 50ms, then asserts the underlying fetch was called exactly once and that all twenty callers received the same token. It also covers the rejection path, where a single failure has to reject every waiter rather than leaving nineteen of them hanging.\n\nBoth pass.",
        ],
      ]),
    },
    {
      id: "fixture-flaky-test",
      providerId: "claude-code",
      title: "Why is the checkout test flaky?",
      startedAt: now - 3 * HOUR,
      configOptions: [],
      turns: turns("fixture-flaky-test", [
        ["user", "Why is the checkout test flaky?"],
        [
          "agent",
          "It's a timing assumption, not a race in the code under test.\n\n`checkout.test.ts` waits 100ms for the total to recalculate, but the recalculation is debounced by 150ms. On a fast machine the assertion usually lands after the debounce anyway; under load it doesn't.\n\nReplace the sleep with a wait on the rendered total and the flake goes away. Want me to make that change?",
        ],
      ]),
    },
    {
      id: "fixture-migration",
      providerId: "codex",
      title: "Generate the migration for the events table",
      startedAt: now - DAY - 2 * HOUR,
      configOptions: [],
      turns: turns("fixture-migration", [
        ["user", "Generate the migration for the events table"],
        [
          "agent",
          "Created `migrations/0007_events_sequence.sql`.\n\nIt adds the composite primary key on (session_id, seq) and backfills existing rows in batches of 5000 so the table isn't locked for the duration.\n\nI have not run it. Review the backfill before applying to anything with real data.",
        ],
        ["system", "Agent exited (code 0)"],
      ]),
    },
    {
      id: "fixture-echo-check",
      providerId: "echo",
      title: "Check the connection end to end",
      startedAt: now - 5 * 60 * 1000,
      configOptions: [],
      turns: turns("fixture-echo-check", [
        ["user", "Check the connection end to end"],
        ["thought", "Thinking about it..."],
        ["agent", "You said: Check the connection end to end"],
      ]),
    },
    {
      id: "fixture-interrupted",
      providerId: "claude-code",
      title: "Upgrade every dependency to latest",
      startedAt: now - 2 * DAY,
      configOptions: [],
      turns: turns("fixture-interrupted", [
        ["user", "Upgrade every dependency to latest"],
        [
          "thought",
          "Checking which upgrades are breaking before touching the lockfile.",
        ],
        [
          "agent",
          "Starting with the safe patch and minor bumps, then I'll list the majors separately for you to decide on.",
        ],
        ["system", "Stopped by you"],
      ]),
    },
  ];
}
