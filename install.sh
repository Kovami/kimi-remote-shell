#!/usr/bin/env bash
#
# install.sh — install the kimi-remote-shell plugin into Kimi Code
# (equivalent of `/plugins install <path>`, but scriptable).
#
set -euo pipefail

src="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/plugin"
kimi_home="${KIMI_CODE_HOME:-$HOME/.kimi-code}"
dest="$kimi_home/plugins/managed/kimi-remote-shell"

[[ -f "$src/kimi.plugin.json" ]] || { echo "plugin/ not found next to install.sh" >&2; exit 1; }

mkdir -p "$(dirname "$dest")"
rm -rf "$dest"
cp -R "$src" "$dest"
chmod +x "$dest/server.mjs"

SRC="$src" DEST="$dest" KIMI_HOME="$kimi_home" node <<'EOF'
const fs = require("fs");
const path = require("path");

const file = path.join(process.env.KIMI_HOME, "plugins", "installed.json");
let data;
try {
  data = JSON.parse(fs.readFileSync(file, "utf8"));
} catch {
  data = { version: 1, plugins: [] };
}
if (!Array.isArray(data.plugins)) data.plugins = [];

data.plugins = data.plugins.filter((p) => p.id !== "kimi-remote-shell");
const now = new Date().toISOString();
data.plugins.push({
  id: "kimi-remote-shell",
  root: fs.realpathSync(process.env.DEST),
  source: "local-path",
  enabled: true,
  installedAt: now,
  updatedAt: now,
  originalSource: fs.realpathSync(process.env.SRC),
});

const tmp = file + ".tmp";
fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
fs.renameSync(tmp, file);
console.log("installed.json updated:", file);
EOF

echo "✅ Plugin installed to $dest"
echo "   Start a new session (or run /reload) for it to take effect."
