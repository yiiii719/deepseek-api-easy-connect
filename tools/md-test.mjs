// Markdown 渲染自检：在 Node 里断言关键结构 + 测渲染耗时
import { render } from '../web/js/md.js'

const SAMPLE = `## 标题

段落 **粗体** *斜体* ~~删~~ \`code\` [链接](https://a.com)

> 引用

1. 一
2. 二
   - 嵌套

- [x] 完成

| a | b |
|---|---|
| 1 | 2 |

\`\`\`js
const x = 1 // 注释
function f(a) { return "s" }
\`\`\`

\`\`\`python
def g(x: int) -> str:
    # 注释
    return f"{x}"
\`\`\`

公式 $a^2+b^2=c^2$，角标 [2]
`

const html = render(SAMPLE)
const checks = [
  ['标题', /<h2>标题<\/h2>/],
  ['粗体', /<strong>粗体<\/strong>/],
  ['斜体', /<em>斜体<\/em>/],
  ['删除线', /<del>删<\/del>/],
  ['行内代码', /<code class="inline">code<\/code>/],
  ['链接', /<a href="https:\/\/a.com"/],
  ['引用', /<blockquote>/],
  ['有序列表', /<ol>/],
  ['嵌套列表', /<li>二<ul>/],
  ['任务列表', /<input type="checkbox" disabled checked>/],
  ['表格', /<table><thead>/],
  ['代码块', /class="code-block"/],
  ['高亮关键字', /tok-k/],
  ['公式', /class="math"/],
  ['角标', /class="cite"/],
]
let fail = 0
for (const [name, re] of checks) {
  const ok = re.test(html)
  if (!ok) fail++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
}

// 性能：一份 ~48KB 的文档渲染 30 次
const big = SAMPLE.repeat(20)
const t0 = performance.now()
for (let i = 0; i < 30; i++) render(big)
const per = (performance.now() - t0) / 30
console.log(`\n渲染性能：${big.length} 字符文档，平均 ${per.toFixed(2)}ms/次`)

// 流式场景：从 1% 到 100% 逐步渲染一次全文
const streamDoc = '# 长回答\n\n' + '这是一段用来测试流式渲染性能的中文文本，包含 **加粗** 与 `代码`。\n\n'.repeat(60)
let tStream = performance.now()
let frames = 0
for (let cut = 32; cut <= streamDoc.length; cut += Math.max(16, Math.floor(streamDoc.length / 120))) {
  render(streamDoc.slice(0, cut))
  frames++
}
console.log(`流式增量：${frames} 帧，总 ${(performance.now() - tStream).toFixed(1)}ms，平均 ${((performance.now() - tStream) / frames).toFixed(2)}ms/帧`)

console.log(fail ? `\n${fail} 项失败` : '\n全部通过')
process.exit(fail ? 1 : 0)
