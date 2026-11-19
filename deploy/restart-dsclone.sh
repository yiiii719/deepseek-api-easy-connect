#!/system/bin/sh
# 设备端重启：停旧进程 → 起新进程 → 打印健康检查
BASE=/data/local/dsclone
if [ -f "$BASE/dsclone.pid" ]; then
  OLD=$(cat "$BASE/dsclone.pid")
  if [ -n "$OLD" ]; then kill "$OLD" 2>/dev/null; fi
  rm -f "$BASE/dsclone.pid"
  sleep 1
fi
sh "$BASE/deploy/start-dsclone.sh"
sleep 2
LD_LIBRARY_PATH= curl -s -m 5 http://127.0.0.1:8899/api/health
echo ""
LD_LIBRARY_PATH= curl -s -m 5 -o /dev/null -w "index_http=%{http_code} time=%{time_total}s\n" http://127.0.0.1:8899/
