// 句长与术语检查（不是 STE 合规评分）。
// 范围：docs/user（默认）、技能与代码内提示词（--skills）、工具输出字符串（--tools）。
// 门禁规则：每个文件不得比已提交的基线退步（句长达标率、要求强度词数、半角标点数），
// 术语表禁用词与工具输出中的 `Error:`、`(B数字` 直接失败；超长句、近义词混用、长段落只报告。
// 基线：scripts/release/style-baseline.json；例外：scripts/release/style-exceptions.json。
// The banned-synonym list is the glossary table in docs/maintenance/writing-style.md.
import fs from 'node:fs'
import ts from 'typescript'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { root as defaultRoot } from './version.mjs'

const STEP_LIMIT = 40
const NOTE_LIMIT = 50
const MIN_CHARS = 6
const WARN_CHARS = 80
const TABLE_SEPARATOR = /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/
/** 要求强度词：严禁、绝不、禁止、不得、一律、必须、须（不含「必须」里重复计数与「无须」）。 */
export const STRONG = /严禁|绝不|禁止|不得|一律|必须|(?<![必无])须/g
/** CJK 之间的半角标点，单独作为格式检查。 */
export const HALF_WIDTH = /(?<=[\u4e00-\u9fff])[,;:?!](?=[\u4e00-\u9fff])|(?<=[\u4e00-\u9fff])[,;:?!]$/g

const chars = text => [...text].length

