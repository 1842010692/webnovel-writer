import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { spawnSync } from 'node:child_process'
import { build } from 'esbuild'
import { buildCli, checkCliDependencies } from '../scripts/build-cli.mjs'
import { checkStandaloneScripts } from '../scripts/check-standalone-cli.mjs'
import { thinScripts } from '../scripts/artifact-contract.mjs'
import { createStandaloneBook } from './fixtures/standalone-book'
import { removeSync } from '../../core/src/repo/remove'

const packageRoot = path.resolve(__dirname, '..')
let root: string
let installed: string
let book: string

function copyEntries(destination: string) {
  fs.mkdirSync(path.join(destination, 'lib'), { recursive: true })
  fs.writeFileSync(path.join(destination, 'package.json'), '{"type":"module"}')
  for (const [relative] of thinScripts) {
    const target = path.join(destination, relative)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.copyFileSync(path.join(packageRoot, relative), target)
  }
}

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'standalone-cli-'))
  installed = path.join(root, '插件 安装')
  book = path.join(root, '书仓 测试')
  copyEntries(installed)
  await buildCli(path.join(installed, 'lib/cli.js'))
  createStandaloneBook(book)
})
afterAll(() => { if (root) removeSync(root) })

describe('standalone skill CLI boundary', () => {
  it('executes all skill entrypoints without Host packages or readable development source', () => {
    const result = checkStandaloneScripts(installed, book, undefined, path.join(packageRoot, 'src/index.ts'))
    expect(result).toMatchObject({ ok: true, sourceReadDenied: true, writesDenied: true })
    expect(result.scripts.map((entry: { script: string }) => entry.script)).toEqual(thinScripts.map(([relative]: string[]) => relative))
    expect(result.filesUnchanged).toBeGreaterThan(0)
  })

  it('the execution gate rejects a Host dependency before any business checks run', () => {
    const broken = path.join(root, 'broken-package')
    copyEntries(broken)
    fs.writeFileSync(path.join(broken, 'lib/cli.js'), "import '@deepseek-ai/dsh-llm';\n" + fs.readFileSync(path.join(installed, 'lib/cli.js'), 'utf8'))
    const report = path.join(root, 'failure.json')
    expect(() => checkStandaloneScripts(broken, book, report, path.join(packageRoot, 'src/index.ts'))).toThrow(/Cannot find package/)
    expect(JSON.parse(fs.readFileSync(report, 'utf8'))).toMatchObject({ ok: false, scripts: [{ exit: 3, ok: false }] })
  })

  it('rejects both external and bundled shared runtimes using real build metadata', async () => {
    const options = { stdin: { contents: "export { Context } from '@deepseek-ai/cordis'", resolveDir: packageRoot },
      bundle: true, write: false, metafile: true, platform: 'node' as const, format: 'esm' as const, logLevel: 'silent' as const }
    const external = await build({ ...options, external: ['@deepseek-ai/*'] })
    expect(() => checkCliDependencies(external)).toThrow(/non-Node module/)
    const bundled = await build(options)
    expect(() => checkCliDependencies(bundled)).toThrow(/shared Host runtime/)
  })

  it.each(thinScripts)('%s distinguishes missing library/export from execution exceptions', (relative: string, fn: string) => {
    const isolated = path.join(root, 'failures', fn)
    copyEntries(isolated)
    const library = path.join(isolated, 'lib/cli.js')
    const entry = path.join(isolated, relative)
    const run = () => spawnSync(process.execPath, [entry], { cwd: isolated, encoding: 'utf8', windowsHide: true, timeout: 10000,
      env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(NODE_OPTIONS|NODE_PATH|DSH_)/i.test(key))) })
    // analyzeImpactCli has two entrypoints; each scenario starts with a missing file.
    if (fs.existsSync(library)) fs.unlinkSync(library)
    expect(run().status).toBe(3)
    fs.writeFileSync(library, 'export const unrelated = 1')
    const missingExport = run()
    expect(missingExport.status).toBe(3)
    expect(missingExport.stderr).toContain(`运行库缺少 ${fn}`)
    fs.writeFileSync(library, `export function ${fn}() { throw new Error('calculation failed') }`)
    const failed = run()
    expect(failed.status).toBe(2)
    expect(failed.stderr).toContain('执行异常：calculation failed')
    expect(failed.stderr).not.toContain('无法加载')
  })
})
