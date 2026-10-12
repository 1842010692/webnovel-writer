import { afterEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { createHash } from 'node:crypto'
import { listQuarantined, recoverTransactions, writeFileAtomic } from '../src'
import { removeSync } from '../src/repo/remove'

const fault = vi.hoisted(() => ({ point: '' }))
vi.mock('node:fs', async load => {
  const real = await load<typeof import('node:fs')>()
  const wrapped = { ...real,
    openSync: (...args: Parameters<typeof real.openSync>) => {
      if (fault.point === 'record' && String(args[0]).endsWith('quarantine.json')) { fault.point = ''; throw new Error('record failure') }
      return real.openSync(...args)
    },
    renameSync: (...args: Parameters<typeof real.renameSync>) => {
      if (fault.point === 'move' && path.basename(String(args[1])) === 'transaction') { fault.point = ''; throw new Error('move failure') }
      return real.renameSync(...args)
    },
  }
  return { ...wrapped, default: wrapped }
})

const roots: string[] = []
function root(): string { const r = fs.mkdtempSync(path.join(os.tmpdir(), 'recovery-boundary-')); roots.push(r); return r }
function put(r: string, rel: string, text: string): void { const file = path.join(r, rel); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text) }
function conflict(): string {
  const r = root(), hash = (text: string) => createHash('sha256').update(text).digest('hex')
  put(r, 'docs/a.md', 'author-edit')
  put(r, '.webnovel/transactions/broken/backups/0.bak', 'old')
  put(r, '.webnovel/transactions/broken/manifest.json', JSON.stringify({ schemaVersion: 1, id: 'broken', phase: 'applying', entries: [{
    relPath: 'docs/a.md', tmpRel: 'docs/.webnovel-txn-broken-0.tmp', backupRel: '.webnovel/transactions/broken/backups/0.bak',
    contentHash: hash('new'), originalHash: hash('old'), hadOriginal: true, backupRecorded: true, applied: true,
  }] }))
  return r
}
afterEach(() => { fault.point = ''; for (const r of roots.splice(0).reverse()) removeSync(r) })

describe('隔离边界与中断恢复', () => {
  it('非法事务链接只隔离链接，不向仓外写入元数据', () => {
    const r = root(), outside = root()
    fs.mkdirSync(path.join(r, '.webnovel/transactions'), { recursive: true })
    fs.symlinkSync(outside, path.join(r, '.webnovel/transactions/link'), process.platform === 'win32' ? 'junction' : 'dir')
    expect(() => recoverTransactions(r)).toThrow('恢复冲突')
    expect(fs.readdirSync(outside)).toEqual([])
    const record = listQuarantined(r)[0]!
    expect(fs.lstatSync(path.join(r, record.location, 'transaction')).isSymbolicLink()).toBe(true)
  })

  it.each(['record', 'move'])('隔离 %s 阶段失败后原文和目标保护仍在', point => {
    const r = conflict(); fault.point = point
    expect(() => recoverTransactions(r)).toThrow(`${point} failure`)
    expect(fs.readFileSync(path.join(r, 'docs/a.md'), 'utf8')).toBe('author-edit')
    expect(() => writeFileAtomic(r, 'docs/a.md', 'overwrite')).toThrow('隔离')
    expect(fs.readFileSync(path.join(r, 'docs/a.md'), 'utf8')).toBe('author-edit')
    if (point === 'move') {
      const [record] = listQuarantined(r)
      expect(fs.readFileSync(path.join(r, record!.location, 'transaction/backups/0.bak'), 'utf8')).toBe('old')
      writeFileAtomic(r, 'other.md', 'unrelated')
    }
  })

  it('隔离记录缺失时从原 manifest 恢复目标，其他文件仍可写', () => {
    const r = conflict()
    expect(() => recoverTransactions(r)).toThrow('恢复冲突')
    const [record] = listQuarantined(r)
    fs.unlinkSync(path.join(r, record!.location, 'quarantine.json'))
    expect(listQuarantined(r)[0]!.targets).toEqual(['docs/a.md'])
    expect(() => writeFileAtomic(r, 'docs/a.md', 'overwrite')).toThrow('隔离')
    writeFileAtomic(r, 'other.md', 'ok')
  })

  it('仓内目录别名不能绕过隔离目标', () => {
    const r = conflict()
    expect(() => recoverTransactions(r)).toThrow('恢复冲突')
    fs.symlinkSync(path.join(r, 'docs'), path.join(r, 'alias'), process.platform === 'win32' ? 'junction' : 'dir')
    expect(() => writeFileAtomic(r, 'alias/a.md', 'overwrite')).toThrow('隔离')
    expect(fs.readFileSync(path.join(r, 'docs/a.md'), 'utf8')).toBe('author-edit')
  })

  it.skipIf(process.platform !== 'win32')('Windows 大小写别名不能绕过隔离目标', () => {
    const r = conflict()
    expect(() => recoverTransactions(r)).toThrow('恢复冲突')
    expect(() => writeFileAtomic(r, 'DOCS/A.MD', 'overwrite')).toThrow('隔离')
  })

  it('格式损坏且无可读 manifest 时显式暂停写入', () => {
    const r = root(); put(r, '.webnovel/quarantine/q/quarantine.json', '{"targets":{}}')
    expect(() => writeFileAtomic(r, 'a.md', 'x')).toThrow('目标未知')
    expect(fs.existsSync(path.join(r, 'a.md'))).toBe(false)
  })
})
