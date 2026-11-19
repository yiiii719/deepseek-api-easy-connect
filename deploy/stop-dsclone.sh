#!/system/bin/sh
# 停掉设备端服务（验收用）
BASE=/data/local/dsclone
if [ -f "$BASE/dsclone.pid" ]; then
  PID=$(cat "$BASE/dsclone.pid")
  [ -n "$PID" ] && kill "$PID" 2>/dev/null
  rm -f "$BASE/dsclone.pid"
fi
# 兜底：按命令行匹配再杀一次
for p in $(ps -A -o PID,ARGS | grep "server/index.mjs" | grep -v grep | awk '{print $1}'); do
  kill "$p" 2>/dev/null
done
sleep 1
LD_LIBRARY_PATH= curl -s -m 3 -o /dev/null -w "health_after_stop=%{http_code}\n" http://127.0.0.1:8899/api/health
echo "done"
