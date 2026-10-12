import { test } from 'node:test'
import assert from 'node:assert/strict'
import { analyzeMarkdown, checkFailures, loadGlossary, report } from '../style-check.mjs'
import { root } from '../version.mjs'

const glossary = {
  banned: [
    { term: '主对话', preferred: '主会话' },
    { term: '宿主', preferred: 'DSH' },
    { term: '排错', preferred: '故障排查' },
  ],
  allowances: ['宿主版本'],
}

test('sentence splitter drops fragments shorter than 6 characters', () => {
  const result = analyzeMarkdown('请先打开书房。好。然后核对文件名是否正确！', glossary)
  assert.deepEqual(result.sentences.map(item => item.text), ['请先打开书房', '然后核对文件名是否正确'])
})

test('top-level ordered items are steps and other prose is explanation', () => {
  const text = [
    '先阅读这份说明。这一段告诉你范围。',
    '',
    '1. 打开插件页面。成功时，列表显示写作工作台。',
    '   1. 嵌套动作不单独升级为步骤句。',
    '2. 粘贴安装标识。',
    '',
    '| 名称 | 作用 |',
    '| --- | --- |',
    '| 书仓 | 保存一本书的目录 |',
  ].join('\n')
  const result = analyzeMarkdown(text, glossary)
  const steps = result.sentences.filter(item => item.kind === 'step').map(item => item.text)
  const notes = result.sentences.filter(item => item.kind === 'explain').map(item => item.text)
  assert.deepEqual(steps, ['打开插件页面', '成功时，列表显示写作工作台', '粘贴安装标识'])
  assert.ok(notes.some(item => item.includes('先阅读这份说明')))
  assert.ok(notes.some(item => item.includes('嵌套动作不单独升级为步骤句')))
  assert.ok(notes.some(item => item.includes('保存一本书的目录')))
  assert.equal(result.stepWithinLimit, steps.length)
  assert.ok(result.explainRatio >= 0.8)
})

test('banned terms ignore code, prompts, quoted interface text and allowed phrases', () => {
  const text = [
    '回到主对话继续。',
    '',
    '```',
    '主对话',
    '```',
    '',
    '运行 `主对话` 命令。',
    '',
    '> 请在主对话里继续写。',
    '',
    '> [!NOTE]',
    '> 不要回到主对话。',
    '',
    '界面写着「主对话」。',
    '',
    '先核对宿主版本，再启动宿主。',
    '',
    '见 [排错](troubleshooting.md)。',
  ].join('\n')
  const result = analyzeMarkdown(text, glossary)
  const hits = result.termHits.map(item => `${item.line}:${item.term}`).sort()
  assert.deepEqual(hits, ['1:主对话', '12:主对话', '16:宿主', '18:排错'].sort())
})

test('report counts passive voice, double negatives and long paragraphs', () => {
  const text = [
    '文件被写入磁盘。',
    '你不能不备份。',
    '这不是不重要。',
    '这并非不需要确认。',
    '',
    '第一句说明范围。第二句说明对象。第三句说明限制。第四句说明结果。第五句说明例外。第六句说明下一步。第七句说明风险。',
  ].join('\n')
  const result = analyzeMarkdown(text, glossary)
  assert.equal(result.passive, 1)
  assert.equal(result.doubleNegatives, 3)
  assert.equal(result.longParagraphs, 1)
})

test('glossary table is the only source of banned synonyms', () => {
  const glossaryFile = loadGlossary(root)
  assert.ok(glossaryFile.banned.some(item => item.term === '主对话' && item.preferred === '主会话'))
  assert.ok(glossaryFile.allowances.includes('宿主版本'))
})

test('user guides have no banned terms', () => {
  assert.deepEqual(checkFailures(report(root)), [])
})

// ---- 逐文件检查：基线、要求强度、格式、占位、表头、工具输出 ----
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  compareToBaseline, loadBaseline, loadExceptions, nextBaseline, reportDocs, reportSkills, reportToolOutputs, stringLiterals,
} from '../style-check.mjs'

function fixtureRoot(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'style-scope-'))
  const put = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
    fs.writeFileSync(path.join(dir, rel), text)
  }
  put('docs/maintenance/writing-style.md', fs.readFileSync(path.join(root, 'docs/maintenance/writing-style.md'), 'utf8'))
  fs.mkdirSync(path.join(dir, 'docs/user'), { recursive: true })
  for (const [rel, text] of Object.entries(files)) put(rel, text)
  return dir
}
const SKILL = 'packages/bundle/skills/a/SKILL.md'
const skillFile = (text) => reportSkills(fixtureRoot({ [SKILL]: text })).files.find(file => file.file === SKILL)
const baselineOf = (file) => ({ [file.file]: { ratio: file.ratio, strong: file.strong, format: file.formatHits } })
const longSentence = '这是一句故意写得非常非常长的说明句子'.repeat(7)

