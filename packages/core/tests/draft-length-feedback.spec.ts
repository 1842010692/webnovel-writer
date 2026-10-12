import { afterEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createHash } from 'node:crypto'
import {
  contractTemplate, countProseText, draftLengthFeedback, draftLengthTarget, findPendingReviewDraft,
  listChapterDrafts, nextDraftFileName, parseChapterLength, parseDocument, scanChapter, serializeDocument,
} from '../src/index'
import { removeSync } from '../src/repo/remove'

const roots: string[] = []
afterEach(() => roots.splice(0).forEach(removeSync))
const relative = '草稿区/草稿/卷01-夜渡/稿1.md'
const stage = '草稿区/草稿/卷01-夜渡/稿1.起草中.txt'
const policy = parseChapterLength(contractTemplate({ 阅读体验与情绪承诺: {
  state: '已确认', body: '### 章节篇幅\n- 目标汉字数: 3\n- 下限汉字数: 2\n- 上限汉字数: 4',
} }))

describe('保存快照篇幅反馈', () => {
  it('仅识别规范稿和暂存路径，不把材料或任意文本当正文', () => {
    expect(draftLengthTarget(relative)?.文本阶段).toBe('草稿文件')
    expect(draftLengthTarget(stage.replace(/\//g, '\\'))?.文本阶段).toBe('起草暂存')
    for (const other of ['/绝对/' + relative, '../' + relative, relative.replace('稿1.md', '../稿1.md'),
      '草稿区/材料包/卷01-夜渡/稿1.md', relative.replace('稿1.md', '笔记.md'), stage.replace('.txt', '.md')]) {
      expect(draftLengthTarget(other), other).toBeUndefined()
    }
  })

  it('保留标题和扩展汉字，排除元数据/候选事实，哈希绑定完整保存文本', () => {
    const text = serializeDocument({ 版本: 2, 说明: '元数据' }, '# 章\r\n甲𠮷，A1😀。\n\n## 草稿候选事实\n- 事实：不可计数。')
    const feedback = draftLengthFeedback(draftLengthTarget(relative)!, text, policy)
    const doc = parseDocument(text)
    if (!doc.ok || feedback.统计状态 !== '已统计') throw new Error('fixture did not parse')
    expect(feedback.正文统计).toMatchObject({ ...countProseText(doc.data.body), 汉字数: 3, 版本: 2,
      保存文本哈希: createHash('sha256').update(text).digest('hex') })
    expect(feedback.篇幅核对).toMatchObject({ 结果: '范围内', 实测汉字数: 3, 差额: 0 })
  })

  it.each([[1, '偏短', 1], [2, '范围内', 0], [4, '范围内', 0], [5, '偏长', 1]] as const)('边界 %i', (count, result, delta) => {
    expect(draftLengthFeedback(draftLengthTarget(relative)!, '甲'.repeat(count), policy)).toMatchObject({
      篇幅核对: { 结果: result, 差额: delta }, 距目标剩余汉字数: 3 - count, 距上限剩余汉字数: 4 - count,
    })
  })

  it('阶段稿仅返回累计与剩余量，未配置/未确认/错误不编造有效范围', () => {
    const partial = draftLengthFeedback(draftLengthTarget(stage)!, '甲', policy)
    expect(partial).toMatchObject({ 正文统计: { 汉字数: 1 }, 距目标剩余汉字数: 2 })
    expect(partial).not.toHaveProperty('篇幅核对')
    const policies = [parseChapterLength(null), { ...policy, 状态: '未确认' as const },
      { 状态: '配置错误' as const, 来源: '契约', 原因: '非法范围' }]
    for (const input of policies) {
      const feedback = draftLengthFeedback(draftLengthTarget(relative)!, '甲乙', input)
      expect(feedback).toMatchObject({ 篇幅核对: { 结果: input.状态 } })
      expect(feedback).not.toHaveProperty('距目标剩余汉字数')
    }
    expect(draftLengthFeedback(draftLengthTarget(relative)!, undefined, policy)).toMatchObject({ 统计状态: '未核验' })
    expect(draftLengthFeedback(draftLengthTarget(relative)!, '---\n未闭合', policy)).not.toHaveProperty('正文统计')
  })

  it('只有暂存时不占正式稿号、不进入草稿/待审稿，发布正式文件后才改变推导', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'draft-length-'))
    roots.push(root)
    fs.mkdirSync(path.dirname(path.join(root, stage)), { recursive: true })
    fs.writeFileSync(path.join(root, stage), '半篇正文')
    const key = { 卷: 1, 章: 1, 章名: '夜渡' }
    expect(listChapterDrafts(root, key)).toEqual([])
    expect(nextDraftFileName(root, key)).toBe('稿1.md')
    expect(findPendingReviewDraft(root, key)).toBeNull()
    expect(scanChapter(root, key).有草稿).toBe(false)
    fs.writeFileSync(path.join(root, relative), serializeDocument({ 角色: '草稿', 版本: 1 }, '完整正文'))
    expect(scanChapter(root, key).有草稿).toBe(true)
    expect(nextDraftFileName(root, key)).toBe('稿2.md')
    expect(listChapterDrafts(root, key)).toHaveLength(1)
  })
})
