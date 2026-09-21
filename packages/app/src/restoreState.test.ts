import { expect, test } from "bun:test";
import { matchesRestore, restorePresentation, restoreTarget } from "./restoreState";
import type { Session } from "./useDaemon";
const session: Session = { id: "agent:gg:stored", providerId: "gg", agentSessionId: "stored", title: "Original title", cwd: "/project", startedAt: 1, turns: [], configOptions: [] };
const target = restoreTarget(session);
test("restore acknowledgement names the selected target before a live id exists", () => {
  expect(restorePresentation(target, true, undefined, 0, "online")).toBe("loading");
  expect(target.title).toBe("Original title");
});
test("first replay content replaces skeleton; completed empty replay is truly empty", () => {
  expect(restorePresentation(target, true, undefined, 1, "online")).toBeUndefined();
  expect(restorePresentation(target, false, undefined, 0, "online")).toBe("empty");
});
test("offline and reconnecting do not claim agent work", () => {
  expect(restorePresentation(target, true, undefined, 0, "offline")).toBe("reconnecting");
  expect(restorePresentation(target, true, undefined, 0, "connecting")).toBe("reconnecting");
});
test("failure has a retry target independent of replacement live session id", () => {
  const replacement = { ...session, id: "live:123" };
  expect(restorePresentation(target, false, "Failed", 0, "online")).toBe("failed");
  expect(target.id).not.toBe(replacement.id);
  expect(target.agentSessionId).toBe(replacement.agentSessionId);
  expect("turns" in target).toBe(false);
});
test("stale restore answers cannot claim another conversation", () => {
  expect(matchesRestore(target, { providerId: "gg", agentSessionId: "different" })).toBe(false);
  expect(matchesRestore(target, { providerId: "other", agentSessionId: "stored" })).toBe(false);
  expect(matchesRestore(undefined, { providerId: "gg", agentSessionId: "stored" })).toBe(false);
  expect(matchesRestore(target, { providerId: "gg", agentSessionId: "stored" })).toBe(true);
  expect(matchesRestore(target, {})).toBe(true); // absent fields: older daemon
});
test("failure remains visible after a partial replay; leaving clears presentation", () => {
  expect(restorePresentation(target, false, "Failed", 2, "online")).toBe("failed");
  expect(restorePresentation(undefined, false, undefined, 0, "online")).toBeUndefined();
});
