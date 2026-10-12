import { describe, expect, it } from 'vitest'
import {
  checkLedgerSectionFields, checkMemorySectionFields, parseFactSections, parseLedgerSections,
  parseMemorySections, parseTimelineSections, SettlementParseError,
} from '../src/settlement/index'

function errorOf(run: () => unknown): SettlementParseError {
  try {
    run()
  } catch (error) {
    expect(error).toBeInstanceOf(SettlementParseError)
    return error as SettlementParseError
  }
  throw new Error('expected a parse error')
}

describe('沉淀候选解析报错：段名、行号、合法值、修正方法', () => {
  it('账本分类未知：给出行号与四个合法分类', () => {
    const error = errorOf(() => parseLedgerSections('# 账本变更\n\n## 伏笔\n### 纸鹤\n- 状态：已埋\n'))
    expect(error.line).toBe(3)
    expect(error.message).toBe('账本变更第 3 行：分类未知「伏笔」；合法值：故事线、人物弧线、承诺、线索；修正方法：把这行 `## ` 后的分类改成合法值之一，一行只写一个')
  })

  it('记忆分类未知：给出四个合法分类', () => {
    const error = errorOf(() => parseMemorySections('# 本书层记忆候选\n## 风格\n### 短句\n正文\n'))
    expect(error.message).toMatch(/^本书层记忆候选第 2 行：分类未知「风格」；合法值：文风、决策、对话、灵感；修正方法：/)
  })

  it('未分类正文（占位文字）：指出所在行和示例片段', () => {
    const error = errorOf(() => parseLedgerSections('# 账本变更\n\n（无账本变更）\n'))
    expect(error.message).toMatch(/^账本变更第 3 行：存在未分类正文「（无账本变更）」/)
    expect(error.message).toContain('删掉占位文字')
  })

  it('条目缺少分类 / 模块：指向条目标题行', () => {
    expect(errorOf(() => parseLedgerSections('# 账本变更\n### 纸鹤\n')).message).toMatch(/^账本变更第 2 行：条目「纸鹤」缺少分类；合法值：故事线、/)
    expect(errorOf(() => parseFactSections('# 事实变更\n### 城门\n')).message).toMatch(/^事实变更第 2 行：条目「城门」缺少模块；修正方法：/)
    expect(errorOf(() => parseFactSections('# 事实变更\n## 地点/城市\n### 城门\n内容\n')).message).toMatch(/^事实变更第 2 行：模块名不合法「地点\/城市」/)
  })

  it('时间线事件缺少事件字段：指向事件标题行并给出示例', () => {
    const error = errorOf(() => parseTimelineSections('# 时间线变更\n\n## 入城\n- 时点：清晨\n'))
    expect(error.message).toBe('时间线变更第 3 行：事件「入城」缺少事件字段；修正方法：在该事件下加一行「- 事件：<一句话>」')
  })

  it('账本状态非法：按线索的合法状态列出，并指向条目标题行', () => {
    const [section] = parseLedgerSections('# 账本变更\n## 线索\n\n### 纸鹤\n- 状态：进行中\n- 计划来源：本章新增\n- 埋设点：第0001章\n- 预期兑现区间：第2-3章\n')
    const error = errorOf(() => checkLedgerSectionFields(section!))
    expect(error.message).toBe('账本变更第 4 行：条目「线索/纸鹤」状态非法「进行中」；合法值：已埋、已示、已收、已弃；修正方法：把「状态」改成合法值之一')
  })

  it('账本缺少状态字段：按承诺的合法状态列出', () => {
    const [section] = parseLedgerSections('# 账本变更\n## 承诺\n### 复仇\n- 计划来源：本章新增\n说明\n')
    expect(errorOf(() => checkLedgerSectionFields(section!)).message).toMatch(/^账本变更第 3 行：条目「承诺\/复仇」缺少状态字段；合法值：进行中、已兑现、已结束、已放弃；修正方法：/)
  })

  it('记忆候选状态非法：合法值只有「候选」', () => {
    const [section] = parseMemorySections('# 本书层记忆候选\n## 文风\n### 短句\n- 状态：已确认\n正文\n')
    expect(errorOf(() => checkMemorySectionFields(section!)).message).toBe('本书层记忆候选第 3 行：条目「文风/短句」候选状态非法「已确认」；合法值：候选；修正方法：把「状态」改成「候选」')
  })

  it('解析结果对象不带行号字段，不影响既有比较', () => {
    expect(parseLedgerSections('# 账本变更\n## 线索\n### 纸鹤\n- 状态：已埋\n')).toEqual([{ kind: '线索', title: '纸鹤', body: '- 状态：已埋' }])
  })
})

describe('PR-12 报错格式：<段名>[第 N 行]：<问题>[；合法值：…]；修正方法：<非空>', () => {
  const FORMAT = /^(账本变更|本书层记忆候选|时间线变更|事实变更)(第 \d+ 行)?：[^；]+(；合法值：[^；]+)?；修正方法：\S.*$/u
  const cases: Array<[string, () => unknown]> = [
    ['账本分类未知', () => parseLedgerSections('# 账本变更\n\n## 伏笔\n### 纸鹤\n- 状态：已埋\n')],
    ['账本占位文字', () => parseLedgerSections('# 账本变更\n\n（无账本变更）\n')],
    ['账本缺分类', () => parseLedgerSections('# 账本变更\n### 纸鹤\n')],
    ['记忆分类未知', () => parseMemorySections('# 本书层记忆候选\n## 风格\n### 短句\n正文\n')],
    ['事实缺模块', () => parseFactSections('# 事实变更\n### 城门\n')],
    ['事实模块非法', () => parseFactSections('# 事实变更\n## 地点/城市\n### 城门\n内容\n')],
    ['时间线占位', () => parseTimelineSections('# 时间线变更\n\n（无）\n')],
  ]
  for (const [name, run] of cases) {
    it(name, () => {
      const error = errorOf(run)
      expect(error.message).toMatch(FORMAT)
      expect(error.message).not.toMatch(/Error:|\(B\d/)
    })
  }

  it('源码中每处 parseFail 都给出非空修正方法', async () => {
    const { readFileSync } = await import('node:fs')
    const source = readFileSync(new URL('../src/settlement/index.ts', import.meta.url), 'utf8')
    const calls = source.split('\n').filter((line) => /\bparseFail\(/.test(line) && !/function parseFail/.test(line))
    expect(calls.length).toBeGreaterThan(20)
    for (const line of calls) expect(line, line).toMatch(/parseFail\([^,]+,[^,]+,\s*(`[^`]+`|'[^']+'),\s*(`[^`]+`|'[^']+')/)
  })
})
