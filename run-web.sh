#!/bin/bash
set -euo pipefail
project_root="$(cd "$(dirname "$0")" && pwd)"
if command -v dotnet >/dev/null 2>&1; then
    dotnet_path="$(command -v dotnet)"
else
    dotnet_path="$HOME/.local/share/ucas-dotnet/dotnet"
fi
if [ ! -x "$dotnet_path" ]; then
    echo "请先安装 global.json 指定的 .NET SDK 10.0.303。"
    exit 1
fi
export DOTNET_CLI_TELEMETRY_OPTOUT=1
export UCAS_WEB_SOURCE="$project_root"
export UCAS_WEB_DATA="${UCAS_WEB_DATA:-$project_root/.local/web}"
cd "$project_root/apps/web"
exec "$dotnet_path" run --configuration Release --no-launch-profile