/** 去掉行内标记。placeholder 为真时，代码、「」和“”中的内容各记为一个占位字，不删掉。 */
function stripInline(text, placeholder = false) {
  const hold = placeholder ? 'X' : ''
  return text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`[^`]*`/g, hold)
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/「[^」]*」/g, hold)
    .replace(/“[^”]*”/g, hold)
}

function maskAllowances(text, allowances) {
  let masked = text
  for (const phrase of allowances) masked = masked.split(phrase).join(' '.repeat(chars(phrase)))
  return masked
}

function sentencesOf(text, kind, line) {
  const found = []
  for (const part of text.split(/[。！？；\n]+/)) {
    const sentence = part.trim()
    if (chars(sentence) < MIN_CHARS) continue
    found.push({ text: sentence, kind, length: chars(sentence), line })
  }
  return found
}

export function loadGlossary(root = defaultRoot) {
  const text = fs.readFileSync(path.join(root, 'docs/maintenance/writing-style.md'), 'utf8').replace(/^\uFEFF/, '')
  const section = text.split(/^## 术语表\s*$/m)[1]
  if (!section) throw new Error('docs/maintenance/writing-style.md is missing a ## 术语表 section')
  const body = section.split(/^## /m)[0]
  const banned = []
  const allowances = []
  let headers = null
  for (const line of body.split(/\r?\n/)) {
    if (!line.trim().startsWith('|')) continue
    const cells = line.split('|').slice(1, -1).map(cell => cell.trim())
    if (cells.every(cell => /^:?-+:?$/.test(cell))) continue
    if (!headers) {
      headers = cells
      continue
    }
    const row = Object.fromEntries(headers.map((header, index) => [header, cells[index] ?? '']))
    const avoided = row['不要写'] ?? ''
    if (avoided && avoided !== '—' && avoided !== '-') {
      for (const term of avoided.split('、').map(item => item.trim()).filter(item => item && item !== '—' && item !== '-')) {
        banned.push({ term, preferred: row['术语'] })
      }
    }
    for (const match of (row['备注'] ?? '').matchAll(/「([^」]+)」/g)) allowances.push(match[1])
  }
  allowances.sort((left, right) => chars(right) - chars(left))
  const synonyms = []
  const synonymSection = text.split(/^## 近义词组\s*$/m)[1]
  if (synonymSection) {
    for (const line of synonymSection.split(/^## /m)[0].split(/\r?\n/)) {
      const cells = line.split('|').slice(1, -1).map(cell => cell.trim())
      if (cells.length < 2 || cells[0] === '概念' || cells.every(cell => /^:?-+:?$/.test(cell))) continue
      synonyms.push({ concept: cells[0], members: cells[1].split('、').map(item => item.trim()).filter(Boolean) })
    }
  }
  return { banned, allowances, synonyms }
}

export function analyzeMarkdown(text, glossary) {
  const lines = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
  const banned = glossary?.banned ?? []
  const allowances = glossary?.allowances ?? []
  const segments = []
  const termHits = []
  let fence = false
  let quote = null
  let previousKind = null
  let formatHits = 0
  let strong = 0

  const scanTerms = (visible, line) => {
    const masked = maskAllowances(visible, allowances)
    for (const item of banned) {
      if (masked.includes(item.term)) termHits.push({ line, term: item.term, preferred: item.preferred })
    }
  }

  const push = (raw, line, kind) => {
    const table = kind === 'explain' && /^\s*\|/.test(raw)
    const cells = text => (table ? text.replace(/^\s*\|/, '').replace(/\|\s*$/, '').replace(/\|/g, ' ') : text)
    scanTerms(cells(stripInline(raw)), line)
    const visible = cells(stripInline(raw, true))
    formatHits += [...visible.matchAll(HALF_WIDTH)].length
    strong += [...visible.matchAll(STRONG)].length
    segments.push({ kind, text: visible, line })
    previousKind = kind
  }

  for (let index = 0; index < lines.length; index++) {
    const lineNo = index + 1
    const raw = lines[index]
    if (/^```/.test(raw.trim())) {
      fence = !fence
      quote = null
      previousKind = null
      continue
    }
    if (fence) continue
    if (!raw.trim()) {
      quote = null
      previousKind = null
      segments.push({ kind: 'break' })
      continue
    }
    const quoted = /^> ?(.*)$/.exec(raw)
    if (quoted) {
      if (!quote) quote = /^\[![A-Za-z]+\]/.test(quoted[1].trim()) ? 'alert' : 'prompt'
      if (quote === 'prompt') continue
      push(quoted[1].replace(/^\[![A-Za-z]+\]\s*/, ''), lineNo, 'explain')
      continue
    }
    quote = null
    if (/^#{1,6}\s/.test(raw)) continue
    if (/^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(raw)) continue
    if (/^\s*\|/.test(raw) && TABLE_SEPARATOR.test(lines[index + 1] ?? '')) continue
    if (/^\d+\.\s+/.test(raw)) {
      push(raw.replace(/^\d+\.\s+/, ''), lineNo, 'step')
      continue
    }
    if (/^\s+\d+\.\s+/.test(raw) || /^\s+[-*]\s+/.test(raw)) {
      push(raw.trim().replace(/^\d+\.\s+/, '').replace(/^[-*]\s+/, ''), lineNo, 'explain')
      continue
    }
    if (/^\s+\S/.test(raw) && previousKind === 'step') {
      push(raw.trim(), lineNo, 'step')
      continue
    }
    push(raw, lineNo, 'explain')
  }

  const sentences = []
  let paragraphCount = 0
  let longParagraphs = 0
  const flush = () => {
    if (paragraphCount > 6) longParagraphs++
    paragraphCount = 0
  }
  for (const segment of segments) {
    if (segment.kind === 'break') {
      flush()
      continue
    }
    const found = sentencesOf(segment.text, segment.kind, segment.line)
    paragraphCount += found.length
    sentences.push(...found)
  }
  flush()

  const steps = sentences.filter(item => item.kind === 'step')
  const notes = sentences.filter(item => item.kind === 'explain')
  const stepWithinLimit = steps.filter(item => item.length <= STEP_LIMIT).length
  const explainWithinLimit = notes.filter(item => item.length <= NOTE_LIMIT).length
  let doubleNegatives = 0
  for (const item of sentences) doubleNegatives += [...item.text.matchAll(/不能不|不是不|并非不/g)].length
  return {
    sentences, steps, notes, termHits, longParagraphs, doubleNegatives, formatHits, strong,
    passive: sentences.filter(item => item.text.includes('被')).length,
    stepWithinLimit, explainWithinLimit,
    stepRatio: steps.length ? stepWithinLimit / steps.length : 1,
    explainRatio: notes.length ? explainWithinLimit / notes.length : 1,
  }
}

function readGuides(root) {
  return fs.readdirSync(path.join(root, 'docs/user')).filter(file => file.endsWith('.md')).sort()
}

