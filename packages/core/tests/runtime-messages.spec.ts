import { afterEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { diagnoseBookRuntime, writeBatchAtomic, writeFileAtomic } from '../src'

const roots: string[] = []
function book(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-messages-'))
  roots.push(root)
  fs.mkdirSync(path.join(root, '.webnovel'))
  return root
}
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })
function message(fn: () => unknown): string {
  try { fn() } catch (error) { return error instanceof Error ? error.message : String(error) }
  return ''
}

describe('书仓层报错文案（PR-5）', () => {
  it('路径与锁报错不含内部编号或嵌套 Error 前缀，并给出下一步', () => {
    const root = book()
    const texts = [
      message(() => writeFileAtomic(root, '/abs.md', 'x')),
      message(() => writeFileAtomic(root, '../up.md', 'x')),
    ]
    fs.writeFileSync(path.join(root, '.webnovel/book.lock'), JSON.stringify({ pid: process.pid }))
    texts.push(message(() => writeBatchAtomic(root, [{ relPath: 'a.md', content: 'x' }])))
    for (const text of texts) {
      expect(text).not.toBe('')
      expect(text).not.toMatch(/\(B\d|Error:/)
      expect(text).toMatch(/请/)
    }
  })

  it('诊断列出残留锁和隔离的事务，不修改文件', () => {
    const root = book()
    expect(diagnoseBookRuntime(root)).toEqual([])
    fs.writeFileSync(path.join(root, '.webnovel/acquire.lock'), JSON.stringify({ pid: 999_999, hostname: os.hostname() }))
    const tx = path.join(root, '.webnovel/transactions/bad')
    fs.mkdirSync(tx, { recursive: true })
    fs.writeFileSync(path.join(tx, 'manifest.json'), '{oops')
    expect(() => writeFileAtomic(root, 'a.md', 'x')).toThrow('目标未知')
    fs.writeFileSync(path.join(root, '.webnovel/acquire.lock'), JSON.stringify({ pid: 999_999, hostname: os.hostname() }))
    const notes = diagnoseBookRuntime(root)
    expect(notes.some((note) => note.includes('acquire.lock'))).toBe(true)
    expect(notes.some((note) => note.includes('.webnovel/quarantine/'))).toBe(true)
    expect(fs.existsSync(path.join(root, '.webnovel/acquire.lock'))).toBe(true)
  })
})
