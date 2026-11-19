// 手搓 APK：aapt2 编译资源 → javac → d8 → zip 里塞 classes.dex → zipalign → apksigner
// 只依赖 android/sdk 下解压出来的 build-tools r34 + platform android-34
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
process.chdir(HERE)

const SDK = path.join(HERE, 'sdk')
const BT = path.join(SDK, 'android-14')
const ANDROID_JAR = path.join(SDK, 'android-34', 'android.jar')
const AAPT2 = path.join(BT, 'aapt2.exe')
const ZIPALIGN = path.join(BT, 'zipalign.exe')
const D8_JAR = path.join(BT, 'lib', 'd8.jar')
const SIGNER_JAR = path.join(BT, 'lib', 'apksigner.jar')
const JAVA = process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin', 'java.exe') : 'java'
const JAVAC = process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin', 'javac.exe') : 'javac'
const JAR = process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin', 'jar.exe') : 'jar'

const OUT = path.join(HERE, 'build')
const KS = path.join(HERE, 'tide.jks')
const KS_PASS = 'tidepass'
const VERSION = '1.1.0'
const APK_NAME = `Tide-${VERSION}.apk`

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts })
  if (r.status !== 0) {
    console.error(`\n✗ 失败：${path.basename(cmd)} ${args.slice(0, 3).join(' ')} ...（exit ${r.status}）`)
    process.exit(r.status || 1)
  }
}

fs.rmSync(OUT, { recursive: true, force: true })
fs.mkdirSync(path.join(OUT, 'gen'), { recursive: true })
fs.mkdirSync(path.join(OUT, 'classes'), { recursive: true })
fs.mkdirSync(path.join(OUT, 'dex'), { recursive: true })

console.log('⓪ 打包前端资源 → assets/web')
const assetsWeb = path.join(HERE, 'assets', 'web')
fs.rmSync(path.join(HERE, 'assets'), { recursive: true, force: true })
fs.mkdirSync(assetsWeb, { recursive: true })
fs.cpSync(path.join(HERE, '..', 'web'), assetsWeb, { recursive: true })
const assetCount = fs.readdirSync(assetsWeb, { recursive: true }).length
console.log(`   ${assetCount} 个文件`)

console.log('① aapt2 compile')
run(AAPT2, ['compile', '--dir', 'res', '-o', path.join(OUT, 'res.zip')])

console.log('② aapt2 link')
run(AAPT2, [
  'link',
  '-o', path.join(OUT, 'base.apk'),
  '-I', ANDROID_JAR,
  '--manifest', 'AndroidManifest.xml',
  '-R', path.join(OUT, 'res.zip'),
  '--java', path.join(OUT, 'gen'),
  '-A', 'assets',
  '--min-sdk-version', '24',
  '--target-sdk-version', '34',
  '--version-code', '1',
  '--version-name', VERSION,
  '--auto-add-overlay',
])

console.log('③ javac')
const javaDir = path.join(HERE, 'java')
const sources = [path.join(OUT, 'gen', 'com', 'tide', 'chat', 'R.java')]
const walk = (d) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name)
    if (e.isDirectory()) walk(p)
    else if (e.name.endsWith('.java')) sources.push(p)
  }
}
walk(javaDir)
run(JAVAC, [
  '-encoding', 'UTF-8',
  '-source', '8',
  '-target', '8',
  '-bootclasspath', ANDROID_JAR,
  '-nowarn',
  '-d', path.join(OUT, 'classes'),
  ...sources,
])

console.log('④ jar + d8')
run(JAR, ['cf', path.join(OUT, 'classes.jar'), '-C', path.join(OUT, 'classes'), '.'])
run(JAVA, ['-cp', D8_JAR, 'com.android.tools.r8.D8', '--release', '--min-api', '24', '--lib', ANDROID_JAR, '--output', path.join(OUT, 'dex'), path.join(OUT, 'classes.jar')])

console.log('⑤ 把 classes.dex 塞进 APK（不影响 resources.arsc 的存储方式）')
const py = `
import zipfile, shutil, sys
src, dex, dst = sys.argv[1], sys.argv[2], sys.argv[3]
shutil.copyfile(src, dst)
with zipfile.ZipFile(dst, 'a', zipfile.ZIP_DEFLATED) as z:
    z.write(dex, 'classes.dex')
print('  dex size', __import__('os').path.getsize(dex))
`
run('python', ['-c', py, path.join(OUT, 'base.apk'), path.join(OUT, 'dex', 'classes.dex'), path.join(OUT, 'withdex.apk')])

console.log('⑥ zipalign')
run(ZIPALIGN, ['-f', '-p', '4', path.join(OUT, 'withdex.apk'), path.join(OUT, 'aligned.apk')])

console.log('⑦ apksigner sign')
run(JAVA, [
  '-jar', SIGNER_JAR,
  'sign',
  '--ks', KS,
  '--ks-key-alias', 'tide',
  '--ks-pass', `pass:${KS_PASS}`,
  '--key-pass', `pass:${KS_PASS}`,
  '--out', path.join(HERE, APK_NAME),
  path.join(OUT, 'aligned.apk'),
])

console.log('⑧ verify')
run(JAVA, ['-jar', SIGNER_JAR, 'verify', '--print-certs', path.join(HERE, APK_NAME)])

const st = fs.statSync(path.join(HERE, APK_NAME))
const count = spawnSync('python', ['-c', `
import zipfile,sys
z=zipfile.ZipFile(sys.argv[1])
n=[x for x in z.namelist() if x.startswith('assets/web/')]
print(len(n))
`, path.join(HERE, APK_NAME)], { encoding: 'utf8' })
console.log(`✓ ${APK_NAME}  ${(st.size / 1024 / 1024).toFixed(2)} MB   assets/web 条目 ${count.stdout.trim()}`)
