import { afterAll, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { canonicalizeChapterKeys, listChapters, scanChapter } from '../src/derive/scan'
import { deriveChapterFacts } from '../src/derive/derive'
import { draftHashOf, reviewInputFingerprintOf } from '../src/evidence/record'
import { parseDocument } from '../src/repo/frontmatter'
import { serializeDocument } from '../src/repo/frontmatter'
import { findPendingReviewDraft, listChapterDrafts } from '../src/repo/drafts'

const roots: string[] = []
function mkBook(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webnovel-book-'))
  roots.push(dir)
  return dir
}
function put(root: string, rel: string, content: string): void {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
  fs.writeFileSync(path.join(root, rel), content, 'utf-8')
}
function md(fields: Record<string, unknown>, body = '内容'): string {
  return serializeDocument(fields, body)
}
afterAll(() => { for (const r of roots) { try { fs.rmSync(r, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }) } catch { /* Windows 句柄延迟释放，%TEMP% 残留无害 */ } } })

const key = { 卷: 1, 章: 3, 章名: '初见' } as const

describe('扫描器→推导端到端(真实文件树)', () => {
  it('链路推进:窗口→候选→确认→材料→草稿→待审→审核→包→裁决→入档', () => {
    const root = mkBook()

    // 窗口就绪
    put(root, '大纲/卷规划/卷01/近期窗口.md', '# 近期窗口\n\n- 初见 〔已确认〕\n- 铺垫 〔暂定〕\n')
    expect(deriveChapterFacts(scanChapter(root, key)).建议.环节).toBe('章细纲(待定位)')

    // 候选细纲(草稿区)
    put(root, '草稿区/章细纲/卷01-初见.md', md({ 状态: '候选', 身份: { 卷: 1, 章: 3, 章名: '初见' } }))
    expect(deriveChapterFacts(scanChapter(root, key)).建议.环节).toBe('章细纲(待确认)')

    // 确认入真源区
    put(root, '大纲/卷规划/卷01/章细纲/0003-初见.md', md({ 状态: '已确认' }))
    expect(deriveChapterFacts(scanChapter(root, key)).建议.环节).toBe('写作备料')

    // 材料包可写
    put(root, '草稿区/材料包/卷01-初见/材料清单.json', JSON.stringify({ schemaVersion: 1, 状态: '段齐备' }))
    expect(deriveChapterFacts(scanChapter(root, key)).建议.环节).toBe('写稿')

    // 草稿
    put(root, '草稿区/草稿/卷01-初见/稿1.md', md({ 状态: '候选' }, '第一章正文'))
    expect(deriveChapterFacts(scanChapter(root, key)).建议.环节).toBe('润色')

    // 唯一待审稿
    put(root, '草稿区/草稿/卷01-初见/稿1.md', md({ 角色: '待审稿' }, '第一章正文'))
    expect(deriveChapterFacts(scanChapter(root, key)).建议.环节).toBe('审核')
    const draftBody = parseDocument(md({ 角色: '待审稿' }, '第一章正文')).data.body
    const binding = {
      审稿哈希: draftHashOf(draftBody),
      审读指纹: reviewInputFingerprintOf({
        正文: draftBody,
        细纲: md({ 状态: '已确认' }),
        材料清单: JSON.stringify({ schemaVersion: 1, 状态: '段齐备' }),
      }),
    }

    // 审核记录(有问题未处置)→改稿
    put(root, '草稿区/审核/卷01-初见.json', JSON.stringify({ schemaVersion: 1, 完成: true, ...binding, 问题: [{ 处置: '' }] }))
    expect(deriveChapterFacts(scanChapter(root, key)).建议.环节).toBe('改稿')

    // 处置齐→定稿准备
    put(root, '草稿区/审核/卷01-初见.json', JSON.stringify({ schemaVersion: 1, 完成: true, ...binding, 问题: [{ 处置: '已解决' }], 模块: { 文本规范检查: { 完成: true, 失败: false } } }))
    expect(deriveChapterFacts(scanChapter(root, key)).建议.环节).toBe('定稿准备与沉淀')

    // 待定稿包七件+清单
    for (const f of ['正文.md', '事实变更.md', '时间线变更.md', '账本变更.md', '章摘要.md', '卷对账.md', '本书层记忆候选.md']) {
      put(root, `草稿区/定稿准备/卷01-初见/${f}`, 'x')
    }
    put(root, '草稿区/定稿准备/卷01-初见/清单.json', JSON.stringify({ schemaVersion: 1, 文件: [] }))
    expect(deriveChapterFacts(scanChapter(root, key)).建议.环节).toBe('作者定稿裁决')

    // 裁决批准→定稿入档
    put(root, '草稿区/定稿准备/卷01-初见/清单.json', JSON.stringify({ schemaVersion: 1, 文件: [], 裁决: '已批准' }))
    expect(deriveChapterFacts(scanChapter(root, key)).建议.环节).toBe('定稿入档')

    // 入档完成
    put(root, '定稿/卷01/0003-初见.md', md({ 状态: '已定稿' }))
    expect(deriveChapterFacts(scanChapter(root, key)).建议.环节).toBe('完成')
  })

  it('叠加标记:细纲需复核被带出且不改位置', () => {
    const root = mkBook()
    put(root, '大纲/卷规划/卷01/章细纲/0003-初见.md', md({ 状态: '需复核' }))
    put(root, '草稿区/材料包/卷01-初见/材料清单.json', JSON.stringify({ schemaVersion: 1, 状态: '段齐备' }))
    const r = deriveChapterFacts(scanChapter(root, key))
    expect(r.建议.环节).toBe('写稿') // 行 4 照常(建议仅供参考)
    expect(r.叠加标记).toContain('细纲')
  })

  it('B4 落地:审核记录解析失败视为「有记录未完成」而非无记录', () => {
    const root = mkBook()
    put(root, '草稿区/草稿/卷01-初见/稿1.md', md({ 角色: '待审稿' }))
    put(root, '草稿区/审核/卷01-初见.json', '{坏的 json')
    const scan = scanChapter(root, key)
    expect(scan.有审核记录).toBe(true)
    expect(scan.审核完成).toBe(false)
    // F5:记录不可读=无哈希=证据过期;恢复视图停在审核(须重审),不冒充改稿处置
    expect(scan.审核证据过期).toBe(true)
    expect(deriveChapterFacts(scan).建议.环节).toBe('审核')
  })

  it('章枚举:listChapters 跨目录收集且去重', () => {
    const root = mkBook()
    put(root, '大纲/卷规划/卷01/章细纲/0003-初见.md', md({ 状态: '已确认' }))
    put(root, '草稿区/章细纲/卷01-铺垫.md', md({ 状态: '候选' }))
    put(root, '定稿/卷01/0001-序幕.md', md({ 状态: '已定稿' }))
    const keys = listChapters(root)
    expect(keys).toHaveLength(3)
    expect(keys.map((k) => k.章名).sort()).toEqual(['初见', '序幕', '铺垫'].sort())
  })

  it('章枚举:审核记录等机器态 JSON 不产生幽灵章键（20章连写真机发现）', () => {
    const root = mkBook()
    put(root, '草稿区/审核/卷01-初见.json', '{"schemaVersion":1}')
    put(root, '草稿区/章细纲/卷01-铺垫.md', md({ 状态: '候选' }))
    const keys = listChapters(root)
    expect(keys.map((k) => k.章名).sort()).toEqual(['铺垫'])
  })
})

