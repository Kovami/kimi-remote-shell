#!/usr/bin/env node
//
// kimi-remote-shell MCP server: executes shell commands on a remote host over SSH.
// Zero-dependency MCP stdio server (newline-delimited JSON-RPC).
//
// Configuration via environment (exported by the kimi-remote-shell launcher):
//   KIMI_REMOTE_HOST         [user@]host (required)
//   KIMI_REMOTE_SSH_OPTIONS  ssh options string (ControlMaster etc.)
//   KIMI_REMOTE_TMPDIR       remote tmp directory for logs/tasks
//   KIMI_REMOTE_SHELL_DIR    local session directory (task registry, flags)
//   KIMI_LOCAL_PATH          local project dir (optional, for path mapping)
//   KIMI_REMOTE_PATH         remote project dir (optional, for path mapping)
//   MUTAGEN_DATA_DIRECTORY   if set, mutagen sync is flushed around commands

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const HOST = process.env.KIMI_REMOTE_HOST || "";
const SSH_OPTS = (process.env.KIMI_REMOTE_SSH_OPTIONS || "").split(/\s+/).filter(Boolean);
const REMOTE_TMPDIR = process.env.KIMI_REMOTE_TMPDIR || "/tmp";
const SESSION_DIR = process.env.KIMI_REMOTE_SHELL_DIR || "";
const LOCAL_PATH = process.env.KIMI_LOCAL_PATH || "";
const REMOTE_PATH = process.env.KIMI_REMOTE_PATH || "";
const MAP_PATHS = Boolean(LOCAL_PATH && REMOTE_PATH && LOCAL_PATH !== REMOTE_PATH);

const MAX_OUTPUT_CHARS = 48000;
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 300_000;
const REGISTRY_FILE = SESSION_DIR ? path.join(SESSION_DIR, "remote-tasks.json") : "";

function log(...args) {
  process.stderr.write(`[remote-shell] ${args.join(" ")}\n`);
}

