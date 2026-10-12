import { describe, expect, it, vi } from 'vitest'
import * as os from 'node:os'
import * as path from 'node:path'

const probes = vi.hoisted(() => [] as string[])
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>()
  const native = (p: import('node:fs').PathLike, ...rest: unknown[]) => {
    probes.push(String(p))
    return (real.realpathSync.native as (...args: unknown[]) => string)(p, ...rest)
  }
  const realpathSync = Object.assign((...args: Parameters<typeof real.realpathSync>) => real.realpathSync(...args), { native })
  const wrapped = { ...real, realpathSync }
  return { ...wrapped, default: wrapped }
})

describe('事务内缓存书仓根的 canonical 路径（PR-15）', () => {
  it('10 个文件的批次不再逐个文件重算书仓根', async () => {
    const fs = await import('node:fs')
    const { writeBatchAtomic } = await import('../src')
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tx-canon-')))
    try {
      fs.mkdirSync(path.join(root, '正文'), { recursive: true })
      writeBatchAtomic(root, [{ relPath: '正文/warmup.md', content: 'warmup' }])
      probes.length = 0
      writeBatchAtomic(root, [{ relPath: '正文/one.md', content: 'one' }])
      const singleProbes = probes.filter(p => p === root).length
      probes.length = 0
      writeBatchAtomic(root, Array.from({ length: 10 }, (_, i) => ({ relPath: `正文/${i}.md`, content: String(i) })))
      const rootProbes = probes.filter((p) => p === root).length
      // Extra entry-point checks are constant: root probes must not grow with batch size.
      expect(rootProbes).toBeLessThanOrEqual(singleProbes)
      for (let i = 0; i < 10; i++) expect(fs.readFileSync(path.join(root, `正文/${i}.md`), 'utf8')).toBe(String(i))
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
