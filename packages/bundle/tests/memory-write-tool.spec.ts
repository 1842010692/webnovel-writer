import { afterAll, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { execFileSync } from 'node:child_process'
import { assertObjectJsonSchema } from '@deepseek-ai/dsh-tools'
import { createNovelTools } from '../src/novel-tools'

const roots: string[] = []
const root = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-tool-')); roots.push(dir); return dir }
afterAll(() => { for (const dir of roots) fs.rmSync(dir, { recursive: true, force: true }) })
const data = { 操作: '新增', 名称: '范围选择', 描述: '未来采用何种视角', 类: '文风', 来源: '对谈', 正文: '采用主角限知视角。' }
function fixture() {
  const ws = root()
  const tool = createNovelTools({ workspaceRoot: () => ws, bookRootOfBookId: id => path.join(ws, id) }).find(item => item.name === 'novel_record_memory')!
  return { ws, call: async (args: Record<string, unknown>) => await tool.execute(args) as Record<string, unknown>, tool }
}
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'core.quotepath=false', ...args], { cwd, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
function initBook(dir: string) {
  fs.mkdirSync(dir)
  git(dir, 'init', '--quiet'); git(dir, 'config', 'user.name', 'Memory fixture'); git(dir, 'config', 'user.email', 'memory@example.test')
  fs.writeFileSync(path.join(dir, 'seed.md'), 'fixture')
  git(dir, 'add', 'seed.md'); git(dir, 'commit', '--quiet', '-m', 'fixture')
}

describe('记忆工具范围与更新', () => {
  it('工具 schema 为宿主支持的对象；非法组合在 IO 前拒绝', async () => {
    const workspaceRoot = vi.fn(() => undefined)
    const tool = createNovelTools({ workspaceRoot, bookRootOfBookId: () => undefined }).find(item => item.name === 'novel_record_memory')!
    expect(() => assertObjectJsonSchema(tool.parameters)).not.toThrow()
    for (const args of [{ ...data }, { ...data, scope: 'book' }, { ...data, scope: 'author', bookId: 'a' },
      { ...data, scope: 'author', 操作: '更新' }, { ...data, scope: 'author', 类: 'wrong' }]) {
      expect(await tool.execute(args)).toMatchObject({ ok: false, code: 'invalid-argument' })
    }
    expect(workspaceRoot).not.toHaveBeenCalled()
  })

  it('没有书也能保存作者偏好，并给出实际范围', async () => {
    const { ws, call } = fixture()
    expect(await call({ ...data, scope: 'author' })).toMatchObject({ ok: true, scope: 'author', changed: true, commitState: 'not-required' })
    expect(fs.existsSync(path.join(ws, '书房/作者记忆/范围选择.md'))).toBe(true)
    expect(fs.existsSync(path.join(ws, '本书记忆'))).toBe(false)
  })

  it('两本书同名记忆独立；提交失败后相同输入只补交', async () => {
    const { ws, call } = fixture(), a = path.join(ws, 'a'), b = path.join(ws, 'b')
    initBook(a); initBook(b)
    const hook = path.join(a, '.git/hooks/pre-commit')
    fs.writeFileSync(hook, '#!/bin/sh\nexit 1\n'); fs.chmodSync(hook, 0o755)
    const args = { ...data, scope: 'book', bookId: 'a' }
    expect(await call(args)).toMatchObject({ ok: false, changed: true, commitState: 'failed' })
    const file = path.join(a, '本书记忆/范围选择.md'), text = fs.readFileSync(file, 'utf8')
    fs.utimesSync(file, 1000, 1000)
    fs.unlinkSync(hook)
    expect(await call(args)).toMatchObject({ ok: true, changed: false, commitState: 'committed' })
    expect(fs.readFileSync(file, 'utf8')).toBe(text)
    expect(fs.statSync(file).mtimeMs).toBe(1_000_000)
    expect(await call(args)).toMatchObject({ ok: true, changed: false, commitState: 'unchanged' })
    expect(await call({ ...args, bookId: 'b', 正文: '采用全知视角。' })).toMatchObject({ ok: true, scope: 'book' })
    expect(fs.readFileSync(path.join(b, '本书记忆/范围选择.md'), 'utf8')).toContain('全知视角')
    expect(fs.existsSync(path.join(ws, '书房/作者记忆/范围选择.md'))).toBe(false)
    expect(git(a, 'ls-files')).toContain('本书记忆/范围选择.md')
    expect(await call({ ...args, 操作: '更新', 原文: text, 正文: '新的有效结论。' })).toMatchObject({ ok: true, changed: true })
    expect(await call({ ...args, 操作: '更新', 原文: text, 正文: '另一份过期更新。' })).toMatchObject({ ok: false, code: 'source-conflict' })
  })

  it.each(['author', 'book'])('%s 命名和未知目标隔离继续阻止记忆写入', async scope => {
    for (const mode of ['named', 'unknown']) {
      const { ws, call } = fixture(), writeRoot = path.join(ws, scope === 'book' ? 'a' : '书房')
      const target = scope === 'book' ? '本书记忆/范围选择.md' : '作者记忆/范围选择.md'
      if (mode === 'unknown') {
        const interrupted = path.join(writeRoot, '.webnovel/transactions/bad')
        fs.mkdirSync(interrupted, { recursive: true }); fs.writeFileSync(path.join(interrupted, 'manifest.json'), '{bad')
      } else {
        const q = path.join(writeRoot, '.webnovel/quarantine/q')
        fs.mkdirSync(q, { recursive: true })
        fs.writeFileSync(path.join(q, 'quarantine.json'), JSON.stringify({ id: 'q', reason: 'conflict', targets: [target], location: '.webnovel/quarantine/q', quarantinedAt: '' }))
      }
      expect(await call({ ...data, scope, ...(scope === 'book' ? { bookId: 'a' } : {}) })).toMatchObject({ ok: false, code: 'transaction-conflict' })
      expect(fs.existsSync(path.join(writeRoot, target))).toBe(false)
    }
  })
})
