#!/system/bin/sh
# 设备端自检：Node 运行时 + node:sqlite + 外网连通性
# 用法：adb push deploy/device-selfcheck.sh /data/local/tmp/selfcheck.sh
#       adb shell 'su -c "sh /data/local/tmp/selfcheck.sh"'
# 注意：Node 与系统命令不能共用 LD_LIBRARY_PATH，调 curl 时要清空这一项
export PATH=/data/local/node/bin:$PATH
export LD_LIBRARY_PATH=/data/local/node/lib
export NODE_EXTRA_CA_CERTS=/data/local/node/etc/tls/cert.pem

echo "== node =="
node -v

echo "== sqlite =="
node -e 'const {DatabaseSync}=require("node:sqlite");const db=new DatabaseSync("/data/local/tmp/_t.db");db.exec("create table if not exists t(a)");console.log("sqlite OK",db.prepare("select 1 as n").get().n);'

echo "== fetch（不带 key，401 也算通） =="
node -e 'fetch("https://api.deepseek.com/v1/models").then(r=>console.log("http",r.status)).catch(e=>console.log("ERR",e.message))'

echo "== curl（不共用 LD_LIBRARY_PATH） =="
LD_LIBRARY_PATH= curl -s -m 6 -o /dev/null -w "curl_http=%{http_code} time=%{time_total}\n" https://api.deepseek.com/v1/models

echo "== done =="
