/**
 * The manifests that ship with pew2, compiled into the binary.
 *
 * These used to be read from a `providers/` directory found by walking up from
 * this file. That works from a checkout and fails completely once the CLI is a
 * compiled executable: `import.meta.url` then points inside the embedded
 * filesystem, the walk lands on `/providers`, and the binary reports zero agents
 * on a machine that has several installed. Silently — an empty list looks
 * exactly like "you have nothing installed".
 *
 * Importing them makes the bundler inline the JSON, so the list travels with the
 * executable. A checkout still reads `~/.pew2/providers` for anything the user
 * writes themselves; only the built-in set is embedded.
 *
 * Adding a provider means adding it here as well as to `providers/`. The test
 * beside this file fails if the two ever disagree, because a manifest that
 * exists on disk but not in this list is one that works in development and
 * vanishes in the shipped binary.
 */
import type { ProviderManifestInput } from "@pew2/protocol";

import claude_code from "../../../../providers/claude-code.json" with { type: "json" };
import cline from "../../../../providers/cline.json" with { type: "json" };
import codex from "../../../../providers/codex.json" with { type: "json" };
import cursor_agent from "../../../../providers/cursor-agent.json" with { type: "json" };
import echo from "../../../../providers/echo.json" with { type: "json" };
import gemini_cli from "../../../../providers/gemini-cli.json" with { type: "json" };
import ggcoder from "../../../../providers/ggcoder.json" with { type: "json" };
import goose from "../../../../providers/goose.json" with { type: "json" };
import hermes from "../../../../providers/hermes.json" with { type: "json" };
import openclaw from "../../../../providers/openclaw.json" with { type: "json" };
import opencode from "../../../../providers/opencode.json" with { type: "json" };
import qwen_code from "../../../../providers/qwen-code.json" with { type: "json" };

/** Every bundled manifest, in the order the loader sees them. */
export const BUNDLED_MANIFESTS: ProviderManifestInput[] = [
  claude_code as ProviderManifestInput,
  cline as ProviderManifestInput,
  codex as ProviderManifestInput,
  cursor_agent as ProviderManifestInput,
  echo as ProviderManifestInput,
  gemini_cli as ProviderManifestInput,
  ggcoder as ProviderManifestInput,
  goose as ProviderManifestInput,
  hermes as ProviderManifestInput,
  openclaw as ProviderManifestInput,
  opencode as ProviderManifestInput,
  qwen_code as ProviderManifestInput,
];