function shq(s) {
  return "'" + String(s).replace(/'/g, `'\\''`) + "'";
}

// Remote-shell snippets: resolve the directory in $1 (expanding a leading ~, which cd "~" does not) into $d, and cd there.
const EXPAND_CWD = 'd=$1; case "$d" in "~"|"~/"*) d="$HOME${d#\\~}";; esac';
const CD_SNIPPET = EXPAND_CWD + '; cd "$d"';

function toRemote(text) {
  return MAP_PATHS ? String(text).split(LOCAL_PATH).join(REMOTE_PATH) : String(text);
}

function mapOutput(text) {
  return MAP_PATHS ? String(text).split(REMOTE_PATH).join(LOCAL_PATH) : String(text);
}

function mutagenFlush() {
  if (!process.env.MUTAGEN_DATA_DIRECTORY) return;
  try {
    const r = spawnSync("mutagen", ["sync", "flush", "--all"], { stdio: "ignore", timeout: 30000 });
    if (r.status !== 0) {
      spawnSync("mutagen", ["sync", "reset", "--all"], { stdio: "ignore", timeout: 30000 });
      spawnSync("mutagen", ["sync", "flush", "--all"], { stdio: "ignore", timeout: 30000 });
    }
  } catch (e) {
    log("mutagen flush failed:", e.message);
  }
}

function sshArgs(remoteCmd) {
  return [...SSH_OPTS, HOST, remoteCmd];
}

// Run a remote command string (already a full remote shell command) to completion.
function sshRunRaw(remoteCmd, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn("ssh", sshArgs(remoteCmd), { stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    let stdout = "";
    let stderr = "";
    let killed = false;
    child.stdout.on("data", (d) => {
      stdout += d;
      if (stdout.length > MAX_OUTPUT_CHARS * 2) stdout = stdout.slice(-MAX_OUTPUT_CHARS * 2);
    });
    child.stderr.on("data", (d) => {
      stderr += d;
      if (stderr.length > MAX_OUTPUT_CHARS * 2) stderr = stderr.slice(-MAX_OUTPUT_CHARS * 2);
    });
    const timer = setTimeout(() => {
      killed = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5000).unref();
    }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: 255, stdout, stderr: stderr + String(err), killed });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: killed ? 124 : code ?? 255, stdout, stderr, killed });
    });
  });
}

// Run a user command on the remote with cwd and TMPDIR set up (mirrors the
// claude-remote-shell bash wrapper).
function sshRunCommand(command, cwd, timeoutMs) {
  const remoteScript = `export SHELL=bash TMPDIR="$3" && mkdir -p "$TMPDIR" && ${CD_SNIPPET} && eval "$2"`;
  const remoteCmd = `bash -c ${shq(remoteScript)} _ ${shq(cwd)} ${shq(command)} ${shq(REMOTE_TMPDIR)}`;
  return sshRunRaw(remoteCmd, timeoutMs);
}

function clampTimeout(timeout) {
  if (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(Math.trunc(timeout), MAX_TIMEOUT_MS);
}

function truncateOutput(text) {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  return `[output truncated: showing last ${MAX_OUTPUT_CHARS} of ${text.length} chars]\n` + text.slice(-MAX_OUTPUT_CHARS);
}

function formatResult({ code, stdout, stderr, killed }, timedOutMs) {
  let out = "";
  if (killed) out += `Command killed by timeout (${Math.round(timedOutMs / 1000)}s)\n`;
  if (stdout) out += mapOutput(truncateOutput(stdout));
  if (stderr) out += (out ? "\n" : "") + mapOutput(truncateOutput(stderr));
  if (!out) out = "(no output)";
  if (!killed) out += `\n\nCommand ${code === 0 ? "executed successfully" : `failed with exit code: ${code}`}.`;
  return { text: out, isError: killed || code !== 0 };
}

// --- background task registry ------------------------------------------------

function loadRegistry() {
  if (!REGISTRY_FILE) return [];
  try {
    return JSON.parse(fs.readFileSync(REGISTRY_FILE, "utf8"));
  } catch {
    return [];
  }
}

function saveRegistry(tasks) {
  if (!REGISTRY_FILE) return;
  try {
    fs.writeFileSync(REGISTRY_FILE, JSON.stringify(tasks, null, 2));
  } catch (e) {
    log("failed to save task registry:", e.message);
  }
}

async function startBackground(command, cwd, description) {
  const id = `rtask_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  const tasksDir = `${REMOTE_TMPDIR}/tasks`;
  const logPath = `${tasksDir}/${id}.log`;
  const exitPath = `${tasksDir}/${id}.exit`;
  const runner = 'export SHELL=bash TMPDIR="$3"; (eval "$1"); echo $? > "$2"';
  // $1 cwd, $2 command, $3 exit file, $4 TMPDIR, $5 tasks dir, $6 log file.
  // cd is checked before backgrounding (a failure must not report a running task);
  // setsid gives the job its own process group so task_stop can kill the whole tree.
  const launch =
    `${EXPAND_CWD}\n` +
    `mkdir -p "$5" && cd "$d" || exit 1\n` +
    `setsid nohup bash -c ${shq(runner)} _ "$2" "$3" "$4" > "$6" 2>&1 < /dev/null &\n` +
    `echo $!`;
  const script = `bash -c ${shq(launch)} _ ${shq(cwd)} ${shq(command)} ${shq(exitPath)} ${shq(REMOTE_TMPDIR)} ${shq(tasksDir)} ${shq(logPath)}`;
  const r = await sshRunRaw(script, 30000);
  const pid = parseInt(r.stdout.trim(), 10);
  if (r.code !== 0 || !Number.isFinite(pid)) {
    return { text: `Failed to start remote background task: ${r.stderr || r.stdout}`, isError: true };
  }
  const tasks = loadRegistry();
  tasks.push({ id, pid, description, cwd, command, logPath, exitPath, startedAt: new Date().toISOString() });
  saveRegistry(tasks);
  const text =
    `task_id: ${id}\npid: ${pid}\ndescription: ${description}\nstatus: running\n` +
    `next_step: poll with the task_output tool; there are no automatic completion notifications for remote tasks.`;
  return { text, isError: false };
}

async function taskStatusScript(t) {
  return (
    `if [ -f ${shq(t.exitPath)} ]; then echo "exited ($(cat ${shq(t.exitPath)} 2>/dev/null))"; ` +
    `elif kill -0 ${t.pid} 2>/dev/null; then echo running; ` +
    `else echo "unknown (process gone, no exit record)"; fi`
  );
}

async function taskOutput(taskId) {
  const t = loadRegistry().find((x) => x.id === taskId);
  if (!t) return { text: `Unknown remote task: ${taskId}`, isError: true };
  const script = `${await taskStatusScript(t)}; echo "---"; tail -c 65536 ${shq(t.logPath)} 2>/dev/null`;
  const r = await sshRunRaw(script, 30000);
  if (r.code !== 0) return { text: `Failed to query remote task ${taskId}: ${r.stderr}`, isError: true };
  return { text: `task_id: ${t.id}\ndescription: ${t.description}\n${mapOutput(r.stdout)}`, isError: false };
}

async function taskList() {
  const tasks = loadRegistry();
  if (tasks.length === 0) return { text: "No remote background tasks.", isError: false };
  const parts = await Promise.all(
    tasks.map(async (t) => {
      const r = await sshRunRaw(await taskStatusScript(t), 15000);
      const status = r.code === 0 ? r.stdout.trim() : "query failed";
      return `${t.id}  [${status}]  ${t.description}`;
    })
  );
  return { text: parts.join("\n"), isError: false };
}

async function taskStop(taskId) {
  const tasks = loadRegistry();
  const t = tasks.find((x) => x.id === taskId);
  if (!t) return { text: `Unknown remote task: ${taskId}`, isError: true };
  const script = `kill -- -${t.pid} 2>/dev/null; sleep 1; kill -9 -- -${t.pid} 2>/dev/null; true`;
  await sshRunRaw(script, 15000);
  saveRegistry(tasks.filter((x) => x.id !== taskId));
  return { text: `Remote task ${t.id} stopped (SIGTERM, then SIGKILL after 1s grace).`, isError: false };
}

// --- tools --------------------------------------------------------------------

const TOOLS = [
  {
    name: "bash",
    description:
      `Execute a shell command REMOTELY on ${HOST || "the configured host"} over SSH. ` +
      "This replaces the built-in Bash tool in this session: local shell execution is blocked. " +
      "Files in the synced project directory are visible on both sides (bidirectional sync, flushed before and after each command). " +
      "Parameters mirror the built-in Bash tool. On the remote, NEVER assume /tmp — use $TMPDIR.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "The shell command to execute on the remote host" },
        cwd: { type: "string", description: "Working directory (local paths are translated to remote paths automatically)" },
        timeout: { type: "number", description: "Timeout in milliseconds; default 60000, max 300000" },
        run_in_background: { type: "boolean", description: "Run as a remote background task" },
        description: { type: "string", description: "Background task description; required when run_in_background=true" },
      },
      required: ["command"],
    },
  },
  {
    name: "task_output",
    description:
      "Get the status and output of a remote background task started with bash(run_in_background=true). " +
      "Remote tasks have NO automatic completion notifications — poll this tool when you need the result.",
    inputSchema: {
      type: "object",
      properties: { task_id: { type: "string", description: "The remote task id (rtask_...)" } },
      required: ["task_id"],
    },
  },
  {
    name: "task_list",
    description: "List remote background tasks and their status.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "task_stop",
    description: "Stop a remote background task (SIGTERM, then SIGKILL after a short grace period).",
    inputSchema: {
      type: "object",
      properties: { task_id: { type: "string", description: "The remote task id (rtask_...)" } },
      required: ["task_id"],
    },
  },
];

