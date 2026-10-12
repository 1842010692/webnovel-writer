import { afterEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createHash } from 'node:crypto'
import { contractTemplate, draftLengthFeedback, draftLengthTarget, readChapterLength, serializeDocument } from '@webnovel/core'
import { removeSync } from '../../core/src/repo/remove'
import { draftLengthCli } from '../src/scripts/draft-length-cli'

const roots: string[] = []
const relative = '草稿区/草稿/卷01-测试/稿1.md'
const range = '### 章节篇幅\n- 目标汉字数: 4\n- 下限汉字数: 3\n- 上限汉字数: 6'
afterEach(() => { vi.restoreAllMocks(); roots.splice(0).forEach(root => removeSync(root)) })

function fixture() {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'draft-length-cli-')); roots.push(ws)
  const book = path.join(ws, 'book')
  const file = path.join(book, relative)
  const contract = path.join(book, '作品契约/契约.md')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.mkdirSync(path.dirname(contract))
  fs.writeFileSync(contract, contractTemplate({ 阅读体验与情绪承诺: { state: '已确认', body: range } }))
  const text = serializeDocument({ 角色: '草稿', 版本: 2, 选定: true }, '# 夜渡\n\n甲𠮷A1。\n\n## 草稿候选事实\n- 事实：不计入正文。')
  fs.writeFileSync(file, text)
  return { ws, book, file, contract, text }
}

function invoke(args: string[]) {
  const output = vi.spyOn(console, 'log').mockImplementation(() => {})
  const code = draftLengthCli(args)
  expect(output).toHaveBeenCalledTimes(1)
  const data = JSON.parse(String(output.mock.calls[0]![0]))
  output.mockRestore()
  return { code, data }
}

function snapshot(directory: string): Record<string, string> {
  const result: Record<string, string> = {}
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const file = path.join(current, entry.name)
      if (entry.isDirectory()) walk(file)
      else result[path.relative(directory, file)] = createHash('sha256').update(fs.readFileSync(file)).digest('hex')
    }
  }
  walk(directory)
  return result
}

describe('主控当前完整稿字数核验', () => {
  it('不依赖待审稿或材料，只读指定稿并保持全部文件不变', () => {
    const { book, file, text } = fixture()
    fs.writeFileSync(path.join(path.dirname(file), '稿9.md'), serializeDocument({ 角色: '草稿', 版本: 9 }, '不应选这份稿'))
    const before = snapshot(book)
    const { code, data } = invoke(['--book', book, '--稿件', relative])
    expect(code).toBe(0)
    expect(data).toMatchObject({ 核验来源: '当前文件', 统计状态: '已统计', 稿件: relative,
      正文统计: { 汉字数: 4, 版本: 2, 保存文本哈希: createHash('sha256').update(text).digest('hex') },
      篇幅核对: { 结果: '范围内', 实测汉字数: 4 } })
    expect(data.正文统计.统计口径).toContain('不含 frontmatter 和草稿候选事实')
    expect(snapshot(book)).toEqual(before)
  })

  it('保存后外部修改时，独立核验取得当前文本而非子代理旧快照', () => {
    const { book, file, text } = fixture()
    const saved = draftLengthFeedback(draftLengthTarget(relative)!, text, readChapterLength(book))
    fs.writeFileSync(file, serializeDocument({ 角色: '草稿', 版本: 3 }, '甲乙丙丁戊己庚'))
    const { code, data } = invoke(['--book', book, '--稿件', relative])
    expect(code).toBe(0)
    expect(saved.统计状态 === '已统计' && saved.正文统计.汉字数).toBe(4)
    expect(data.正文统计).toMatchObject({ 汉字数: 7, 版本: 3 })
    expect(data.正文统计.保存文本哈希).not.toBe(saved.统计状态 === '已统计' && saved.正文统计.保存文本哈希)
    expect(data.篇幅核对).toMatchObject({ 结果: '偏长', 差额: 1 })
  })

  it.each(['未配置', '未确认', '配置错误'])('%s 保留真实契约状态，不编造目标', state => {
    const { book, contract } = fixture()
    const text = state === '未配置' ? '# 契约\n' : contractTemplate({ 阅读体验与情绪承诺: {
      state: state === '未确认' ? '暂定' : '已确认', body: state === '配置错误' ? range.replace('目标汉字数: 4', '目标汉字数: 错误') : range,
    } })
    fs.writeFileSync(contract, text)
    const { code, data } = invoke(['--book', book, '--稿件', relative])
    expect(code).toBe(0)
    expect(data.篇幅约定.状态).toBe(state)
    expect(data.篇幅核对.结果).not.toBe('范围内')
    expect(data.距目标剩余汉字数).toBeUndefined()
  })

  it('缺参、穿越、暂存、缺文件及坏文档均不提供伪统计', () => {
    const { book, file } = fixture()
    for (const args of [[], ['--book', book], ['--book', book, '--稿件'],
      ['--book', book, '--book', book, '--稿件', relative],
      ...['../稿1.md', file, relative.replace('.md', '.起草中.txt'), relative.replace('稿1', '稿99')].map(target => ['--book', book, '--稿件', target])]) {
      const { code, data } = invoke(args)
      expect(code).toBe(1)
      expect(data.统计状态).toBe('未核验')
      expect(data.正文统计).toBeUndefined()
    }
    fs.writeFileSync(file, '---\n版本: [\n---\n正文')
    const result = invoke(['--book', book, '--稿件', relative])
    expect(result.code).toBe(1)
    expect(result.data.统计状态).toBe('未核验')
  })

  it('链接到书仓外的稿件拒绝读取，隔离标记不阻止只读核验', () => {
    const { ws, book, file } = fixture()
    const outside = path.join(ws, 'outside')
    fs.mkdirSync(outside)
    fs.writeFileSync(path.join(outside, '稿1.md'), '仓外正文')
    const link = path.join(book, '草稿区/草稿/卷02-外部')
    fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir')
    const rejected = invoke(['--book', book, '--稿件', '草稿区/草稿/卷02-外部/稿1.md'])
    expect(rejected.code).toBe(1)
    expect(rejected.data.正文统计).toBeUndefined()
    const q = path.join(book, '.webnovel/quarantine/test')
    fs.mkdirSync(q, { recursive: true })
    fs.writeFileSync(path.join(q, 'quarantine.json'), '{')
    const before = fs.readFileSync(file, 'utf8')
    expect(invoke(['--book', book, '--稿件', relative]).code).toBe(0)
    expect(fs.readFileSync(file, 'utf8')).toBe(before)
    expect(fs.readFileSync(path.join(q, 'quarantine.json'), 'utf8')).toBe('{')
  })
})
