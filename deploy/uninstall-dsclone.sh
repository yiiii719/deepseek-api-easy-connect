#!/system/bin/sh
# 卸载：停进程 + 删程序 + 取消开机自启（数据目录一并删除，删前想清楚）
BASE=/data/local/dsclone
PIDF="$BASE/dsclone.pid"
if [ -f "$PIDF" ]; then
  PID=$(cat "$PIDF")
  [ -n "$PID" ] && kill "$PID" 2>/dev/null
  rm -f "$PIDF"
fi
rm -f /data/adb/service.d/dsclone.sh
rm -rf "$BASE"
echo "uninstalled: process killed, /data/adb/service.d/dsclone.sh removed, $BASE deleted"
echo "桌面图标请在桌面上长按移除"