async function callTool(name, args) {
  if (!HOST) {
    return {
      text: "Not in a kimi-remote-shell session (KIMI_REMOTE_HOST is unset). Start kimi via the kimi-remote-shell launcher.",
      isError: true,
    };
  }
  switch (name) {
    case "bash": {
      const command = toRemote(args.command ?? "");
      if (!command) return { text: "Command cannot be empty.", isError: true };
      const cwd = toRemote(args.cwd || LOCAL_PATH || "~");
      if (args.run_in_background === true) {
        if (!args.description || !String(args.description).trim()) {
          return { text: "description is required when run_in_background is true.", isError: true };
        }
        mutagenFlush();
        const r = await startBackground(command, cwd, String(args.description).trim());
        mutagenFlush();
        return r;
      }
      const timeoutMs = clampTimeout(args.timeout);
      mutagenFlush();
      const r = await sshRunCommand(command, cwd, timeoutMs);
      mutagenFlush();
      return formatResult(r, timeoutMs);
    }
    case "task_output":
      return taskOutput(String(args.task_id ?? ""));
    case "task_list":
      return taskList();
    case "task_stop":
      return taskStop(String(args.task_id ?? ""));
    default:
      return { text: `Unknown tool: ${name}`, isError: true };
  }
}

// --- MCP stdio loop -------------------------------------------------------------

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

async function handleMessage(msg) {
  const isRequest = msg.id !== undefined && msg.id !== null;
  try {
    switch (msg.method) {
      case "initialize":
        if (isRequest) {
          send({
            jsonrpc: "2.0",
            id: msg.id,
            result: {
              protocolVersion: msg.params?.protocolVersion || "2024-11-05",
              capabilities: { tools: {} },
              serverInfo: { name: "remote-shell", version: "0.1.0" },
            },
          });
        }
        return;
      case "ping":
        if (isRequest) send({ jsonrpc: "2.0", id: msg.id, result: {} });
        return;
      case "tools/list":
        if (isRequest) send({ jsonrpc: "2.0", id: msg.id, result: { tools: HOST ? TOOLS : [] } });
        return;
      case "tools/call": {
        if (!isRequest) return;
        const r = await callTool(msg.params?.name, msg.params?.arguments || {});
        send({
          jsonrpc: "2.0",
          id: msg.id,
          result: { content: [{ type: "text", text: r.text }], isError: r.isError },
        });
        return;
      }
      default:
        if (isRequest) {
          send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } });
        }
    }
  } catch (e) {
    log("handler error:", e);
    if (isRequest) {
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: { content: [{ type: "text", text: `remote-shell error: ${e.message}` }], isError: true },
      });
    }
  }
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let i;
  while ((i = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, i);
    buffer = buffer.slice(i + 1);
    if (!line.trim()) continue;
    try {
      handleMessage(JSON.parse(line));
    } catch (e) {
      log("bad message:", e.message);
    }
  }
});

log(`server started (host=${HOST || "<unset>"}, pid=${process.pid})`);
