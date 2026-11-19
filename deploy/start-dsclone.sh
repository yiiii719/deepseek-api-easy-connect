#!/system/bin/sh
# DeepSeek Clone 启动脚本（设备端）
# 开机自启由 /data/adb/service.d/dsclone.sh 调用本脚本
set -u
BASE=/data/local/dsclone
export PATH=/data/local/node/bin:$PATH
export LD_LIBRARY_PATH=/data/local/node/lib
export NODE_EXTRA_CA_CERTS=/data/local/node/etc/tls/cert.pem
export DS_DATA_DIR=$BASE/data
export DS_PORT=${DS_PORT:-8899}
export DS_HOST=0.0.0.0

mkdir -p "$DS_DATA_DIR"

# 已在跑就不重复起
if [ -f "$BASE/dsclone.pid" ]; then
  OLD=$(cat "$BASE/dsclone.pid")
  if [ -n "$OLD" ] && kill -0 "$OLD" 2>/dev/null; then
    echo "already running pid=$OLD"
    exit 0
  fi
fi

cd "$BASE" || exit 1
nohup node server/index.mjs >> "$BASE/dsclone.log" 2>&1 &
echo $! > "$BASE/dsclone.pid"
sleep 1
echo "started pid=$(cat "$BASE/dsclone.pid")"