test('stringLiterals skips comments and records the preceding code', () => {
  const found = stringLiterals("// '注释里的字符串'\nconst a = { reason: `第 ${n} 行：失败` }\nthrow new Error('坏了')\n")
  assert.deepEqual(found.map(item => [item.text, item.line]), [['第 X 行：失败', 2], ['坏了', 3]])
  assert.match(found[0].before, /reason: $/)
})

test('code spans and quotes count as one placeholder character, not zero', () => {
  const file = skillFile('# A\n\n调用 `novel_settle_chapter_with_a_very_long_name` 前先核对「待定稿包的七件全文」。\n')
  assert.equal(file.sentences[0].text, '调用 X 前先核对X')
})

test('table header rows are skipped; body rows are counted', () => {
  const file = skillFile('# A\n\n| 工件 | 路径 | 属性 |\n|---|---|---|\n| 定稿章 | 定稿目录 | 真源，只增不改 |\n')
  assert.deepEqual(file.sentences.map(item => item.text), ['定稿章   定稿目录   真源，只增不改'])
})

test('a file must not regress against its baseline; new files need a baseline entry', () => {
  const good = skillFile('# A\n\n1. 打开书房。\n2. 核对文件名。\n')
  assert.deepEqual(compareToBaseline({ files: [good] }, baselineOf(good)).failures, [])
  assert.match(compareToBaseline({ files: [good] }, {}).failures[0], /没有基线/)
  const worse = skillFile(`# A\n\n1. 打开书房。\n2. ${longSentence}。\n`)
  assert.match(compareToBaseline({ files: [worse] }, baselineOf(good)).failures[0], /句长达标率 \d+\.\d%，低于基线 100\.0%/)
})

test('sentences over 80 characters only warn', () => {
  const file = skillFile(`# A\n\n${longSentence}。\n`)
  const { failures, warnings } = compareToBaseline({ files: [file] }, baselineOf(file))
  assert.deepEqual(failures, [])
  assert.match(warnings[0], /句子 126 字，超过 80 字/)
})

test('requirement strength: dropping 严禁/必须 fails unless an exception with a reason exists', () => {
  const before = skillFile('# A\n\n严禁手工编辑账本。必须先呈报。\n')
  const after = skillFile('# A\n\n不要手工编辑账本。先呈报。\n')
  assert.equal(before.strong, 2)
  assert.equal(after.strong, 0)
  const base = baselineOf(before)
  assert.match(compareToBaseline({ files: [after] }, base).failures[0], /要求强度词.*从 2 处减少到 0 处/)
  const exceptions = [{ file: SKILL, check: 'strength', from: 2, allow: 2, reason: '作者确认放宽' }]
  assert.deepEqual(compareToBaseline({ files: [after] }, base, exceptions).failures, [])
  assert.equal(nextBaseline({ files: [after] }, base).ok, false)
  assert.equal(nextBaseline({ files: [after] }, base, exceptions).ok, true)
})

test('exceptions without a reason are rejected', () => {
  const dir = fixtureRoot({ 'scripts/release/style-exceptions.json': JSON.stringify([{ file: SKILL, check: 'strength', allow: 1, reason: ' ' }]) })
  assert.throws(() => loadExceptions(dir), /无效条目/)
})

test('an exception has a fixed floor after baseline updates', () => {
  const file = skillFile('严禁修改账本。必须先呈报。')
  const base = baselineOf(file)
  const exceptions = [{ file: SKILL, check: 'strength', from: 2, allow: 1, reason: 'one authorized removal' }]
  const once = { ...file, strong: 1 }
  const next = nextBaseline({ files: [once] }, base, exceptions)
  assert.equal(next.ok, true)
  assert.ok(compareToBaseline({ files: [{ ...file, strong: 0 }] }, next.baseline, exceptions).failures.some(item => item.includes('要求强度词')))
})

test('baseline and exception schemas reject incomplete, duplicate and non-finite values', () => {
  const dir = fixtureRoot({ 'scripts/release/style-baseline.json': JSON.stringify({ x: {} }) })
  assert.throws(() => loadBaseline(dir), /基线字段非法/)
  for (const entries of [
    [{ file: SKILL, check: 'strength', from: 2, allow: -1, reason: 'x' }],
    [{ file: SKILL, check: 'strength', from: 2, allow: 1, reason: {} }],
    [{ file: SKILL, check: 'strength', from: 2, allow: 1, reason: 'x' }, { file: SKILL, check: 'strength', from: 2, allow: 1, reason: 'x' }],
  ]) {
    fs.writeFileSync(path.join(dir, 'scripts/release/style-exceptions.json'), JSON.stringify(entries))
    assert.throws(() => loadExceptions(dir))
  }
  fs.writeFileSync(path.join(dir, 'scripts/release/style-exceptions.json'), '[{"file":"x","check":"ratio","from":1,"allow":1e999,"reason":"x"}]')
  assert.throws(() => loadExceptions(dir))
})

