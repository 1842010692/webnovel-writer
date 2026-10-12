import { afterEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { listQuarantined, writeBatchAtomic, writeFileAtomic } from '../src'

const roots: string[] = []
function book(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tx-quarantine-'))
  roots.push(root)
  return root
}
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('事务隔离与持久化（PR-4）', () => {
  it('清单损坏的批次保留在隔离区，目标未知时暂停写入', () => {
    const root = book()
    const tx = path.join(root, '.webnovel/transactions/bad')
    fs.mkdirSync(tx, { recursive: true })
    fs.writeFileSync(path.join(tx, 'manifest.json'), '{oops')
    expect(() => writeFileAtomic(root, 'a.md', 'x')).toThrow('目标未知')
    expect(fs.existsSync(path.join(root, 'a.md'))).toBe(false)
    expect(fs.existsSync(tx)).toBe(false)
    const [record] = listQuarantined(root)
    expect(record).toMatchObject({ id: 'bad', targets: null })
    expect(fs.readFileSync(path.join(root, record!.location, 'transaction/manifest.json'), 'utf8')).toBe('{oops')
  })

  it('.git 指针指向非 Git 目录时不在书仓外创建任何文件', () => {
    const root = book()
    const outside = path.join(book(), 'not-a-git-dir')
    fs.writeFileSync(path.join(root, '.git'), `gitdir: ${outside}\n`)
    writeFileAtomic(root, 'a.md', 'x')
    expect(fs.existsSync(outside)).toBe(false)
  })
})
