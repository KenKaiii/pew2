import { expect, test } from "bun:test";
import { isDenyApprovalOption, selectApprovalOptions } from "./approvalOptions";

test("the compact approval dock keeps only allow-once and reject", () => {
  const options = [
    { optionId: "allow_always", name: "Always Allow Bash(a very long generated command)" },
    { optionId: "allow", name: "Allow" },
    { optionId: "reject", name: "Reject" },
  ];

  expect(selectApprovalOptions(options)).toEqual([options[1], options[2]]);
});

test("deny detection follows stable option ids rather than display copy", () => {
  expect(isDenyApprovalOption({ optionId: "reject_once", name: "Stop" })).toBe(true);
  expect(isDenyApprovalOption({ optionId: "allow", name: "Reject-looking command" })).toBe(false);
});
