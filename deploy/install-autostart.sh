#!/system/bin/sh
# 安装开机自启：把脚本放进 /data/adb/service.d（Magisk late_start 服务目录）
set -x
SRC=/data/local/tmp/service-d-dsclone.sh
DST=/data/adb/service.d/dsclone.sh
mkdir -p /data/adb/service.d
cp -f "$SRC" "$DST"
chmod 755 "$DST"
ls -lZ "$DST"
cat "$DST"