describe('润色交付状态兼容性（文件夹具，不模拟模型遵循指令）', () => {
  const dir = '草稿区/草稿/卷01-初见'
  const body = '他没打算走，嘴角牵出一点苦笑。\n\n## 草稿候选事实\n\n- 他留在门口。\n'
  const sourceFields = {
    身份: key, 版本: 1, 父版本: null, 生成模块: '写稿',
    来源快照: { 细纲: '0003-初见.md@1' }, 保真风险: [],
  }

  it('零修改仅提升源稿角色：保留正文/候选/来源，重复扫描不产生稿件或返回润色', () => {
    const root = mkBook()
    const source = md({ ...sourceFields, 角色: '草稿', 选定: true }, body)
    put(root, `${dir}/稿1.md`, source)
    expect(deriveChapterFacts(scanChapter(root, key)).建议.环节).toBe('润色')
    // 模拟已完成的原生元数据 edit，保持正文部分逐字不动。
    const promoted = source.replace('角色: 草稿', '角色: 待审稿')
    put(root, `${dir}/稿1.md`, promoted)
    for (let i = 0; i < 2; i++) {
      expect(deriveChapterFacts(scanChapter(root, key)).建议.环节).toBe('审核')
      expect(findPendingReviewDraft(root, key)?.file).toBe('稿1.md')
    }
    const doc = parseDocument(promoted)
    expect(doc.ok).toBe(true)
    if (!doc.ok) throw new Error(doc.detail)
    expect(doc.data.body).toBe(body)
    expect(doc.data.fields).toEqual({ ...sourceFields, 角色: '待审稿', 选定: true })
    expect(fs.readdirSync(path.join(root, dir))).toEqual(['稿1.md'])
    expect(fs.readFileSync(path.join(root, dir, '稿1.md'), 'utf8')).toBe(promoted)
  })

  it.each([
    { 批次: '无修改/无修改', 稿件: [body], 模块: '写稿' },
    { 批次: '无修改/有修改', 稿件: [body, body.replace('，', '。')], 模块: '润色' },
    { 批次: '有修改/无修改', 稿件: [body, body.replace('走，', '离开，')], 模块: '润色' },
    { 批次: '有修改/有修改', 稿件: [body, body.replace('走，', '离开，'), body.replace('走，', '离开。')], 模块: '润色' },
  ])('$批次：实际交付版本可被扫描与待审读取共同识别', ({ 稿件, 模块 }) => {
    const root = mkBook()
    for (const [i, text] of 稿件.entries()) {
      put(root, `${dir}/稿${i + 1}.md`, md({
        ...sourceFields, 版本: i + 1, 父版本: i === 0 ? null : i,
        生成模块: i === 0 ? '写稿' : '润色',
        角色: i === 稿件.length - 1 ? '待审稿' : '草稿', 选定: i === 稿件.length - 1,
      }, text))
    }
    const drafts = listChapterDrafts(root, key)
    expect(drafts.filter((d) => d.选定)).toHaveLength(1)
    expect(drafts.filter((d) => d.角色 === '待审稿')).toHaveLength(1)
    expect(new Set(drafts.map((d) => d.body)).size).toBe(稿件.length)
    for (const draft of drafts) expect(draft.body.split('## 草稿候选事实')[1]).toBe(body.split('## 草稿候选事实')[1])
    const pending = findPendingReviewDraft(root, key)!
    expect(pending.版本).toBe(稿件.length)
    expect(parseDocument(pending.text)).toMatchObject({ ok: true, data: { fields: { 生成模块: 模块 } } })
    expect(deriveChapterFacts(scanChapter(root, key)).建议.环节).toBe('审核')
  })

  it('风险结果留草稿：不取代安全待审稿；没有安全待审时不伪装完成', () => {
    const root = mkBook()
    const safe = md({ ...sourceFields, 角色: '待审稿', 选定: true }, body)
    put(root, `${dir}/稿1.md`, safe)
    put(root, `${dir}/稿2.md`, md({ ...sourceFields, 版本: 2, 父版本: 1, 生成模块: '润色', 角色: '草稿', 选定: false, 保真风险: ['意图强度待确认'] }, body.replace('没打算', '不想')))
    expect(findPendingReviewDraft(root, key)?.text).toBe(safe)
    expect(listChapterDrafts(root, key).filter((d) => d.选定)).toHaveLength(1)
    const riskOnly = mkBook()
    put(riskOnly, `${dir}/稿1.md`, md({ ...sourceFields, 角色: '草稿', 选定: false, 保真风险: ['否定作用域待确认'] }, body))
    expect(findPendingReviewDraft(riskOnly, key)).toBeNull()
    expect(deriveChapterFacts(scanChapter(riskOnly, key)).建议.环节).toBe('润色')
  })

  it('降级后中断可留零待审，恢复提升已有中间稿，无需再创建版本', () => {
    const root = mkBook()
    put(root, `${dir}/稿1.md`, md({ ...sourceFields, 角色: '草稿', 选定: false }, body))
    const intermediate = md({ ...sourceFields, 版本: 2, 父版本: 1, 生成模块: '润色', 角色: '草稿', 选定: false }, body.replace('走，', '离开，'))
    put(root, `${dir}/稿2.md`, intermediate)
    expect(findPendingReviewDraft(root, key)).toBeNull()
    put(root, `${dir}/稿2.md`, intermediate.replace('角色: 草稿', '角色: 待审稿').replace('选定: false', '选定: true'))
    expect(deriveChapterFacts(scanChapter(root, key)).建议.环节).toBe('审核')
    expect(findPendingReviewDraft(root, key)?.版本).toBe(2)
    expect(listChapterDrafts(root, key)).toHaveLength(2)
  })

  it('复用稿件沿用有效审核证据，细纲变化后仍要求重审', () => {
    const root = mkBook()
    put(root, `${dir}/稿1.md`, md({ ...sourceFields, 角色: '待审稿', 选定: true }, body))
    const outline = md({ 状态: '已确认' }, '他决定留下。')
    put(root, '大纲/卷规划/卷01/章细纲/0003-初见.md', outline)
    put(root, '草稿区/审核/卷01-初见.json', JSON.stringify({
      schemaVersion: 1, 完成: true, 问题: [],
      模块: { 文本规范检查: { 完成: true, 失败: false } },
      审稿哈希: draftHashOf(body),
      审读指纹: reviewInputFingerprintOf({ 正文: body, 细纲: outline, 材料清单: null }),
    }))
    expect(scanChapter(root, key).审核证据过期).toBe(false)
    expect(deriveChapterFacts(scanChapter(root, key)).建议.环节).toBe('定稿准备与沉淀')
    put(root, '大纲/卷规划/卷01/章细纲/0003-初见.md', md({ 状态: '已确认' }, '留下并确认来信。'))
    expect(scanChapter(root, key).审核证据过期).toBe(true)
    expect(deriveChapterFacts(scanChapter(root, key)).建议.环节).toBe('审核')
    expect(listChapterDrafts(root, key)).toHaveLength(1)
  })
})

