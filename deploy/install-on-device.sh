#!/system/bin/sh
# 设备端安装：把 /data/local/tmp/dsclone 装到 /data/local/dsclone（root 拥有）
# 注意：必须「先删再拷」，`cp -r src dst` 在 dst 已存在时会拷成 dst/src/src
SRC=/data/local/tmp/dsclone
DST=/data/local/dsclone
set -e
mkdir -p "$DST"
rm -rf "$DST/server" "$DST/web" "$DST/deploy"
cp -r "$SRC/server" "$DST/server"
cp -r "$SRC/web" "$DST/web"
cp -r "$SRC/deploy" "$DST/deploy"
cp -f "$SRC/package.json" "$DST/package.json"
chmod -R 755 "$DST"
mkdir -p "$DST/data"
echo "--- installed ---"
ls -l "$DST"
echo "--- server files ---"
ls "$DST/server"
echo "--- provider presets in code ---"
grep -m2 "id: '" "$DST/server/config.mjs"
