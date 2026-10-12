import { afterEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { writeFileAtomic } from '../src/repo/atomic'
import { BookLockError, LOCK_STALE_MS } from '../src/repo/lock'

const roots: string[] = []
const children: ChildProcess[] = []
function book(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lock-recovery-'))
  roots.push(root)
  fs.mkdirSync(path.join(root, '.webnovel'))
  return root
}
const runtime = (root: string, name: string) => path.join(root, '.webnovel', name)
function caught(fn: () => unknown): unknown {
  try { fn() } catch (error) { return error }
  return undefined
}
function lockCause(error: unknown): BookLockError | undefined {
  // writeBatchAtomic wraps errors; keep the original instance for the code.
  let current: unknown = error
  while (current instanceof Error) {
    if (current instanceof BookLockError) return current
    current = (current as Error & { cause?: unknown }).cause
  }
  return undefined
}
function holder(lock: string, holdMs: number): Promise<ChildProcess> {
  const script = `const fs=require('fs');fs.writeFileSync(${JSON.stringify(lock)},JSON.stringify({pid:process.pid,hostname:require('os').hostname()}));process.stdout.write('ready');setTimeout(()=>{try{fs.unlinkSync(${JSON.stringify(lock)})}catch{};process.exit(0)},${holdMs})`
  const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'inherit'] })
  children.push(child)
  return new Promise(resolve => child.stdout!.once('data', () => resolve(child)))
}

afterEach(() => {
  for (const child of children.splice(0)) child.kill()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('书仓锁自愈（PR-3）', () => {
  it('回收死进程留下的 acquire.lock', () => {
    const root = book()
    fs.writeFileSync(runtime(root, 'acquire.lock'), JSON.stringify({ pid: 999_999, hostname: os.hostname() }))
    writeFileAtomic(root, 'a.md', 'x')
    expect(fs.readFileSync(path.join(root, 'a.md'), 'utf8')).toBe('x')
    expect(fs.existsSync(runtime(root, 'acquire.lock'))).toBe(false)
  })

  it('本进程 PID 被复用时按创建时间回收旧 book.lock', () => {
    const root = book()
    const lock = runtime(root, 'book.lock')
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, hostname: os.hostname(), createdAt: '2000-01-01T00:00:00.000Z' }))
    const old = new Date(Date.now() - LOCK_STALE_MS - 60_000)
    fs.utimesSync(lock, old, old)
    writeFileAtomic(root, 'a.md', 'x')
    expect(fs.existsSync(lock)).toBe(false)
  })

  it('活进程心跳过期也不能被抢占', async () => {
    const root = book()
    const lock = runtime(root, 'book.lock')
    await holder(lock, 10_000)
    const old = new Date(Date.now() - LOCK_STALE_MS - 60_000)
    fs.utimesSync(lock, old, old)
    const before = fs.readFileSync(lock, 'utf8')
    expect(lockCause(caught(() => writeFileAtomic(root, 'a.md', 'x')))?.code).toBe('book-locked')
    expect(fs.readFileSync(lock, 'utf8')).toBe(before)
  })

  it('归属不明的旧 guard 不按超时盲删', () => {
    const root = book(), guard = runtime(root, 'acquire.lock')
    fs.writeFileSync(guard, '')
    const old = new Date(0)
    fs.utimesSync(guard, old, old)
    expect(lockCause(caught(() => writeFileAtomic(root, 'a.md', 'x')))?.code).toBe('lock-interrupted')
    expect(fs.existsSync(guard)).toBe(true)
    expect(fs.existsSync(runtime(root, 'writer.lock'))).toBe(false)
  })

  it('活跃的外部持有者在重试上限内返回 book-locked，并保留其锁', async () => {
    const root = book()
    const lock = runtime(root, 'book.lock')
    await holder(lock, 10_000)
    const before = fs.readFileSync(lock, 'utf8')
    const started = Date.now()
    const error = caught(() => writeFileAtomic(root, 'a.md', 'x'))
    const elapsed = Date.now() - started
    expect(lockCause(error)?.code).toBe('book-locked')
    expect(elapsed).toBeGreaterThanOrEqual(1_000)
    expect(elapsed).toBeLessThan(5_000)
    expect(fs.readFileSync(lock, 'utf8')).toBe(before)
    expect(fs.existsSync(path.join(root, 'a.md'))).toBe(false)
  })

  it('外部持有者短暂占用后释放，本次写入等待后成功', async () => {
    const root = book()
    await holder(runtime(root, 'book.lock'), 300)
    writeFileAtomic(root, 'a.md', 'x')
    expect(fs.readFileSync(path.join(root, 'a.md'), 'utf8')).toBe('x')
  })
})
