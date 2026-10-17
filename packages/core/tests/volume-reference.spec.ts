import { describe, expect, it } from 'vitest'
import { findVolumeReferences } from '../src/assembly/volume-reference'

const name = '第二章 契约'
describe('卷纲候选按结构定位，仅提供原文范围', () => {
  it('宏观段落没有独立章名时不猜关联', () => {
    const report = findVolumeReferences('# 卷纲\n## 叙事结构 〔已确认〕\n- 第一章：起势包括收留、签约与经营。\n', 1, name)
    expect(report).toEqual({ 自动定位: '未命中', 候选: [], 已登记: [] })
    expect(findVolumeReferences(null, 1, name).自动定位).toBe('卷纲缺失')
  })

  it.each(['- **第二章 契约**：签约。', '### 第二章 契约'])('列表/三级标题 %s 保留本条原文，不混入相邻章', heading => {
    const next = heading.startsWith('###') ? '### 第三章 经营' : '- **第三章 经营**'
    const text = ['# 卷纲', '## 叙事结构 〔已确认〕', heading, '  - 当面核对条款。', '', next, '相邻章独有情节。', '## 方向选择', '第二章 契约的未选方向。', ''].join('\r\n')
    const report = findVolumeReferences(text, 1, name)
    expect(report.自动定位).toBe('有候选')
    expect(report.候选).toHaveLength(1)
    const candidate = report.候选[0]!
    expect(candidate.来源).toEqual({ 域: '本书', 路径: '大纲/卷规划/卷01/卷纲.md', 起行: 3, 终行: 4 })
    expect(candidate.原文).toBe(`${heading}\r\n  - 当面核对条款。\r\n`)
    expect(candidate.原文).not.toContain('相邻章')
    expect(report.已登记).toEqual([])
  })

  it('嵌套于起势标题的章条目可定位，正文提及/代码块/方向选择不作候选', () => {
    const text = ['# 卷纲', '## 叙事结构', '### 起势', '- **第二章 契约**', '签约。', '- 第三章：经营',
      '```md', '## 方向选择', '### 第二章 契约', '```', '正文提及第二章 契约不会成为条目。',
      '## 弧线', '~~~', '### 第二章 契约', '~~~', '## 方向选择', '### 第二章 契约', '未选路线。'].join('\n')
    expect(findVolumeReferences(text, 1, name).候选.map(c => c.原文)).toEqual(['- **第二章 契约**\n签约。\n'])
  })

  it('短章名不能误命中更长章名，各分部的明确候选均可核对', () => {
    const text = '## 叙事结构\n- 章51：远期。\n- 章5：当前。\n## 弧线\n### 章5\n弧线推进。\n'
    const candidates = findVolumeReferences(text, 2, '章5').候选
    expect(candidates).toHaveLength(2)
    expect(candidates.map(c => c.原文).join('')).not.toContain('章51')
  })

  it('缩进代码与嵌套方向选择都不作为候选或夹入章条目', () => {
    const text = ['## 叙事结构', '    - 第二章 契约', '\t### 第二章 契约', '### 方向选择',
      '#### 第二章 契约', '未选路线。', '### 第二章 契约', '当前章原文。', '#### 方向选择', '不应夹入的备选路线。', ''].join('\n')
    expect(findVolumeReferences(text, 1, name).候选.map(c => c.原文)).toEqual(['### 第二章 契约\n当前章原文。\n'])
  })
})
