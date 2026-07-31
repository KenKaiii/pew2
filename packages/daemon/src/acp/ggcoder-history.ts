import { createReadStream } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import readline from "node:readline";
import { promisify } from "node:util";
import { createGunzip, gunzip } from "node:zlib";
import type { AgentSession } from "./connect.js";

const gunzipAsync = promisify(gunzip);

interface StoredMessage {
  parentId: string | null;
  role?: "user" | "assistant";
  hasText: boolean;
}

/** GG Coder's stable cwd-to-directory encoding, shared by every persisted session. */
function encodeCwd(cwd: string): string {
  return cwd
    .replace(/^\\\\\?\\UNC\\/i, "\\\\")
    .replace(/^\\\\\?\\/i, "")
    .replace(/[\\/]/g, "_")
    .replace(/[<>:"|?*]/g, "")
    .replace(/^_/, "");
}

function hasVisibleText(content: unknown): boolean {
  if (typeof content === "string") return content.length > 0;
  if (!Array.isArray(content)) return false;
  return content.some(
    (block) =>
      (block as { type?: string; text?: string })?.type === "text" &&
      ((block as { text?: string }).text?.length ?? 0) > 0,
  );
}

async function countFile(filePath: string, expectedSessionId: string): Promise<number | undefined> {
  const source = createReadStream(filePath);
  const input = filePath.endsWith(".gz") ? source.pipe(createGunzip()) : source;
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  const messages = new Map<string, StoredMessage>();
  let sessionId: string | undefined;
  let leafId: string | undefined;
  let lastMessageId: string | undefined;

  try {
    for await (const line of lines) {
      let entry: any;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (entry?.type === "session") {
        sessionId = entry.id;
        leafId = entry.leafId;
      } else if (entry?.type === "message" && typeof entry.id === "string") {
        lastMessageId = entry.id;
        messages.set(entry.id, {
          parentId: typeof entry.parentId === "string" ? entry.parentId : null,
          role:
            entry.message?.role === "user" || entry.message?.role === "assistant"
              ? entry.message.role
              : undefined,
          hasText: hasVisibleText(entry.message?.content),
        });
      }
    }
  } finally {
    lines.close();
  }

  if (sessionId !== expectedSessionId) return undefined;
  const lineage: StoredMessage[] = [];
  const visited = new Set<string>();
  let cursor: string | undefined = leafId ?? lastMessageId;
  while (cursor && !visited.has(cursor)) {
    visited.add(cursor);
    const message = messages.get(cursor);
    if (!message) break;
    lineage.push(message);
    cursor = message.parentId ?? undefined;
  }

  let count = 0;
  let previousRole: StoredMessage["role"];
  for (const message of lineage.reverse()) {
    if (!message.role || !message.hasText) continue;
    if (message.role !== previousRole) count += 1;
    previousRole = message.role;
  }
  return count;
}

async function countSession(
  session: AgentSession,
  sessionsRoot: string,
): Promise<number | undefined> {
  const directory = path.join(sessionsRoot, encodeCwd(session.cwd));
  const suffix = `_${session.sessionId.slice(0, 8)}.jsonl`;
  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    return undefined;
  }
  // Archival leaves a tiny `.jsonl` redirect beside `.jsonl.gz`. Try both: the
  // full session id in the header also rejects an eight-character prefix clash.
  const candidates = names.filter(
    (entry) => entry.endsWith(suffix) || entry.endsWith(`${suffix}.gz`),
  );
  for (const name of candidates) {
    const count = await countFile(path.join(directory, name), session.sessionId);
    if (count !== undefined) return count;
  }
  return undefined;
}

/**
 * Fill counts for GG Coder releases that predate ACP `_meta.messageCount`.
 *
 * Loading hundreds of sessions serially over ACP takes minutes. GG Coder's JSONL
 * store is local to the daemon, so bounded parallel reads produce the same rows
 * its ACP replay would render without opening or mutating any conversation.
 */
export async function hydrateGgCoderMessageCounts(
  sessions: AgentSession[],
  sessionsRoot = path.join(homedir(), ".gg", "sessions"),
): Promise<void> {
  const pending = sessions.filter((session) => session.messageCount === undefined);
  let next = 0;
  const worker = async () => {
    while (next < pending.length) {
      const session = pending[next++];
      if (!session) return;
      try {
        const count = await countSession(session, sessionsRoot);
        if (count !== undefined) session.messageCount = count;
      } catch {
        // ACP replay below remains the compatibility fallback for raced/corrupt files.
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(12, pending.length) }, worker));
}

export type GgCoderDisplayUpdate = Record<string, unknown>;

interface DisplayStoredMessage {
  parentId: string | null;
  role?: "user" | "assistant" | "tool" | "system";
  content: unknown;
  provenance?: { kind?: string; visibility?: "transcript" | "hidden" | "summary" };
}

interface DisplayCheckpoint {
  header: {
    id: string;
    conversationId?: string;
    parentSessionId?: string;
    leafId?: string;
  };
  messages: DisplayStoredMessage[];
  path: string;
}

async function readCheckpoint(filePath: string): Promise<DisplayCheckpoint | undefined> {
  const bytes = await readFile(filePath);
  const text = filePath.endsWith(".gz")
    ? (await gunzipAsync(bytes)).toString("utf8")
    : bytes.toString("utf8");
  let header: DisplayCheckpoint["header"] | undefined;
  const messages = new Map<string, DisplayStoredMessage>();
  let lastMessageId: string | undefined;

  for (const line of text.split("\n")) {
    if (!line) continue;
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry?.type === "session" && typeof entry.id === "string") {
      header = {
        id: entry.id,
        conversationId: typeof entry.conversationId === "string" ? entry.conversationId : undefined,
        parentSessionId:
          typeof entry.parentSessionId === "string" ? entry.parentSessionId : undefined,
        leafId: typeof entry.leafId === "string" ? entry.leafId : undefined,
      };
    } else if (entry?.type === "message" && typeof entry.id === "string") {
      lastMessageId = entry.id;
      messages.set(entry.id, {
        parentId: typeof entry.parentId === "string" ? entry.parentId : null,
        role: entry.message?.role,
        content: entry.message?.content,
        provenance: entry.message?.provenance,
      });
    }
  }
  if (!header) return undefined;

  const lineage: DisplayStoredMessage[] = [];
  const visited = new Set<string>();
  let cursor = header.leafId ?? lastMessageId;
  while (cursor && !visited.has(cursor)) {
    visited.add(cursor);
    const message = messages.get(cursor);
    if (!message) break;
    lineage.push(message);
    cursor = message.parentId ?? undefined;
  }
  return { header, messages: lineage.reverse(), path: filePath };
}