export function report(root = defaultRoot) {
  const glossary = loadGlossary(root)
  const docs = readGuides(root).map(file => {
    const text = fs.readFileSync(path.join(root, 'docs/user', file), 'utf8')
    const analysis = analyzeMarkdown(text, glossary)
    return { file: `docs/user/${file}`, ...analysis, termHits: analysis.termHits.map(hit => ({ ...hit, file: `docs/user/${file}` })) }
  })
  const steps = docs.flatMap(doc => doc.steps)
  const notes = docs.flatMap(doc => doc.notes)
  const stepWithinLimit = docs.reduce((sum, doc) => sum + doc.stepWithinLimit, 0)
  const explainWithinLimit = docs.reduce((sum, doc) => sum + doc.explainWithinLimit, 0)
  return {
    docs, glossary,
    stepRatio: steps.length ? stepWithinLimit / steps.length : 1,
    explainRatio: notes.length ? explainWithinLimit / notes.length : 1,
    stepWithinLimit, explainWithinLimit, steps, notes,
    termHits: docs.flatMap(doc => doc.termHits),
  }
}

export function checkFailures(result) {
  const failures = []
  if (result.termHits.length) {
    const lines = result.termHits.map(hit => `${hit.file}:${hit.line} ${hit.term} → ${hit.preferred}`)
    failures.push(`术语命中 ${result.termHits.length} 处：\n${lines.join('\n')}`)
  }
  return failures
}

export function formatReport(result) {
  const percent = (ratio, within, total) => `${(ratio * 100).toFixed(0)}%（${within}/${total}）`
  const lines = []
  for (const doc of result.docs) {
    lines.push(doc.file)
    lines.push(`  句数 ${doc.sentences.length}（步骤 ${doc.steps.length}，说明 ${doc.notes.length}）`)
    lines.push(`  步骤句 ≤${STEP_LIMIT} 字 ${percent(doc.stepRatio, doc.stepWithinLimit, doc.steps.length)}`)
    lines.push(`  说明句 ≤${NOTE_LIMIT} 字 ${percent(doc.explainRatio, doc.explainWithinLimit, doc.notes.length)}`)
    lines.push(`  术语命中 ${doc.termHits.length}`)
    for (const hit of doc.termHits) lines.push(`    ${hit.line}: ${hit.term} → ${hit.preferred}`)
    lines.push(`  「被」字句 ${doc.passive}`)
    lines.push(`  双重否定 ${doc.doubleNegatives}`)
    lines.push(`  超过 6 句的段落 ${doc.longParagraphs}`)
  }
  lines.push('合计')
  lines.push(`  步骤句 ≤${STEP_LIMIT} 字 ${percent(result.stepRatio, result.stepWithinLimit, result.steps.length)}`)
  lines.push(`  说明句 ≤${NOTE_LIMIT} 字 ${percent(result.explainRatio, result.explainWithinLimit, result.notes.length)}`)
  lines.push(`  术语命中 ${result.termHits.length}`)
  return lines.join('\n')
}

// ---- 逐文件检查：docs、技能与代码提示词、工具输出 ----

const CODE_PROMPT_FILES = ['packages/bundle/src/persona.ts', 'packages/bundle/src/status-context.ts', 'packages/bundle/src/study/editor-requests.ts']
/**
 * 工具输出字面量的语境：对象属性值、return、throw、toolFailure/parseFail 参数、
 * 字符串拼接与三元分支、push/notify/warn 调用参数。比较（=== '…'）和对象键不算。
 */
const FORBIDDEN_OUTPUT = [/Error:/, /\(B\d/, /（B\d/]
export const BASELINE_FILE = 'scripts/release/style-baseline.json'
export const EXCEPTIONS_FILE = 'scripts/release/style-exceptions.json'

function walk(dir, filter, out = []) {
  if (!fs.existsSync(dir)) return out
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules' && entry.name !== 'dist' && entry.name !== 'client') walk(full, filter, out)
    } else if (filter(full)) out.push(full)
  }
  return out
}

/** 逐个取出 TS 源码里的字符串与模板字面量（跳过注释），并记录字面量前面的代码。 */
export function stringLiterals(source) {
  const file = ts.createSourceFile('messages.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const found = []
  const outputContext = node => {
    const parent = node.parent
    if (!parent) return false
    if ((ts.isPropertyAssignment(parent) || ts.isMethodDeclaration(parent) || ts.isPropertyDeclaration(parent)) && parent.name === node) return false
    if (ts.isLiteralTypeNode(parent) || ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)
      || ts.isExternalModuleReference(parent) || ts.isElementAccessExpression(parent) || ts.isCaseClause(parent)) return false
    if (ts.isBinaryExpression(parent) && [ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.EqualsEqualsEqualsToken,
      ts.SyntaxKind.ExclamationEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken].includes(parent.operatorToken.kind)) return false
    // Runtime constants are included conservatively: returned messages commonly
    // flow through variables or helper functions before reaching a tool result.
    return true
  }
  const visit = node => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) {
      const start = node.getStart(file)
      const text = ts.isTemplateExpression(node)
        ? node.head.text + node.templateSpans.map(span => 'X' + span.literal.text).join('')
        : node.text
      found.push({ text, line: file.getLineAndCharacterOfPosition(start).line + 1,
        before: source.slice(Math.max(0, start - 80), start), output: outputContext(node) })
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return found
}

