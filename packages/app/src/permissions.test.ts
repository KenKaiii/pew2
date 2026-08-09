import { expect, test } from "bun:test";
import { pendingPermission, readPermissionRequest, toPermissionRequest } from "./permissions";

test("an agent that offers no buttons still gets an answerable sheet", () => {
  // A sheet with no options cannot be answered, and an unanswerable sheet stops
  // the turn exactly as dead as no sheet at all.
  expect(toPermissionRequest("p1", {})).toEqual({
    requestId: "p1",
    title: "The agent needs your approval",
    options: [
      { optionId: "allow", name: "Allow" },
      { optionId: "reject", name: "Reject" },
    ],
  });
});

test("the agent's own wording and choices are used when it sends them", () => {
  expect(
    toPermissionRequest("p2", {
      toolCall: { title: "Run `rm -rf build`" },
      options: [{ optionId: "always", name: "Yes, and don't ask again" }],
    }),
  ).toEqual({
    requestId: "p2",
    title: "Run `rm -rf build`",
    options: [{ optionId: "always", name: "Yes, and don't ask again" }],
  });
});

test("only a permission event reads as one", () => {
  expect(readPermissionRequest({ kind: "permission_request", requestId: "p3" })?.requestId).toBe("p3");
  expect(readPermissionRequest({ update: { sessionUpdate: "agent_message_chunk" } })).toBeUndefined();
  // An event with no id is unanswerable, so it is not a request.
  expect(readPermissionRequest({ kind: "permission_request" })).toBeUndefined();
  expect(readPermissionRequest(undefined)).toBeUndefined();
});

test("a missing list and an empty one mean opposite things", () => {
  // Absent is an older daemon that says nothing, and the sheet on screen stands.
  // Empty is this daemon saying nothing is pending, which is what dismisses a
  // request answered from the desktop while the phone was offline.
  expect(pendingPermission(undefined)).toBeUndefined();
  expect(pendingPermission([])).toBeNull();
});

test("the newest request is the one shown, as it is live", () => {
  // Two tools can be in flight at once. Live, the second replaces the first on
  // screen; a reconnect showing the older one would put the user behind where
  // they were when the signal dropped.
  expect(
    pendingPermission([
      { requestId: "p1", params: { toolCall: { title: "First" } } },
      { requestId: "p2", params: { toolCall: { title: "Second" } } },
    ]),
  ).toMatchObject({ requestId: "p2", title: "Second" });
});
