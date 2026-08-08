import { expect, test } from "bun:test";
import { rememberConfigs, visibleConfigs, withChoice } from "./configTruth";
import type { ConfigOption } from "./useDaemon";

const model = (currentValue: string): ConfigOption[] => [
  {
    id: "__acp_model",
    name: "Model",
    type: "select",
    currentValue,
    options: [
      { value: "sonnet", name: "Sonnet" },
      { value: "opus", name: "Opus" },
    ],
  },
];

test("the open conversation's own selectors win over the provider's", () => {
  // While a conversation is running, its list is the only truth about it: the
  // provider record describes the *next* one.
  const shown = visibleConfigs({
    session: model("opus"),
    provider: model("sonnet"),
    inConversation: true,
  });

  expect(shown[0]?.currentValue).toBe("opus");
});

test("an open conversation that has not reported yet names nothing", () => {
  // A resumed conversation comes back at the selectors it was last used with,
  // which need not be the remembered ones — and they arrive a moment after the
  // session does. Showing the provider's in that window is how the pill claimed
  // one model while another was about to answer.
  expect(visibleConfigs({ session: [], provider: model("sonnet"), inConversation: true })).toEqual(
    [],
  );
});

test("with no conversation open, the provider's list is what the next prompt uses", () => {
  const shown = visibleConfigs({ session: [], provider: model("opus"), inConversation: false });

  expect(shown[0]?.currentValue).toBe("opus");
});

test("a provider with nothing known offers nothing rather than a guess", () => {
  expect(visibleConfigs({ session: [], provider: undefined, inConversation: false })).toEqual([]);
});

test("a choice is applied to the remembered list, and only to its own selector", () => {
  const known: ConfigOption[] = [
    ...model("sonnet"),
    { id: "effort", name: "Effort", type: "select", currentValue: "high" },
  ];

  const next = withChoice(known, "__acp_model", "opus");

  expect(next[0]?.currentValue).toBe("opus");
  expect(next[1]?.currentValue).toBe("high");
});

test("an empty announcement never erases what is known", () => {
  // Session stubs and older daemons both send empty lists; taking them would
  // blank the picker on an empty screen.
  const known = { "claude-code": model("opus") };

  expect(rememberConfigs(known, "claude-code", [])).toBe(known);
  expect(rememberConfigs(known, undefined, model("sonnet"))).toBe(known);
});
