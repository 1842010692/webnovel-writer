import { afterEach, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { paths } from '@webnovel/core'
import { createNovelTools } from '../src/novel-tools'
import { decideTargetForFile } from '../src/gates'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })

it('原生窗口工具在派发 write 前拒绝已隔离目标', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'quarantine-tool-')); roots.push(root)
  const q = path.join(root, '.webnovel/quarantine/q'); fs.mkdirSync(q, { recursive: true })
  fs.writeFileSync(path.join(q, 'quarantine.json'), JSON.stringify({ id: 'q', reason: 'conflict', targets: [paths.近期窗口(1)], location: '.webnovel/quarantine/q', quarantinedAt: '' }))
  const nativeWrite = vi.fn()
  const tools = createNovelTools({ workspaceRoot: () => root, bookRootOfBookId: () => root, nativeWrite })
  const result = await tools.find(tool => tool.name === 'novel_roll_window')!.execute({ bookId: 'b', 卷: 1, action: '追加', 名称: '新章' })
  expect(result).toMatchObject({ ok: false, code: 'transaction-conflict', reason: expect.stringContaining('隔离'), next: expect.stringContaining('隔离事务') })
  expect(nativeWrite).not.toHaveBeenCalled()
  expect(fs.existsSync(path.join(root, paths.近期窗口(1)))).toBe(false)
})

it.each(['named', 'unknown', 'unreadable'] as const)('普通文件门禁遵守 %s 隔离且不影响另一书', mode => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'quarantine-gate-')); roots.push(ws)
  const root = path.join(ws, 'book')
  const other = path.join(ws, 'other')
  const relative = '草稿区/草稿/卷01-测试/稿1.md'
  const q = path.join(root, '.webnovel/quarantine/q')
  fs.mkdirSync(q, { recursive: true })
  fs.mkdirSync(other)
  const raw = mode === 'unreadable' ? '{' : JSON.stringify({ id: 'q', reason: 'conflict', targets: mode === 'named' ? [relative] : null, location: '.webnovel/quarantine/q', quarantinedAt: '' })
  fs.writeFileSync(path.join(q, 'quarantine.json'), raw)
  const deps = { workspaceRoot: () => ws, bookRootOfId: (id: string) => id === 'b' ? root : other,
    bookRootForAbs: () => root }
  for (const target of [`b:${relative}`, path.join(root, relative)]) {
    expect(decideTargetForFile(target, deps)).toMatchObject({ kind: 'deny', reason: expect.stringContaining('隔离') })
  }
  expect(decideTargetForFile('b:草稿区/草稿/卷01-测试/稿2.md', deps).kind).toBe(mode === 'named' ? 'allow' : 'deny')
  expect(decideTargetForFile(`other:${relative}`, deps).kind).toBe('allow')
  expect(fs.readFileSync(path.join(q, 'quarantine.json'), 'utf8')).toBe(raw)
  // An unresolved book transaction must not become a workspace-wide stop.
  const ordinary = path.join(ws, 'ordinary-project', 'notes.md')
  const outsideDeps = { ...deps, bookRootForAbs: () => undefined }
  expect(decideTargetForFile(ordinary, outsideDeps)).toMatchObject({ kind: 'allow' })
  expect(decideTargetForFile(path.join(ws, '书房', 'notes.md'), outsideDeps)).toEqual({ kind: 'allow' })
})
