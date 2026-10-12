import { describe, expect, it, vi } from 'vitest'
import * as os from 'node:os'
import * as path from 'node:path'

const calls = vi.hoisted(() => [] as string[])
const opened = vi.hoisted(() => new Map<number, string>())
const fault = vi.hoisted(() => ({ backup: false }))
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>()
  const wrapped = {
    ...real,
    openSync: (...args: Parameters<typeof real.openSync>) => { const fd = real.openSync(...args); opened.set(fd, String(args[0])); return fd },
    fsyncSync: (fd: number) => {
      const file = opened.get(fd) ?? ''
      calls.push(`fsync:${file}`)
      if (fault.backup && file.endsWith('.bak')) throw Object.assign(new Error('backup fsync failed'), { code: 'EIO' })
      return real.fsyncSync(fd)
    },
    renameSync: (from: import('node:fs').PathLike, to: import('node:fs').PathLike) => { calls.push(`rename:${path.basename(String(to))}`); return real.renameSync(from, to) },
  }
  return { ...wrapped, default: wrapped }
})

describe('事务持久化（PR-4）', () => {
  it('目标文件在改名落位之前已经 fsync', async () => {
    const fs = await import('node:fs')
    const { writeBatchAtomic } = await import('../src')
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tx-fsync-'))
    try {
      fs.mkdirSync(path.join(root, '正文'))
      fs.writeFileSync(path.join(root, '正文/a.md'), 'old')
      calls.length = 0
      writeBatchAtomic(root, [{ relPath: '正文/a.md', content: 'x' }])
      const publish = calls.indexOf('rename:a.md')
      expect(publish).toBeGreaterThan(0)
      const before = calls.slice(0, publish)
      expect(before.some(call => /fsync:.*[\\/]\.webnovel-txn-.*\.tmp$/.test(call))).toBe(true)
      expect(before.some(call => /fsync:.*[\\/]backups[\\/]0\.bak$/.test(call))).toBe(true)
      if (process.platform !== 'win32') expect(before).toContain(`fsync:${path.join(root, '.webnovel/transactions')}`)
      expect(fs.readFileSync(path.join(root, '正文/a.md'), 'utf8')).toBe('x')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('备份 fsync 失败时不得发布新目标', async () => {
    const fs = await import('node:fs')
    const { writeBatchAtomic } = await import('../src')
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tx-fsync-error-'))
    try {
      fs.writeFileSync(path.join(root, 'a.md'), 'old')
      calls.length = 0
      fault.backup = true
      expect(() => writeBatchAtomic(root, [{ relPath: 'a.md', content: 'new' }])).toThrow('backup fsync failed')
      expect(calls).not.toContain('rename:a.md')
      expect(fs.readFileSync(path.join(root, 'a.md'), 'utf8')).toBe('old')
    } finally { fault.backup = false; fs.rmSync(root, { recursive: true, force: true }) }
  })
})
