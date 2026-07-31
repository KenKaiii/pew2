import { createReadStream } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import readline from "node:readline";
import type { AgentSession } from "./connect.js";

export interface ClaudeDisplayMessage {
  role: "user" | "assistant";
  text: string;
}

const LOCAL_COMMAND_TAGS = [
  "command-name",
  "command-message",
  "command-args",
  "local-command-stdout",
  "local-command-stderr",
];

function encodeCwd(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

function stripLocalCommandTags(text: string): string {
  let stripped = text;
  for (const tag of LOCAL_COMMAND_TAGS) {
    stripped = stripped.replace(new RegExp(`<${tag}>[\\s\\S]*?<\\/${tag}>`, "g"), "");
  }
  return stripped;
}

function visibleText(content: unknown, role: "user" | "assistant"): string {
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .filter((block) => (block as { type?: string })?.type === "text")
            .map((block) => (block as { text?: string }).text ?? "")
            .join("")
        : "";
  return role === "user" ? stripLocalCommandTags(text) : text;
}

async function readDisplayMessages(filePath: string): Promise<ClaudeDisplayMessage[]> {
  const lines = readline.createInterface({
    input: createReadStream(filePath),
    crlfDelay: Infinity,
  });
  const messages: ClaudeDisplayMessage[] = [];

  try {
    for await (const line of lines) {
      let entry: any;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      const role = entry?.message?.role;
      if (role !== "user" && role !== "assistant") continue;
      // Match the official adapter: local-command metadata and subagent text are
      // not part of the top-level ACP conversation replay.
      if (entry.isMeta === true || entry.isSidechain === true) continue;
      const text = visibleText(entry.message?.content, role).trim();
      if (!text) continue;
      if (role === "assistant" && text.includes("Please run /login")) continue;
      messages.push({ role, text });
    }
  } finally {
    lines.close();
  }
  return messages;
}

function sessionPath(sessionId: string, cwd: string, projectsRoot: string): string {
  return path.join(projectsRoot, encodeCwd(cwd), `${sessionId}.jsonl`);
}

/** Read a Claude transcript locally so its screen can paint before ACP boots. */
export async function loadClaudeDisplayHistory(
  sessionId: string,
  cwd: string,
  projectsRoot = path.join(homedir(), ".claude", "projects"),
): Promise<ClaudeDisplayMessage[] | undefined> {
  try {
    return await readDisplayMessages(sessionPath(sessionId, cwd, projectsRoot));
  } catch {
    return undefined;
  }
}

/** Add counts without serially loading every Claude transcript through ACP. */
export async function hydrateClaudeMessageCounts(
  sessions: AgentSession[],
  projectsRoot = path.join(homedir(), ".claude", "projects"),
): Promise<void> {
  const pending = sessions.filter((session) => session.messageCount === undefined);
  let next = 0;
  const worker = async () => {
    while (next < pending.length) {
      const session = pending[next++];
      if (!session) return;
      try {
        const messages = await readDisplayMessages(
          sessionPath(session.sessionId, session.cwd, projectsRoot),
        );
        let count = 0;
        let previousRole: ClaudeDisplayMessage["role"] | undefined;
        for (const message of messages) {
          // The app keeps user prompts distinct but coalesces adjacent agent text.
          if (message.role === "user" || message.role !== previousRole) count += 1;
          previousRole = message.role;
        }
        session.messageCount = count;
      } catch {
        // ACP replay remains the compatibility fallback for missing/raced files.
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(12, pending.length) }, worker));
}