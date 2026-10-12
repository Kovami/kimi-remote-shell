#!/usr/bin/env node
//
// PreToolUse(Bash) hook: in a kimi-remote-shell session (KIMI_REMOTE_HOST is
// set by the launcher), blocks the built-in Bash tool and steers the agent to
// the remote-shell MCP tool. Outside a remote session this hook is a no-op.

if (!process.env.KIMI_REMOTE_HOST) {
  process.exit(0);
}

// Best-effort: confirm the remote tool is actually available; if the MCP
// server is down, blocking Bash would leave the agent with no shell at all.
const message =
  `The built-in Bash tool is disabled in this kimi-remote-shell session. ` +
  `All shell commands must run on the remote host (${process.env.KIMI_REMOTE_HOST}) via the MCP tool ` +
  `\`mcp__plugin-kimi-remote-shell_remote-shell__bash\` (server "remote-shell"). ` +
  `It takes the same parameters (command, cwd, timeout, run_in_background, description). ` +
  `Retry the operation with that tool.`;

process.stderr.write(message + "\n");
process.exit(2);
