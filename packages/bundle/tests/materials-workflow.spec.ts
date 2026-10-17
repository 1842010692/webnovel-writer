import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { paths, serializeDocument, reviewRecordHashOf } from '@webnovel/core'
import { registerDefaultChecks, resetChecks } from '@webnovel/review'
import { makeFixtureBook } from '../../core/tests/helpers/fixture-book'
import { removeSync } from '../../core/src/repo/remove'
import { createNovelTools } from '../src/novel-tools'
import { materialsCli } from '../src/scripts/materials-cli'
import { runChecksCli } from '../src/scripts/deterministic-checks'
import { nativeWriteStub } from './fixtures/native-write-stub'

const roots: string[] = []
const key = { 卷: 1, 章: 2, 章名: '章2' }
beforeEach(() => { resetChecks(); registerDefaultChecks() })
afterEach(() => { vi.restoreAllMocks(); roots.splice(0).forEach(root => removeSync(root)) })

function fixture() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'materials-workflow-')); roots.push(workspace)
  const root = path.join(workspace, 'book')
  makeFixtureBook(root, 2)
  fs.writeFileSync(path.join(root, paths.卷纲(1)), '# 卷纲\n## 叙事结构\n起势涵盖数章，完成城门交接。【宏观原文】\n')
  const tools = createNovelTools({ nativeWrite: nativeWriteStub, workspaceRoot: () => workspace, bookRootOfBookId: () => root })
  const call = async (name: string, args: Record<string, unknown> = {}) =>
    await tools.find(tool => tool.name === name)!.execute({ bookId: 'probe', ...key, ...args }) as Record<string, unknown>
  const argv = ['--book', root, '--卷', '1', '--章', '2', '--章名', '章2']
  return { root, call, argv, dir: path.join(root, paths.材料包目录(1, key.章名)) }
}

function jsonOutput(run: () => number) {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {})
  const code = run()
  expect(log).toHaveBeenCalledTimes(1)
  const data = JSON.parse(String(log.mock.calls[0]![0])) as Record<string, unknown>
  log.mockRestore()
  return { code, data }
}

describe('备料与发现项交接工具链', () => {
  it('宏观卷纲缺口：CLI 正常输出，工具预览只读，保存成功并返回就绪报告', async () => {
    const f = fixture()
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const computed = jsonOutput(() => materialsCli(f.argv))
    expect(computed.code).toBe(0)
    expect(error).not.toHaveBeenCalled()
    expect(computed.data).toMatchObject({ ok: true, 状态: '段有缺', 卷纲参考: { 自动定位: '未命中' } })
    const preview = await f.call('novel_assemble_materials', { 模式: '预览' })
    expect(preview).toMatchObject({ ok: true, 状态: '段有缺' })
    expect(fs.existsSync(f.dir)).toBe(false)
    const saved = await f.call('novel_assemble_materials')
    expect(saved).toMatchObject({ ok: true, 状态: '段有缺', dir: paths.材料包目录(1, key.章名), readiness: { 细纲已确认: true, 材料包状态: '段有缺' } })
    expect(saved.reason).toBeUndefined()
    expect(saved.message).toContain('已保存')
    expect(fs.readdirSync(f.dir)).toHaveLength(11)
    for (const value of Object.values(saved)) expect(value).not.toBeUndefined()
    const selected = await f.call('novel_assemble_materials', { 模式: '预览', 补充操作: [{
      操作: '设置', 编号: 'volume', 标题: '起势原文', 理由: '本章承接城门交接', 性质: '原文', 用途: '本章卷纲参考',
      来源: { 域: '本书', 路径: paths.卷纲(1), 起行: 2, 终行: 3 },
    }] })
    const operations = (selected.补充预览 as { 操作: unknown }[]).map(item => item.操作)
    const updated = await f.call('novel_assemble_materials', { 模式: '保存', 材料清单哈希: selected.材料清单哈希, 补充操作: operations })
    expect(updated).toMatchObject({ ok: true, 状态: '段齐备', 卷纲参考: { 自动定位: '未命中', 已登记: [{ 编号: 'volume', 状态: '有效' }] } })
    expect(updated.readiness).toMatchObject({ 材料包状态: '段齐备' })
  })

  it('确定性脚本→回写→处置：两模块编号一致，返回最新哈希，未知编号不改记录', async () => {
    const f = fixture()
    const outline = path.join(f.root, paths.确认细纲(1, 2, key.章名))
    fs.appendFileSync(outline, '\n- 〔硬〕主角本章不得杀人。\n')
    const draftDir = path.join(f.root, paths.草稿目录(1, key.章名))
    fs.mkdirSync(draftDir, { recursive: true })
    fs.writeFileSync(path.join(draftDir, '稿1.md'), serializeDocument({ 角色: '待审稿', 版本: 1 }, '综上所述，主角避开打斗，在城门前放下铜符。'))
    await f.call('novel_assemble_materials')
    const checked = jsonOutput(() => runChecksCli([...f.argv, '--审读材料', 'true']))
    expect(checked.code).toBe(0)
    const payloads = checked.data.回写载荷 as { 模块名: string; 审读指纹: string; 发现项: { 发现项编号: string }[] }[]
    expect(payloads).toHaveLength(2)
    let hash: unknown
    const ids: string[] = []
    const recordPath = path.join(f.root, paths.审核记录(1, key.章名))
    for (const payload of payloads) {
      expect(payload.发现项.length).toBeGreaterThan(0)
      for (const item of payload.发现项) expect(item.发现项编号).toContain(`-${payload.模块名}-`)
      const written = await f.call('novel_record_review_findings', payload)
      expect(written.ok).toBe(true)
      expect(written.发现项编号).toEqual(payload.发现项.map(item => item.发现项编号))
      expect(written.审核记录哈希).toBe(reviewRecordHashOf(fs.readFileSync(recordPath, 'utf8')))
      hash = written.审核记录哈希
      ids.push(...written.发现项编号 as string[])
    }
    const before = fs.readFileSync(recordPath, 'utf8')
    const rejected = await f.call('novel_apply_revision_batch', { 审核记录哈希: hash, 处置: [{ 发现项编号: '审-01-0002-设定-1', 处置: '无法判断' }] })
    expect(rejected.ok).toBe(false)
    expect(rejected.reason).toContain('发现项不存在')
    expect(fs.readFileSync(recordPath, 'utf8')).toBe(before)
    const applied = await f.call('novel_apply_revision_batch', { 审核记录哈希: hash, 处置: ids.map(id => ({ 发现项编号: id, 处置: '无法判断', 改动说明: '保留待作者判断的记录' })) })
    expect(applied).toMatchObject({ ok: true, 更新条数: ids.length })
    const record = JSON.parse(fs.readFileSync(recordPath, 'utf8'))
    expect(record.问题.every((item: { 处置状态: string }) => item.处置状态 === '无法判断')).toBe(true)
    const stale = await f.call('novel_apply_revision_batch', { 审核记录哈希: hash, 处置: [{ 发现项编号: ids[0], 处置: '无法判断' }] })
    expect(stale.ok).toBe(false)
    expect(stale.reason).toContain('审核记录已变化')
  })
})
