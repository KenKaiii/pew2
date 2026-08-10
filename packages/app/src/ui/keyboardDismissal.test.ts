/**
 * Which overlays take the keyboard down, and which deliberately do not.
 *
 * There is no renderer in this suite, so these read the source. That is enough,
 * because the rule being protected is a decision about *where the call lives*,
 * not about what it computes — and the decision is not obvious enough to survive
 * on comments alone.
 *
 * The rule: an overlay that rests against the bottom edge dismisses the
 * keyboard, because that is exactly where the keyboard is and the card would
 * otherwise open behind it. An overlay anchored to a control at the top does
 * not, because switching a setting mid-sentence should not drop the draft's
 * keyboard and bounce the composer.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

function source(file: string): string {
  return readFileSync(join(import.meta.dir, file), "utf8");
}

test("every sheet takes the keyboard down, from the one place they share", () => {
  // Sheets rest on the bottom edge. Opening one from the composer put the whole
  // card behind the keyboard: invisible, with its rows unreachable.
  //
  // Asserted on `Sheet` rather than on its five callers because that is the
  // point of the shared primitive — a sixth sheet added later inherits this
  // instead of having to remember it.
  expect(source("Sheet.tsx")).toContain("Keyboard.dismiss()");

  // No sheet holds a text field, which is what makes dismissing unconditionally
  // safe. If one ever does, this fails and the rule needs revisiting rather than
  // the input quietly losing focus every time the sheet opens.
  for (const file of [
    "Sheet.tsx",
    "NewChatSheet.tsx",
    "CommandSheet.tsx",
    "AttachmentSheet.tsx",
    "ApprovalSheet.tsx",
    "ThoughtSheet.tsx",
  ]) {
    expect(source(file)).not.toContain("<TextInput");
  }
});

test("tapping the transcript takes the keyboard down", () => {
  // The list already asks for this with `keyboardShouldPersistTaps="handled"`,
  // which blurs on any tap a child does not claim. Every turn is wrapped in a
  // Pressable for the copy-hold, though, and a Pressable claims the touch — so
  // the one gesture the rule exists for, tapping away from the composer onto the
  // conversation, was the one it never covered.
  expect(source("ChatThread.tsx")).toContain('keyboardShouldPersistTaps="handled"');
  expect(source("Turn.tsx")).toContain("onPress={Keyboard.dismiss}");
});

test("an anchored picker keeps the keyboard, on purpose", () => {
  // The opposite decision, and the more fragile one: it looks like an oversight,
  // so it is the one somebody would "fix". Switching model or project is not
  // leaving the conversation — dropping the keyboard there loses the draft's
  // focus and drops the composer mid-sentence.
  for (const file of ["ConfigPicker.tsx", "ProjectMenu.tsx"]) {
    expect(source(file)).not.toContain("Keyboard.dismiss");
  }
});
