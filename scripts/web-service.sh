#!/bin/bash
set -euo pipefail
project_root="$(cd "$(dirname "$0")/.." && pwd)"
service_label="cn.ucas.signin.web"
service_target="gui/$(id -u)/$service_label"
plist_path="$HOME/Library/LaunchAgents/$service_label.plist"
data_root="$project_root/.local/web"
case "${1:-status}" in
    start)
        if command -v dotnet >/dev/null 2>&1; then
            dotnet_path="$(command -v dotnet)"
        else
            dotnet_path="$HOME/.local/share/ucas-dotnet/dotnet"
        fi
        if [ ! -x "$dotnet_path" ]; then
            echo "请先安装 .NET SDK 10.0.303。"
            exit 1
        fi
        if launchctl print "$service_target" >/dev/null 2>&1; then
            launchctl bootout "$service_target"
        fi
        mkdir -p "$data_root" "$HOME/Library/LaunchAgents"
        chmod 700 "$data_root"
        DOTNET_CLI_TELEMETRY_OPTOUT=1 "$dotnet_path" publish "$project_root/apps/web/UCASSignIn.Web.csproj" \
            --configuration Release --output "$data_root/publish" --nologo
        python3 - "$project_root" "$dotnet_path" "$plist_path" "$service_label" <<'PY'
import pathlib
import plistlib
import sys

project_root, dotnet_path, plist_path, label = sys.argv[1:]
data_root = pathlib.Path(project_root) / ".local/web"
publish_root = data_root / "publish"
configuration = {
    "Label": label,
    "ProgramArguments": [dotnet_path, str(publish_root / "UCASSignIn.Web.dll")],
    "WorkingDirectory": str(publish_root),
    "RunAtLoad": True,
    "KeepAlive": True,
    "ThrottleInterval": 10,
    "EnvironmentVariables": {
        "DOTNET_ROOT": str(pathlib.Path(dotnet_path).resolve().parent),
        "DOTNET_CLI_TELEMETRY_OPTOUT": "1",
        "ASPNETCORE_ENVIRONMENT": "Production",
        "UCAS_WEB_SOURCE": project_root,
        "UCAS_WEB_DATA": str(data_root),
    },
    "StandardOutPath": str(data_root / "service.log"),
    "StandardErrorPath": str(data_root / "service-error.log"),
}
with open(plist_path, "wb") as stream:
    plistlib.dump(configuration, stream)
PY
        launchctl bootstrap "gui/$(id -u)" "$plist_path"
        echo "果壳签到已启动 http://127.0.0.1:17861，远程使用 http://本机的虚拟组网IP:17861"
        ;;
    stop)
        if launchctl print "$service_target" >/dev/null 2>&1; then
            launchctl bootout "$service_target"
        fi
        rm -f "$plist_path"
        echo "果壳签到后台服务已停止，登录启动已取消。"
        ;;
    status)
        launchctl print "$service_target"
        ;;
    *)
        echo "用法 $0 {start|stop|status}"
        exit 1
        ;;
esac
