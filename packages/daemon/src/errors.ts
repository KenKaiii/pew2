/**
 * Turning a thrown value into something worth putting on a phone screen.
 *
 * Agents fail in JSON-RPC, so the useful sentence is rarely the top-level
 * message. `RequestError` carries a generic label ("Internal error") with the
 * real cause buried in `data`, often as a JSON *string* that itself wraps
 * `{ error: { message } }`. Rendering that raw is how a session limit notice
 * reaches the user as a blob of punctuation.
 *
 * This is deliberately provider-agnostic: it reads the JSON-RPC shape every ACP
 * agent must already speak, so a newly added manifest gets readable errors
 * without a line of code here.
 */

/** Longest message worth showing. Past this it is a log entry, not a message. */
const MAX_LENGTH = 240;

/** Keys most likely to hold the human sentence, tried before anything else. */
const MEANINGFUL_KEYS = ["details", "detail", "message", "error", "reason", "description"];

/**
 * What each JSON-RPC code means in plain words.
 *
 * Only used when the agent gave us nothing readable — a code is still more
 * actionable than "Internal error".
 */
const BY_CODE: Record<number, string> = {
  [-32700]: "The agent sent a reply pew2 could not read.",
  [-32600]: "The agent rejected the request.",
  [-32601]: "The agent does not support that.",
  [-32602]: "The agent rejected the request's arguments.",
  [-32603]: "The agent hit an internal error.",
  [-32800]: "Cancelled.",
  [-32000]: "The agent needs you to sign in.",
};

/** Labels that carry no information once the real cause is in hand. */
const NOISE = /^(?:(?:internal\s+)?error|request\s+failed|prompt\s+failed|failed)\s*[:\-–]\s*/i;

/**
 * The SDK's own protocol labels.
 *
 * These are the *absence* of an explanation, so they must lose to the plain
 * wording in `BY_CODE` rather than being shown as though the agent said them.
 */
const PROTOCOL_LABELS = new Set([
  "parse error",
  "invalid request",
  "method not found",
  "invalid params",
  "internal error",
  "request cancelled",
  "authentication required",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** True when a string is a serialised object rather than prose. */
function looksLikeJson(text: string): boolean {
  const trimmed = text.trim();
  return (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  );
}

/** True when a candidate still reads as machine output. */
function isBlob(text: string): boolean {
  return looksLikeJson(text) || /["']\s*:\s*["'{[]/.test(text) || /\{\s*["']/.test(text);
}

/**
 * True when a candidate reads like something written for a person.
 *
 * Guards against returning an identifier the agent happened to include —
 * `session/list` from a method-not-found payload is data, not a message.
 */
function isProse(text: string): boolean {
  if (/\s/.test(text)) return true;
  return /^[A-Za-z]{4,}[.!?]?$/.test(text);
}

function isProtocolLabel(text: string): boolean {
  return PROTOCOL_LABELS.has(text.replace(/["'.]/g, "").trim().toLowerCase());
}

function clean(text: string): string {
  // The SDK quotes some labels (`"Method not found": session/list`), so compare
  // and display without the decoration.
  let result = text.replace(/\s+/g, " ").trim();
  const labelled = result.match(/^"([^"]+)"\s*:\s*(.+)$/);
  if (labelled && isProtocolLabel(labelled[1] ?? "")) result = labelled[1] ?? result;
  // Prefixes stack: an agent's own "Error:" survives the SDK wrapping it in
  // "Internal error:", so strip until nothing generic is left.
  let previous: string;
  do {
    previous = result;
    result = result.replace(NOISE, "").trim();
  } while (result !== previous);
  return result;
}

/**
 * Every human-readable string inside a thrown value, most promising first.
 *
 * Recurses through parsed JSON because the cause is frequently double-encoded:
 * a `data.details` string holding `{"error":{"message":"..."}}`.
 */
function* candidates(value: unknown, depth = 0): Generator<string> {
  if (depth > 5 || value === null || value === undefined) return;

  if (typeof value === "string") {
    if (looksLikeJson(value)) {
      try {
        yield* candidates(JSON.parse(value), depth + 1);
        return;
      } catch {
        // Malformed JSON is not prose either; fall through and let the blob
        // check reject it.
      }
    }
    yield value;
    return;
  }

  if (Array.isArray(value)) {
    for (const entry of value) yield* candidates(entry, depth + 1);
    return;
  }

  if (isRecord(value)) {
    for (const key of MEANINGFUL_KEYS) {
      if (key in value) yield* candidates(value[key], depth + 1);
    }
    for (const [key, entry] of Object.entries(value)) {
      if (!MEANINGFUL_KEYS.includes(key)) yield* candidates(entry, depth + 1);
    }
  }
}

function truncate(text: string): string {
  if (text.length <= MAX_LENGTH) return text;
  const cut = text.slice(0, MAX_LENGTH);
  const boundary = cut.lastIndexOf(" ");
  return `${(boundary > MAX_LENGTH * 0.6 ? cut.slice(0, boundary) : cut).trimEnd()}…`;
}

/**
 * A short, human sentence describing a failure. Never JSON, never empty.
 */
export function humanError(error: unknown): string {
  const code =
    isRecord(error) && typeof error.code === "number" ? (error.code as number) : undefined;

  // `data` first: on a JSON-RPC rejection the top-level message is the generic
  // label and `data` is where the agent put the actual reason.
  const sources: unknown[] = [];
  if (isRecord(error)) sources.push(error.data);
  if (error instanceof Error) sources.push(error.message);
  else if (isRecord(error)) sources.push(error.message);
  else sources.push(error);

  for (const source of sources) {
    for (const candidate of candidates(source)) {
      const text = clean(candidate);
      if (!text || isBlob(text) || isProtocolLabel(text) || !isProse(text)) continue;
      return truncate(text);
    }
  }

  if (code !== undefined && BY_CODE[code]) return BY_CODE[code];
  return "Something went wrong.";
}
