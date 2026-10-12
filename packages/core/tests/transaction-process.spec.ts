import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { withBookWrite, writeBatchAtomic, writeContract, paths } from '../src'
import { removeSync } from '../src/repo/remove'

const roots: string[] = []
function root(): string {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), 'webnovel-process-'))
  roots.push(value)
  return value
}
let moduleUrl: string
beforeAll(() => {
  const localRequire = createRequire(import.meta.url)
  const vitestRequire = createRequire(localRequire.resolve('vitest/package.json'))
  const viteRequire = createRequire(vitestRequire.resolve('vite/package.json'))
  const { buildSync } = viteRequire('esbuild') as { buildSync(options: Record<string, unknown>): unknown }
  const outfile = path.join(root(), 'atomic.mjs')
  buildSync({ entryPoints: [fileURLToPath(new URL('../src/repo/atomic.ts', import.meta.url))], outfile, bundle: true, platform: 'node', format: 'esm' })
  moduleUrl = pathToFileURL(outfile).href
})
afterAll(() => { for (const value of roots.reverse()) removeSync(value) })

const childSource = `
import fs from 'node:fs';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
const [url, root, mode, count, rawOps] = process.argv.slice(1);
const rename = fs.renameSync;
let applied = 0;
fs.renameSync = (from, to) => {
  const result = rename(from, to);
  if (mode === 'rename' && path.basename(String(from)).startsWith('.webnovel-txn-') && ++applied === Number(count)) process.exit(88);
  if (mode === 'commit' && path.basename(String(to)) === 'manifest.json' && JSON.parse(fs.readFileSync(to, 'utf8')).phase === 'committed') process.exit(88);
  return result;
};
syncBuiltinESMExports();
const { withBookWrite, writeBatchAtomic } = await import(url);
withBookWrite(root, () => {
  if (mode === 'hold') {
    fs.writeFileSync(path.join(root, 'ready'), '');
    const end = Date.now() + 10000;
    while (!fs.existsSync(path.join(root, 'release')) && Date.now() < end) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    return;
  }
  writeBatchAtomic(root, JSON.parse(rawOps));
}, { operationId: 'process-operation', sessionId: 'process-session', callId: 'process-call' });
`

const ops = [
  { relPath: '正文/a.md', content: 'new-a' },
  { relPath: '正文/b.md', content: 'new-b' },
  { relPath: '正文/c.md', content: 'new-c' },
]
function fixture(): string {
  const value = root()
  fs.mkdirSync(path.join(value, '正文'))
  fs.writeFileSync(path.join(value, '正文/a.md'), 'old-a')
  fs.writeFileSync(path.join(value, '正文/b.md'), 'old-b')
  return value
}
function crash(value: string, mode: string, count: number, files = ops): void {
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', childSource, moduleUrl, value, mode, String(count), JSON.stringify(files)], { encoding: 'utf8', windowsHide: true, timeout: 10000 })
  expect(child.status, child.stderr).toBe(88)
}

