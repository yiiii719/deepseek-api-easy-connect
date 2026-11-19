#!/system/bin/sh
# 开机自启：放到 /data/adb/service.d/ 即可（Magisk 的 late_start 服务脚本）
# 回滚：rm /data/adb/service.d/dsclone.sh
sleep 20
sh /data/local/dsclone/deploy/start-dsclone.sh >> /data/local/dsclone/boot.log 2>&1
