/**
 * What happened the last time this app died.
 *
 * A render crash has `ErrorBoundary`, which shows the error on screen because
 * the person hitting it is holding a phone rather than a terminal. Everything
 * else — a throw from an event handler, a rejected promise nobody awaited, a
 * native module failing during startup — takes the process down with no boundary
 * to catch it. The app relaunches clean and the only evidence is gone, which is
 * the position "it crashed, I don't know when" comes from.
 *
 * So the last fatal error is written to this device's own storage and read back
 * on the next launch. Nothing leaves the phone: transcripts, prompts and file
 * paths routinely appear in error messages, and shipping those to a third-party
 * crash service would undo the point of encrypting them in the first place —
 * the same reason `ErrorBoundary` gives for not reporting either. If that ever
 * changes it should be opt-in and say exactly what it sends.
 *
 * Kept to one record. A crash loop would otherwise fill the disk with the same
 * stack, and the newest copy is the only one anyone reads.
 */
import { Directory, File, Paths } from "expo-file-system";

export interface CrashRecord {
  /** ISO 8601, so a record is readable without the app that wrote it. */
  at: string;
  message: string;
  stack?: string;
  /** True for a crash the runtime considered unrecoverable. */
  fatal: boolean;
}

const FILE = "last-crash.json";

function crashFile(): File {
  return new File(Paths.document, FILE);
}

/**
 * Record a crash, best effort.
 *
 * Never throws. This runs from a global handler while the process is already
 * failing, and an exception here would replace the real error with a useless
 * one — the classic way a crash reporter becomes the crash.
 */
export function recordCrash(error: unknown, fatal: boolean): void {
  try {
    const wrapped = error instanceof Error ? error : new Error(String(error));
    const record: CrashRecord = {
      at: new Date().toISOString(),
      message: wrapped.message,
      stack: wrapped.stack,
      fatal,
    };
    const file = crashFile();
    // Overwritten rather than appended: one record, always the newest. A crash
    // loop would otherwise write the same stack until the disk filled, and only
    // the last copy is ever read.
    file.create({ overwrite: true });
    file.write(JSON.stringify(record));
  } catch {
    // The process is on its way down. Losing the record is bad; throwing here
    // and hiding the error that caused it is worse.
  }
}

/** The last recorded crash, or nothing. Never throws. */
export function readCrash(): CrashRecord | undefined {
  try {
    const file = crashFile();
    if (!file.exists) return undefined;
    const parsed: unknown = JSON.parse(file.textSync());
    if (!parsed || typeof parsed !== "object") return undefined;
    const record = parsed as Partial<CrashRecord>;
    if (typeof record.message !== "string" || typeof record.at !== "string") return undefined;
    return {
      at: record.at,
      message: record.message,
      stack: typeof record.stack === "string" ? record.stack : undefined,
      fatal: record.fatal === true,
    };
  } catch {
    return undefined;
  }
}

/** Forget it, once it has been seen. Never throws. */
export function clearCrash(): void {
  try {
    const file = crashFile();
    if (file.exists) file.delete();
  } catch {
    // A record that cannot be deleted is shown twice, which is survivable.
  }
}

/**
 * Whether a directory this module needs is missing.
 *
 * Split out so `installCrashHandler` stays readable; `Paths.document` exists on
 * every platform this ships to, but a test harness may not have it.
 */
function documentsExist(): boolean {
  try {
    return new Directory(Paths.document).exists;
  } catch {
    return false;
  }
}

/**
 * Catch what React cannot.
 *
 * `ErrorUtils` is React Native's own last-resort hook, the same one the red
 * screen uses in development. In a release build nothing is registered, so an
 * uncaught error simply ends the process.
 *
 * Called once, from the app entry point, before anything else can throw.
 */
export function installCrashHandler(): void {
  if (!documentsExist()) return;

  const globals = globalThis as {
    ErrorUtils?: {
      getGlobalHandler: () => (error: unknown, fatal?: boolean) => void;
      setGlobalHandler: (handler: (error: unknown, fatal?: boolean) => void) => void;
    };
  };
  const errorUtils = globals.ErrorUtils;
  if (!errorUtils) return;

  const previous = errorUtils.getGlobalHandler();
  errorUtils.setGlobalHandler((error, fatal) => {
    recordCrash(error, fatal === true);
    // Chained, not replaced: the default handler is what shows the red screen in
    // development and what ends the process in release. Swallowing it would turn
    // a crash into a frozen app.
    previous(error, fatal);
  });
}