describe('real process interruption', () => {
  it('迟到的回收者不能删除继任者的锁目录', async () => {
    const value = root()
    const mutex = path.join(value, '.webnovel/writer.lock')
    fs.mkdirSync(mutex, { recursive: true })
    fs.writeFileSync(path.join(mutex, 'owner-dead.json'), JSON.stringify({ pid: 2147483646, hostname: os.hostname() }))
    const source = `
      import fs from 'node:fs'; import path from 'node:path'; import { syncBuiltinESMExports } from 'node:module';
      const [url, root, actor] = process.argv.slice(1);
      const wait = name => { const end=Date.now()+8000; while(!fs.existsSync(path.join(root,name))) { if(Date.now()>end) throw new Error('timeout '+name); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5); } };
      const unlink = fs.unlinkSync; let hooked=false;
      fs.unlinkSync = function(file) {
        if(actor==='A' && !hooked && String(file).endsWith('owner-dead.json')) {
          hooked=true; fs.writeFileSync(path.join(root,'checked-A'),''); wait('entered-B');
        }
        return unlink.apply(this,arguments);
      };
      syncBuiltinESMExports(); const {withBookWrite}=await import(url);
      withBookWrite(root,()=>{
        fs.writeFileSync(path.join(root,'exclusive'),'',{flag:'wx'});
        fs.writeFileSync(path.join(root,'entered-'+actor),'');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,300);
        fs.unlinkSync(path.join(root,'exclusive'));
      });
    `
    const spawnActor = (actor: string) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', source, moduleUrl, value, actor], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      let error = ''; child.stderr.on('data', chunk => { error += chunk })
      return { child, done: new Promise<void>((resolve, reject) => child.on('exit', code => code === 0 ? resolve() : reject(new Error(error)))) }
    }
    const a = spawnActor('A')
    let b: ReturnType<typeof spawnActor> | undefined
    try {
      const end = Date.now() + 8000
      while (!fs.existsSync(path.join(value, 'checked-A'))) {
        if (Date.now() > end) throw new Error('A did not reach stale-owner cleanup')
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      b = spawnActor('B')
      await Promise.all([a.done, b.done])
      expect(fs.existsSync(path.join(value, 'entered-A'))).toBe(true)
      expect(fs.existsSync(path.join(value, 'entered-B'))).toBe(true)
      expect(fs.existsSync(mutex)).toBe(false)
    } finally { a.child.kill(); b?.child.kill() }
  })

  it.each([1, 2, 3])('recovers before a writer reads after target rename %s', (count) => {
    const value = fixture()
    crash(value, 'rename', count)
    const txs = path.join(value, '.webnovel/transactions')
    const manifest = JSON.parse(fs.readFileSync(path.join(txs, fs.readdirSync(txs)[0]!, 'manifest.json'), 'utf8'))
    expect(manifest.provenance).toMatchObject({ operationId: 'process-operation', sessionId: 'process-session', callId: 'process-call' })
    withBookWrite(value, () => {
      expect(fs.readFileSync(path.join(value, '正文/a.md'), 'utf8')).toBe('old-a')
      expect(fs.readFileSync(path.join(value, '正文/b.md'), 'utf8')).toBe('old-b')
      expect(fs.existsSync(path.join(value, '正文/c.md'))).toBe(false)
    })
    expect(fs.readdirSync(txs)).toEqual([])
    expect(fs.readdirSync(path.join(value, '正文')).sort()).toEqual(['a.md', 'b.md'])
  })

  it('keeps every committed target when the process exits before cleanup', () => {
    const value = fixture()
    crash(value, 'commit', 0)
    withBookWrite(value, () => {
      for (const op of ops) expect(fs.readFileSync(path.join(value, op.relPath), 'utf8')).toBe(op.content)
    })
    expect(fs.readdirSync(path.join(value, '.webnovel/transactions'))).toEqual([])
  })

  it('retains all evidence and all targets when any target conflicts', () => {
    const value = fixture()
    crash(value, 'rename', 2)
    fs.writeFileSync(path.join(value, '正文/b.md'), 'author-edit')
    expect(() => withBookWrite(value, () => 'unreachable')).toThrow(/恢复冲突/)
    expect(fs.readFileSync(path.join(value, '正文/a.md'), 'utf8')).toBe('new-a')
    expect(fs.readFileSync(path.join(value, '正文/b.md'), 'utf8')).toBe('author-edit')
    expect(fs.readdirSync(path.join(value, '.webnovel/transactions'))).toEqual([])
    const tx = path.join(value, '.webnovel/quarantine', fs.readdirSync(path.join(value, '.webnovel/quarantine'))[0]!)
    expect(fs.existsSync(path.join(tx, 'transaction/manifest.json'))).toBe(true)
    expect(fs.readFileSync(path.join(tx, 'transaction/backups/0.bak'), 'utf8')).toBe('old-a')
    // Conflicting targets stay blocked; unrelated files remain writable.
    expect(() => writeBatchAtomic(value, [{ relPath: '正文/a.md', content: 'later' }])).toThrow(/已隔离的冲突事务/)
    writeBatchAtomic(value, [{ relPath: '正文/other.md', content: 'ok' }])
    expect(fs.readFileSync(path.join(value, '正文/other.md'), 'utf8')).toBe('ok')
  })

  it('public contract writer recovers its input before merging an update', () => {
    const value = root()
    writeContract(value, { 题材与读者定位: { state: '已确认', body: 'OLD-CONTRACT' } })
    const original = fs.readFileSync(path.join(value, paths.契约()), 'utf8')
    crash(value, 'rename', 1, [{ relPath: paths.契约(), content: original.replace('OLD-CONTRACT', 'CRASH-CONTRACT') }])
    writeContract(value, { 核心看点与差异化: { state: '已确认', body: 'NEW-PART' } })
    const result = fs.readFileSync(path.join(value, paths.契约()), 'utf8')
    expect(result).toContain('OLD-CONTRACT')
    expect(result).toContain('NEW-PART')
    expect(result).not.toContain('CRASH-CONTRACT')
  })

  it('refuses a real live writer in another process', async () => {
    const value = root()
    const child = spawn(process.execPath, ['--input-type=module', '-e', childSource, moduleUrl, value, 'hold', '0', '[]'], { windowsHide: true, stdio: 'ignore' })
    const exited = new Promise<void>((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', () => resolve())
    })
    try {
      const end = Date.now() + 5000
      while (!fs.existsSync(path.join(value, 'ready')) && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 10))
      expect(fs.existsSync(path.join(value, 'ready'))).toBe(true)
      expect(() => writeBatchAtomic(value, [{ relPath: 'blocked.md', content: 'blocked' }])).toThrow(/锁定中/)
      expect(fs.existsSync(path.join(value, 'blocked.md'))).toBe(false)
    } finally {
      fs.writeFileSync(path.join(value, 'release'), '')
      await exited
    }
  })

  it('uses one lock for a canonical root and a junction alias', () => {
    const value = root()
    const alias = path.join(root(), 'alias')
    fs.symlinkSync(value, alias, process.platform === 'win32' ? 'junction' : 'dir')
    withBookWrite(alias, () => writeBatchAtomic(value, [{ relPath: 'alias.md', content: 'ok' }]))
    expect(fs.readFileSync(path.join(value, 'alias.md'), 'utf8')).toBe('ok')
  })
})