test('short terms, English error prefixes and constants cannot evade output scanning', () => {
  const dir = fixtureRoot({ 'packages/core/src/short.ts': [
    "const re = /['\\\"]/g;",
    "const reason = '宿主';",
    "export function f() { return { reason }; }",
    "export function g() { return 'Error: bad'; }",
  ].join('\n') })
  const result = reportToolOutputs(dir)
  assert.ok(result.files[0].termHits.some(hit => hit.term === '宿主'))
  assert.ok(result.files[0].forbidden.length)
  const onlyShort = fixtureRoot({ 'packages/core/src/short.ts': "export function f(){ return '宿主' }" })
  assert.equal(reportToolOutputs(onlyShort).files[0].termHits[0].term, '宿主')
})

test('half-width punctuation between CJK is a separate formatting check', () => {
  const clean = skillFile('# A\n\n先打开书房，再核对文件。\n')
  const dirty = skillFile('# A\n\n先打开书房,再核对文件:然后保存。\n')
  assert.equal(dirty.formatHits, 2)
  const failures = compareToBaseline({ files: [dirty] }, baselineOf(clean)).failures
  assert.equal(failures.length, 1)
  assert.match(failures[0], /格式检查：CJK 之间的半角标点从 0 处增加到 2 处/)
})

test('paragraph length is report-only', () => {
  const file = skillFile('# A\n\n第一句说明范围。第二句说明对象。第三句说明限制。第四句说明结果。第五句说明例外。第六句说明下一步。第七句说明风险。\n')
  const { failures, warnings } = compareToBaseline({ files: [file] }, baselineOf(file))
  assert.deepEqual(failures, [])
  assert.ok(warnings.some(item => /超过 6 句的段落 1 个（只报告）/.test(item)))
})

test('banned terms report the real line number; the blacklist definition is skipped', () => {
  const dir = fixtureRoot({
    [SKILL]: '---\nname: a\n---\n# A\n\n先派子 Agent 起草。\n',
    'packages/bundle/src/persona.ts': "export const personaText = `你是主编。先读状态。`\nexport const PERSONA_BLACKLIST = ['子 Agent', '主 Agent'] as const\n",
  })
  const result = reportSkills(dir)
  assert.deepEqual(result.files.find(file => file.file === SKILL).termHits.map(hit => `${hit.line}:${hit.term}`), ['6:子 Agent'])
  assert.equal(result.files.find(file => file.file.endsWith('#prompt')).termHits.length, 0)
})

test('near-synonym groups: mixing two members in one file warns', () => {
  const file = skillFile('# A\n\n呈报前等作者批准。作者认可后再入档。\n')
  const { warnings } = compareToBaseline({ files: [file] }, baselineOf(file))
  assert.ok(warnings.some(item => /近义词混用（作者批准）：作者批准、作者认可/.test(item)), warnings.join('\n'))
})

test('--tools scans every Chinese string in returned objects, concatenations and errors', () => {
  const dir = fixtureRoot({
    'packages/core/src/x.ts': [
      "export function f(ok: boolean) {",
      "  if (ok) return { ok: true, 摘要: '已经写入三个文件并提交' }",
      "  if (!ok) return { message: '请先核对作者批准' + '，然后再次调用本工具' }",
      "  if (name === '这是比较不是输出内容') return null",
      "  return { ok: false, hint: ok ? '书仓锁已被占用' : '写入失败：Error: x' }",
      "}",
      "export function g() { throw new Error('锁文件损坏（B1）') }",
    ].join('\n'),
  })
  const file = reportToolOutputs(dir).files.find(item => item.file === 'packages/core/src/x.ts')
  const texts = file.sentences.map(item => item.text)
  assert.ok(texts.includes('已经写入三个文件并提交'))
  assert.ok(texts.includes('请先核对作者批准'))
  assert.ok(texts.includes('书仓锁已被占用'))
  assert.ok(!texts.includes('这是比较不是输出内容'))
  const failures = compareToBaseline({ files: [file] }, baselineOf(file)).failures
  assert.ok(failures.some(item => /x\.ts:5 工具输出不要出现 \/Error:\//.test(item)), failures.join('\n'))
  assert.ok(failures.some(item => /x\.ts:7 工具输出不要出现/.test(item)), failures.join('\n'))
})

test('the repository passes --all --check against the committed baseline', () => {
  const result = { files: [reportDocs(root), reportSkills(root), reportToolOutputs(root)].flatMap(scope => scope.files) }
  assert.deepEqual(compareToBaseline(result, loadBaseline(root), loadExceptions(root)).failures, [])
})