const hasCjk = text => /[\u4e00-\u9fff]/.test(text)
const relOf = (root, full) => path.relative(root, full).split(path.sep).join('/')

/** 近义词组：同一文件混用同组两个以上写法时报告。 */
function synonymMixes(text, glossary) {
  const mixes = []
  for (const group of glossary?.synonyms ?? []) {
    const used = group.members.filter(member => text.includes(member))
    if (used.length > 1) mixes.push({ concept: group.concept, used })
  }
  return mixes
}

function fileResult(file, sentences, extra) {
  const limitOf = item => (item.kind === 'step' ? STEP_LIMIT : NOTE_LIMIT)
  const within = sentences.filter(item => item.length <= limitOf(item)).length
  return {
    file, sentences, within,
    ratio: sentences.length ? within / sentences.length : 1,
    longSentences: sentences.filter(item => item.length > WARN_CHARS).map(item => ({ line: item.line, length: item.length })),
    termHits: [], forbidden: [], formatHits: 0, strong: 0, longParagraphs: 0, synonymMixes: [],
    ...extra,
  }
}

function markdownFile(root, full, glossary) {
  const text = fs.readFileSync(full, 'utf8').replace(/^\uFEFF/, '').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, block => block.replace(/[^\n]/g, ''))
  const a = analyzeMarkdown(text, glossary)
  const file = relOf(root, full)
  return fileResult(file, a.sentences, {
    termHits: a.termHits.map(hit => ({ ...hit, file })), formatHits: a.formatHits, strong: a.strong,
    longParagraphs: a.longParagraphs, synonymMixes: synonymMixes(text.replace(/```[\s\S]*?```/g, ''), glossary),
  })
}

/** docs/user 逐文件结果。 */
export function reportDocs(root = defaultRoot) {
  const glossary = loadGlossary(root)
  return { files: readGuides(root).map(file => markdownFile(root, path.join(root, 'docs/user', file), glossary)), glossary }
}

/** 技能 Markdown 与代码内提示词。 */
export function reportSkills(root = defaultRoot) {
  const glossary = loadGlossary(root)
  const files = walk(path.join(root, 'packages/bundle/skills'), file => file.endsWith('.md')).map(full => markdownFile(root, full, glossary))
  for (const rel of CODE_PROMPT_FILES) {
    const full = path.join(root, rel)
    if (!fs.existsSync(full)) continue
    const sentences = []
    const termHits = []
    let formatHits = 0
    let strong = 0
    const visible = []
    for (const literal of stringLiterals(fs.readFileSync(full, 'utf8'))) {
      if (!hasCjk(literal.text) || /BLACKLIST[^\n]*$/.test(literal.before)) continue
      const a = analyzeMarkdown(literal.text, glossary)
      sentences.push(...a.sentences.map(item => ({ ...item, line: literal.line + item.line - 1 })))
      termHits.push(...a.termHits.map(hit => ({ ...hit, line: literal.line + hit.line - 1, file: `${rel}#prompt` })))
      formatHits += a.formatHits
      strong += a.strong
      visible.push(literal.text)
    }
    files.push(fileResult(`${rel}#prompt`, sentences, { termHits, formatHits, strong, synonymMixes: synonymMixes(visible.join('\n'), glossary) }))
  }
  return { files, glossary }
}