async function findCheckpoint(
  sessionId: string,
  directory: string,
  expectedConversationId?: string,
): Promise<DisplayCheckpoint | undefined> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    return undefined;
  }
  const suffix = `_${sessionId.slice(0, 8)}.jsonl`;
  // Prefer the archive when both it and a tiny redirect file exist.
  const candidates = names
    .filter((name) => name.endsWith(suffix) || name.endsWith(`${suffix}.gz`))
    .sort((left, right) => Number(right.endsWith(".gz")) - Number(left.endsWith(".gz")));
  for (const name of candidates) {
    try {
      const checkpoint = await readCheckpoint(path.join(directory, name));
      if (
        checkpoint?.header.id === sessionId &&
        (!expectedConversationId ||
          (checkpoint.header.conversationId ?? checkpoint.header.id) === expectedConversationId)
      ) {
        return checkpoint;
      }
    } catch {
      // A raced or corrupt candidate does not prevent trying its archive twin.
    }
  }
  return undefined;
}

async function findCheckpointAcrossRoot(
  sessionId: string,
  sessionsRoot: string,
  expectedConversationId: string,
  skipDirectory: string,
): Promise<DisplayCheckpoint | undefined> {
  let entries;
  try {
    entries = await readdir(sessionsRoot, { withFileTypes: true });
  } catch {
    return undefined;
  }
  // Cross-workspace compaction is unusual; search directories concurrently only
  // when the parent was not beside its child.
  const matches = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(sessionsRoot, entry.name))
      .filter((directory) => directory !== skipDirectory)
      .map((directory) => findCheckpoint(sessionId, directory, expectedConversationId)),
  );
  return matches.find((checkpoint) => checkpoint !== undefined);
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((part) =>
      typeof (part as { text?: unknown })?.text === "string"
        ? [(part as { text: string }).text]
        : [],
    )
    .join("\n");
}

