export type ClipboardWriter = (text: string) => Promise<unknown>;

/** Writes exactly the displayed code and reports failures without rejecting a UI press. */
export async function writeCodeToClipboard(
  code: string,
  writeText: ClipboardWriter,
): Promise<boolean> {
  try {
    await writeText(code);
    return true;
  } catch {
    return false;
  }
}
