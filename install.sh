#!/usr/bin/env bash
#
# install.sh — install kimi-remote-shell.
#
#   curl -fsSL https://raw.githubusercontent.com/Kovami/kimi-remote-shell/main/install.sh | bash
#
# From a checkout (or when called by the launcher) it only installs the Kimi
# plugin into ~/.kimi-code. When piped from curl it first downloads the repo to
# $KRS_HOME and links the commands into $KRS_BIN_DIR.
#
# Env: KRS_REF (branch/tag, default main), KRS_HOME, KRS_BIN_DIR, KIMI_CODE_HOME.
#
set -euo pipefail

repo="Kovami/kimi-remote-shell"
ref="${KRS_REF:-main}"
src_dir=""
[[ -n "${BASH_SOURCE[0]:-}" ]] && src_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ ! -f "$src_dir/plugin/kimi.plugin.json" ]]; then
    command -v curl &>/dev/null || { echo "curl is required" >&2; exit 1; }
    krs_home="${KRS_HOME:-$HOME/.local/share/kimi-remote-shell}"
    bin_dir="${KRS_BIN_DIR:-$HOME/.local/bin}"
    tmp="$(mktemp -d)"
    trap 'rm -rf "$tmp"' EXIT
    echo "⬇️  Downloading $repo@$ref"
    curl -fsSL "https://github.com/$repo/archive/$ref.tar.gz" | tar -xz -C "$tmp" --strip-components=1
    rm -rf "$krs_home"
    mkdir -p "$krs_home" "$bin_dir"
    cp -R "$tmp/." "$krs_home/"
    ln -sf "$krs_home/kimi-remote-shell" "$bin_dir/kimi-remote-shell"
    ln -sf "$krs_home/kimi-remote-shell" "$bin_dir/kimi-remote-shell-yolo"
    echo "✅ Commands linked into $bin_dir"
    case ":$PATH:" in *":$bin_dir:"*) ;; *) echo "⚠️ $bin_dir is not in PATH" >&2 ;; esac
    command -v mutagen &>/dev/null || echo "⚠️ mutagen not found — install it: brew install mutagen-io/mutagen/mutagen" >&2
    exec "$krs_home/install.sh"
fi

src="$src_dir/plugin"
kimi_home="${KIMI_CODE_HOME:-$HOME/.kimi-code}"
dest="$kimi_home/plugins/managed/kimi-remote-shell"

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
EOF

echo "✅ Kimi plugin installed to $dest"
