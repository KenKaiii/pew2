export type ClipboardWriter = (text: string) => Promise<unknown>;

/** Writes exactly the displayed text and reports failures without rejecting a UI press. */
export async function writeToClipboard(
  text: string,
  writeText: ClipboardWriter,
): Promise<boolean> {
  try {
    await writeText(text);
    return true;
  } catch {
    return false;
  }
}