/** 工具输出：返回对象、报错、拼接中的全部中文字符串。 */
export function reportToolOutputs(root = defaultRoot) {
  const glossary = loadGlossary(root)
  const files = []
  for (const base of ['packages/core/src', 'packages/bundle/src']) {
    for (const full of walk(path.join(root, base), file => file.endsWith('.ts') && !file.endsWith('.d.ts'))) {
      const file = relOf(root, full)
      const sentences = []
      const termHits = []
      const forbidden = []
      const visible = []
      let formatHits = 0
      let strong = 0
      for (const literal of stringLiterals(fs.readFileSync(full, 'utf8'))) {
        if (!literal.output) continue
        const forbiddenLiteral = FORBIDDEN_OUTPUT.some(pattern => pattern.test(literal.text))
        if (!hasCjk(literal.text) && !forbiddenLiteral) continue
        if (/BLACKLIST[^\n]*$/.test(literal.before)) continue
        for (const part of literal.text.split(/[。！？；\n]+/)) {
          const text = part.trim()
          if (chars(text) >= MIN_CHARS) sentences.push({ text, kind: 'explain', length: chars(text), line: literal.line })
        }
        const masked = maskAllowances(literal.text, glossary?.allowances ?? [])
        for (const item of glossary?.banned ?? []) if (masked.includes(item.term)) termHits.push({ line: literal.line, term: item.term, preferred: item.preferred, file })
        for (const pattern of FORBIDDEN_OUTPUT) if (pattern.test(literal.text)) forbidden.push({ line: literal.line, pattern: String(pattern) })
        formatHits += [...literal.text.matchAll(HALF_WIDTH)].length
        strong += [...literal.text.matchAll(STRONG)].length
        visible.push(literal.text)
      }
      if (sentences.length || forbidden.length || termHits.length || strong || formatHits) files.push(fileResult(file, sentences, { termHits, forbidden, formatHits, strong, synonymMixes: synonymMixes(visible.join('\n'), glossary) }))
    }
  }
  return { files, glossary }
}

export function loadBaseline(root = defaultRoot) {
  const full = path.join(root, BASELINE_FILE)
  const baseline = fs.existsSync(full) ? JSON.parse(fs.readFileSync(full, 'utf8')) : {}
  if (!baseline || typeof baseline !== 'object' || Array.isArray(baseline)) throw new Error('基线必须是文件名到指标的对象')
  for (const [file, entry] of Object.entries(baseline)) {
    if (!entry || !Number.isFinite(entry.ratio) || entry.ratio < 0 || entry.ratio > 1
      || !Number.isInteger(entry.strong) || entry.strong < 0 || !Number.isInteger(entry.format) || entry.format < 0) {
      throw new Error(`基线字段非法：${file}`)
    }
  }
  return baseline
}

/** 例外：[{ file, check: 'ratio'|'strength'|'format', from, allow, reason }]。reason 必须写明，allow 是允许的退步量。 */
export function loadExceptions(root = defaultRoot) {
  const full = path.join(root, EXCEPTIONS_FILE)
  const list = fs.existsSync(full) ? JSON.parse(fs.readFileSync(full, 'utf8')) : []
  if (!Array.isArray(list)) throw new Error('例外必须是数组')
  const seen = new Set()
  for (const item of list) {
    if (!item || typeof item.file !== 'string' || !item.file || !['ratio', 'strength', 'format'].includes(item.check) || !Number.isFinite(item.allow) || item.allow < 0 || !Number.isFinite(item.from) || item.from < 0 || typeof item.reason !== 'string' || !item.reason.trim()) {
      throw new Error(`${EXCEPTIONS_FILE} 有无效条目：${JSON.stringify(item)}。每条都要有 file、check（ratio/strength/format）、from（原基线）、allow（非负数字）和 reason`)
    }
    if ((item.check === 'ratio' && (item.from > 1 || item.allow > 1))
      || (item.check !== 'ratio' && (!Number.isInteger(item.from) || !Number.isInteger(item.allow)))) throw new Error('例外指标范围非法')
    const key = `${item.file}#${item.check}`
    if (seen.has(key)) throw new Error(`例外重复：${key}`)
    seen.add(key)
  }
  return list
}

const round = value => Math.round(value * 1000) / 1000

function allowed(exceptions, file, check, base) {
  const item = exceptions.find(item => item.file === file && item.check === check)
  if (!item) return 0
  if (!Number.isFinite(item.from) || !Number.isFinite(item.allow)) throw new Error('例外缺少固定原基线或有效额度')
  return Math.max(0, check === 'format' ? item.from + item.allow - base : base - (item.from - item.allow))
}