describe('章键归并与窗口失效过滤(拍板 7 配套)', () => {
  it('窗口第七章 + 真源 0007-第七章 → 只返回一条键(章=7);已消费/已失效窗口项不产生键', () => {
    const root = mkBook()
    const 卷规划 = path.join(root, '大纲/卷规划/卷01')
    fs.mkdirSync(卷规划, { recursive: true })
    fs.writeFileSync(path.join(卷规划, '近期窗口.md'), [
      '# 近期窗口',
      '',
      '- 第七章 〔已确认〕',
      '- 旧章 〔已消费〕',
      '- 断章 〔已失效〕',
      '',
    ].join('\n'), 'utf-8')
    fs.mkdirSync(path.join(卷规划, '章细纲'), { recursive: true })
    fs.writeFileSync(path.join(卷规划, '章细纲/0007-第七章.md'), serializeDocument({ 状态: '已确认' }, '# 细纲\n'), 'utf-8')

    const keys = listChapters(root)
    expect(keys).toEqual([{ 卷: 1, 章: 7, 章名: '第七章' }])
    // 近况行推进:确认细纲后不再是「待定位」
    const facts = scanChapter(root, { 卷: 1, 章: 7, 章名: '第七章' })
    expect(deriveChapterFacts(facts).建议.环节).not.toBe('章细纲(待定位)')
  })

  it('canonicalizeChapterKeys:全角括号章名归一合并;归一后仍不同保留两条', () => {
    const merged = canonicalizeChapterKeys([
      { 卷: 1, 章: 0, 章名: '重逢(上)' },
      { 卷: 1, 章: 8, 章名: '重逢（上）' },
      { 卷: 1, 章: 0, 章名: '重逢 上' },
    ])
    // 全角括号归一后「重逢(上)」并入真源键;「重逢 上」归一为「重逢上」仍是另一章,如实保留
    expect(merged).toEqual([
      { 卷: 1, 章: 0, 章名: '重逢 上' },
      { 卷: 1, 章: 8, 章名: '重逢（上）' },
    ])

    const kept = canonicalizeChapterKeys([
      { 卷: 1, 章: 0, 章名: '重逢' },
      { 卷: 1, 章: 9, 章名: '重逢（下）' },
    ])
    expect(kept).toHaveLength(2)
  })
})
