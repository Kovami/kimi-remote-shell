#!/usr/bin/env node
//
// UserPromptSubmit hook: on the first prompt of a kimi-remote-shell session,
// appends a description of the remote environment to the context. No-op
// outside remote sessions and on subsequent prompts.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const host = process.env.KIMI_REMOTE_HOST;
if (!host) process.exit(0);

const sessionDir = process.env.KIMI_REMOTE_SHELL_DIR || "";
const flag = sessionDir ? path.join(sessionDir, "context-injected") : "";
if (flag && fs.existsSync(flag)) process.exit(0);

let remoteSystem = "unknown";
try {
  const opts = (process.env.KIMI_REMOTE_SSH_OPTIONS || "").split(/\s+/).filter(Boolean);
  remoteSystem = execFileSync("ssh", [...opts, host, "uname -sr"], {
    encoding: "utf8",
    timeout: 10000,
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
} catch {
  // leave as "unknown"
}

const localPath = process.env.KIMI_LOCAL_PATH || "";
const remotePath = process.env.KIMI_REMOTE_PATH || "";
const tmpdir = process.env.KIMI_REMOTE_TMPDIR || "$TMPDIR";

const lines = [
  `[kimi-remote-shell] This is a remote-shell session. All shell commands run REMOTELY on ${host}, not locally. You have no local shell access (the built-in Bash tool is blocked).`,
  ``,
  `Remote environment:`,
  `- Platform / OS: ${remoteSystem}`,
  `- Shell: bash`,
  `- TMPDIR: ${tmpdir}`,
  ``,
  `Rules:`,
  `- For EVERY shell command use the MCP tool \`mcp__plugin-kimi-remote-shell_remote-shell__bash\` (same parameters as the built-in Bash tool).`,
  `- NEVER assume /tmp on the remote — always use \\$TMPDIR, including for mktemp.`,
  `- File tools (Read/Write/Edit/Grep/Glob) operate LOCALLY; local changes sync to the remote automatically around each command.`,
  `- For background work use run_in_background and the \`...__task_output\` / \`...__task_list\` / \`...__task_stop\` tools; poll task_output for results — there are no automatic completion notifications.`,
];

if (localPath && remotePath) {
  lines.push(
    `- Project sync: local ${localPath} is synced bidirectionally with remote ${remotePath} (paths in commands and output are translated automatically).`
  );
}

if (flag) {
  try {
    fs.writeFileSync(flag, new Date().toISOString());
  } catch {
    // non-fatal
  }
}

process.stdout.write(lines.join("\n") + "\n");
process.exit(0);
