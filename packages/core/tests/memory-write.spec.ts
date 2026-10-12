import { afterAll, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { writeAuthorMemory, writeBookMemory, parseDocument, serializeDocument, readAuthorMemoryCatalog } from '../src/index'
import * as rename from '../src/repo/rename'

const roots: string[] = []
const root = () => { const value = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-write-')); roots.push(value); return value }
afterAll(() => { for (const dir of roots) fs.rmSync(dir, { recursive: true, force: true }) })
const input = { 名称: '限知边界', 类: '决策' as const, 描述: '保持限知视角', 来源: '对谈', 正文: '只描写主角知道的事。', 裁决记录: '确认' }

describe('保守记忆写入', () => {
  it.each(['author', 'book'] as const)('%s 新增不覆盖，完全重复与同输入重试不重写条目或索引', scope => {
    const dir = root()
    const write = scope === 'book' ? writeBookMemory : writeAuthorMemory
    const folder = scope === 'book' ? '本书记忆' : '书房/作者记忆'
    expect(write(dir, input)).toMatchObject({ ok: true, changed: true })
    const file = path.join(dir, folder, `${input.名称}.md`), index = path.join(dir, folder, '索引.md')
    const before = fs.readFileSync(file, 'utf8'), beforeIndex = fs.readFileSync(index, 'utf8')
    for (const p of [file, index]) fs.utimesSync(p, 1000, 1000)
    expect(write(dir, input)).toMatchObject({ ok: true, changed: false })
    expect(write(dir, { ...input, 名称: '限知补充版' })).toMatchObject({ ok: true, changed: false, duplicate: true })
    expect(fs.existsSync(path.join(dir, folder, '限知补充版.md'))).toBe(false)
    expect(write(dir, { ...input, 正文: '擅自改变旧结论。' })).toMatchObject({ ok: false })
    expect(fs.readFileSync(file, 'utf8')).toBe(before)
    expect(fs.readFileSync(index, 'utf8')).toBe(beforeIndex)
    for (const p of [file, index]) expect(fs.statSync(p).mtimeMs).toBe(1_000_000)
  })

  it.each(['author', 'book'] as const)('%s 更新核对旧文，保留作者字段，相同完成请求可重试', scope => {
    const dir = root(), write = scope === 'book' ? writeBookMemory : writeAuthorMemory
    const folder = scope === 'book' ? '本书记忆' : '书房/作者记忆'
    expect(write(dir, input).ok).toBe(true)
    const file = path.join(dir, folder, `${input.名称}.md`)
    const parsed = parseDocument(fs.readFileSync(file, 'utf8'))
    if (!parsed.ok) throw new Error(parsed.detail)
    const original = serializeDocument({ ...parsed.data.fields, 生成模块: '作者手改', 额外约束: '保留反派身份留白' }, parsed.data.body)
    fs.writeFileSync(file, original)
    const update = { ...input, 操作: '更新' as const, 原文: original.replace(/\n/g, '\r\n'), 正文: `${input.正文}\n允许通过信件间接透露敌情。` }
    expect(write(dir, { ...update, 原文: undefined })).toMatchObject({ ok: false })
    expect(write(dir, update)).toMatchObject({ ok: true, changed: true, updated: true })
    const changed = fs.readFileSync(file, 'utf8')
    const next = parseDocument(changed)
    expect(next.ok && next.data.fields).toMatchObject({ 生成模块: '作者手改', 额外约束: '保留反派身份留白' })
    expect(next.ok && next.data.body).toContain(input.正文)
    expect(write(dir, update)).toMatchObject({ ok: true, changed: false })
    fs.appendFileSync(file, '\n作者刚补充的条件。\n')
    expect(write(dir, update)).toMatchObject({ ok: false, reason: expect.stringContaining('原文已变化') })
    expect(fs.readFileSync(file, 'utf8')).toContain('作者刚补充的条件')
  })

  it('本书与作者范围独立；旧作者条目目录显示待核对与原标签', () => {
    const ws = root(), a = path.join(ws, '甲书'), b = path.join(ws, '乙书')
    fs.mkdirSync(a); fs.mkdirSync(b)
    expect(writeBookMemory(a, input).ok).toBe(true)
    expect(writeBookMemory(b, { ...input, 正文: '本书使用全知视角。' }).ok).toBe(true)
    expect(fs.existsSync(path.join(ws, '书房/作者记忆'))).toBe(false)
    expect(writeAuthorMemory(ws, { ...input, 标签: ['甲书'] }).ok).toBe(true)
    const file = path.join(ws, '书房/作者记忆', `${input.名称}.md`)
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/^适用范围:.*\r?\n/m, ''))
    expect(readAuthorMemoryCatalog(ws).条目[0]).toMatchObject({ 范围待核对: true, 标签: ['甲书'] })
    expect(fs.readFileSync(path.join(a, '本书记忆', `${input.名称}.md`), 'utf8')).toContain(input.正文)
  })

  it('链接索引拒绝写入，原条目保留', () => {
    const dir = root(), target = root()
    expect(writeAuthorMemory(dir, input).ok).toBe(true)
    const index = path.join(dir, '书房/作者记忆/索引.md')
    const before = fs.readFileSync(path.join(dir, '书房/作者记忆', `${input.名称}.md`), 'utf8')
    fs.writeFileSync(path.join(target, 'index.md'), '外部索引')
    fs.unlinkSync(index); fs.linkSync(path.join(target, 'index.md'), index)
    expect(writeAuthorMemory(dir, { ...input, 名称: '另一事项', 正文: '另一件事。' })).toMatchObject({ ok: false })
    expect(fs.readFileSync(path.join(target, 'index.md'), 'utf8')).toBe('外部索引')
    expect(fs.readFileSync(path.join(dir, '书房/作者记忆', `${input.名称}.md`), 'utf8')).toBe(before)
  })

  it('索引落位失败时条目与索引一起回滚', () => {
    const dir = root()
    expect(writeAuthorMemory(dir, input).ok).toBe(true)
    const index = path.join(dir, '书房/作者记忆/索引.md')
    const before = fs.readFileSync(index, 'utf8')
    const original = rename.renameSync
    let injected = false
    const spy = vi.spyOn(rename, 'renameSync').mockImplementation((from, to) => {
      if (!injected && to === index) { injected = true; throw Object.assign(new Error('index replacement failed'), { code: 'EIO' }) }
      return original(from, to)
    })
    try { expect(() => writeAuthorMemory(dir, { ...input, 名称: '另一个决定', 正文: '保留一个长期例外。' })).toThrow() }
    finally { spy.mockRestore() }
    expect(injected).toBe(true)
    expect(fs.readFileSync(index, 'utf8')).toBe(before)
    expect(fs.existsSync(path.join(dir, '书房/作者记忆/另一个决定.md'))).toBe(false)
  })
})