function visibility(message: DisplayStoredMessage): "transcript" | "hidden" | "summary" {
  if (message.provenance?.visibility) return message.provenance.visibility;
  if (message.role === "system") return "hidden";
  const text = messageText(message.content);
  if (message.role === "user" && text.startsWith("[Previous conversation summary]")) {
    return "summary";
  }
  if (
    message.role === "assistant" &&
    text.startsWith("I have the full context from the summary above")
  ) {
    return "hidden";
  }
  return "transcript";
}

function canonicalValue(value: unknown): unknown {
  if (typeof value === "string") return value.replace(/\r\n?/g, "\n").trimEnd();
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalValue(entry)]),
    );
  }
  return value;
}

function reconstructCheckpoints(checkpoints: DisplayCheckpoint[]): DisplayStoredMessage[] {
  const transcript: DisplayStoredMessage[] = [];
  const transcriptKeys: string[] = [];
  for (let index = 0; index < checkpoints.length; index += 1) {
    const checkpoint = checkpoints[index]!;
    const parent = checkpoints[index - 1];
    const parentAvailable =
      parent !== undefined && checkpoint.header.parentSessionId === parent.header.id;
    const messages = checkpoint.messages.filter((message) => {
      const state = visibility(message);
      return state !== "hidden" && !(state === "summary" && parentAvailable);
    });
    const keys = messages.map((message) =>
      JSON.stringify(
        canonicalValue({
          role: message.role,
          content: message.content,
          provenance: message.provenance ?? null,
        }),
      ),
    );

    let overlap = Math.min(transcriptKeys.length, keys.length);
    while (overlap > 0) {
      const start = transcriptKeys.length - overlap;
      if (keys.slice(0, overlap).every((key, offset) => transcriptKeys[start + offset] === key)) {
        break;
      }
      overlap -= 1;
    }
    transcript.push(...messages.slice(overlap));
    transcriptKeys.push(...keys.slice(overlap));
  }
  return transcript;
}

/**
 * Read GG Coder's display transcript directly so UI paint does not wait for its
 * machine-wide ACP checkpoint scan. The live ACP process still loads in parallel
 * and remains authoritative for prompts and subsequent updates.
 */
export async function loadGgCoderDisplayHistory(
  sessionId: string,
  cwd: string,
  sessionsRoot = path.join(homedir(), ".gg", "sessions"),
): Promise<GgCoderDisplayUpdate[] | undefined> {
  const directory = path.join(sessionsRoot, encodeCwd(cwd));
  const newest = await findCheckpoint(sessionId, directory);
  if (!newest) return undefined;
  const conversationId = newest.header.conversationId ?? newest.header.id;
  const checkpoints = [newest];
  const visited = new Set([newest.header.id]);
  let current = newest;

  while (current.header.parentSessionId && !visited.has(current.header.parentSessionId)) {
    const parentId = current.header.parentSessionId;
    const parent =
      (await findCheckpoint(parentId, directory, conversationId)) ??
      (await findCheckpointAcrossRoot(parentId, sessionsRoot, conversationId, directory));
    if (!parent) break;
    visited.add(parent.header.id);
    checkpoints.unshift(parent);
    current = parent;
  }

  const updates: GgCoderDisplayUpdate[] = [];
  for (const message of reconstructCheckpoints(checkpoints)) {
    if (message.provenance?.kind === "automation" || message.provenance?.kind === "notification") {
      continue;
    }
    if (message.role === "user") {
      const text = messageText(message.content).trim();
      if (text) {
        updates.push({
          sessionUpdate: "user_message_chunk",
          content: { type: "text", text },
        });
      }
      continue;
    }
    if (message.role === "assistant") {
      const text = messageText(message.content);
      if (text) {
        updates.push({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text },
        });
      }
    }
  }
  return updates;
}