/** 与基线比较。返回 { failures, warnings }。 */
export function compareToBaseline(result, baseline, exceptions = []) {
  const failures = []
  const warnings = []
  for (const file of result.files) {
    for (const hit of file.termHits) failures.push(`${file.file}:${hit.line} 术语：${hit.term} → ${hit.preferred}`)
    for (const item of file.forbidden) failures.push(`${file.file}:${item.line} 工具输出不要出现 ${item.pattern}`)
    const base = baseline[file.file]
    if (base === undefined) {
      failures.push(`${file.file}：没有基线。确认内容后运行 --update-baseline 登记`)
    } else {
      const ratioDrop = round(base.ratio - round(file.ratio))
      if (ratioDrop > allowed(exceptions, file.file, 'ratio', base.ratio) + 1e-9) failures.push(`${file.file}：句长达标率 ${(file.ratio * 100).toFixed(1)}%，低于基线 ${(base.ratio * 100).toFixed(1)}%`)
      const strongDrop = base.strong - file.strong
      if (strongDrop > allowed(exceptions, file.file, 'strength', base.strong)) failures.push(`${file.file}：要求强度词（严禁/绝不/禁止/不得/一律/必须/须）从 ${base.strong} 处减少到 ${file.strong} 处。恢复原有强度；确需放宽时，在 ${EXCEPTIONS_FILE} 登记 strength 例外并写明理由`)
      const formatRise = file.formatHits - base.format
      if (formatRise > allowed(exceptions, file.file, 'format', base.format)) failures.push(`${file.file}：格式检查：CJK 之间的半角标点从 ${base.format} 处增加到 ${file.formatHits} 处`)
    }
    for (const item of file.longSentences) warnings.push(`${file.file}:${item.line} 句子 ${item.length} 字，超过 ${WARN_CHARS} 字`)
    for (const mix of file.synonymMixes) warnings.push(`${file.file}：近义词混用（${mix.concept}）：${mix.used.join('、')}`)
    if (file.longParagraphs) warnings.push(`${file.file}：超过 6 句的段落 ${file.longParagraphs} 个（只报告）`)
  }
  return { failures, warnings }
}

/** 生成新基线。要求强度和达标率只升不降，除非已登记例外。 */
export function nextBaseline(result, baseline, exceptions = []) {
  const { failures } = compareToBaseline(result, baseline, exceptions)
  const blocking = failures.filter(item => !item.includes('没有基线'))
  if (blocking.length) return { ok: false, failures: blocking }
  const next = { ...baseline }
  for (const file of result.files) next[file.file] = { ratio: round(file.ratio), strong: file.strong, format: file.formatHits }
  return { ok: true, baseline: Object.fromEntries(Object.entries(next).sort(([a], [b]) => a.localeCompare(b))) }
}

export function formatFileReport(result) {
  const lines = ['句长与术语检查（不是 STE 合规评分）']
  for (const file of result.files) {
    lines.push(`${(file.ratio * 100).toFixed(0).padStart(4)}%  ${String(file.within).padStart(4)}/${String(file.sentences.length).padEnd(4)}  强度词 ${String(file.strong).padStart(3)}  半角 ${file.formatHits}  术语 ${file.termHits.length}  ${file.file}`)
  }
  const total = result.files.reduce((sum, file) => sum + file.sentences.length, 0)
  const within = result.files.reduce((sum, file) => sum + file.within, 0)
  lines.push(`合计 ${total ? ((within / total) * 100).toFixed(1) : '100.0'}%（${within}/${total}），文件 ${result.files.length}`)
  return lines.join('\n')
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const rootFlag = process.argv.indexOf('--root')
  const target = rootFlag > 0 ? path.resolve(process.argv[rootFlag + 1]) : defaultRoot
  const scopes = process.argv.includes('--all')
    ? [reportDocs, reportSkills, reportToolOutputs]
    : [process.argv.includes('--skills') ? reportSkills : process.argv.includes('--tools') ? reportToolOutputs : reportDocs]
  const result = { files: scopes.flatMap(scope => scope(target).files) }
  console.log(formatFileReport(result))
  const baseline = loadBaseline(target)
  const exceptions = loadExceptions(target)
  if (process.argv.includes('--update-baseline')) {
    const next = nextBaseline(result, baseline, exceptions)
    if (!next.ok) {
      console.error(['基线没有更新：', ...next.failures].join('\n'))
      process.exitCode = 1
    } else {
      fs.writeFileSync(path.join(target, BASELINE_FILE), JSON.stringify(next.baseline, null, 2) + '\n')
      console.log(`已更新 ${BASELINE_FILE}`)
    }
  } else if (process.argv.includes('--check')) {
    const { failures, warnings } = compareToBaseline(result, baseline, exceptions)
    if (warnings.length) console.log(['提示（不影响结果）：', ...warnings].join('\n'))
    if (failures.length) {
      console.error(failures.join('\n'))
      process.exitCode = 1
    }
  }
}
