/** Execute installed skill commands without Host or development dependencies. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { thinScripts } from './artifact-contract.mjs'

function snapshot(book) {
  const walk = directory => fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const target = path.join(directory, entry.name)
    assert.ok(!entry.isSymbolicLink(), 'Synthetic book must not contain links')
    return entry.isDirectory() ? walk(target) : [[path.relative(book, target).replaceAll('\\', '/'),
      createHash('sha256').update(fs.readFileSync(target)).digest('hex')]]
  })
  return Object.fromEntries(walk(book).sort(([a], [b]) => a.localeCompare(b)))
}

export function checkStandaloneScripts(installedPackage, book, reportPath, blockedSource) {
  installedPackage = fs.realpathSync.native(installedPackage)
  book = fs.realpathSync.native(book)
  const before = snapshot(book)
  const target = path.join(path.dirname(book), '导出 目标')
  assert.ok(!fs.existsSync(target))
  const report = { ok: false, node: process.version, platform: process.platform, scripts: [] }
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(NODE_OPTIONS|NODE_PATH|DSH_)/i.test(key)))
  // Windows realpath after ENOENT needs a trailing separator. Install ancestor
  // grants first: Node's permission tree can otherwise reject the ancestor.
  const grants = [...new Set([installedPackage, path.dirname(book)])].sort((a, b) => a.length - b.length).flatMap(value =>
    [value, value + path.sep].map(spelling => `--allow-fs-read=${spelling}`))
  const run = args => spawnSync(process.execPath, ['--permission', ...grants, ...args], {
    cwd: path.dirname(book), env, encoding: 'utf8', windowsHide: true, timeout: 20000, maxBuffer: 5 * 1024 * 1024,
  })
  const chapter = ['--卷', '1', '--章', '1', '--章名', '章1']
  const argumentsByFunction = {
    draftLengthCli: ['--稿件', '草稿区/草稿/卷01-章1/稿1.md'],
    runChecksCli: [...chapter, '--审读材料', 'true'],
    analyzeImpactCli: ['--变更路径', '世界书/人物档案/主角.md'],
    materialsCli: chapter, packCli: chapter, volumeSummaryCli: ['--卷', '1'],
    exportCli: ['--卷', '1', '--目标', target],
  }
  try {
    if (blockedSource) {
      const probe = run(['--input-type=module', '-e',
        "import fs from 'node:fs'; import assert from 'node:assert/strict'; assert.throws(() => fs.readFileSync(process.argv[1]), {code:'ERR_ACCESS_DENIED'});",
        path.resolve(blockedSource)])
      assert.equal(probe.status, 0, probe.stderr || probe.error?.message)
      report.sourceReadDenied = true
    }
    for (const [relative, fn] of thinScripts) {
      assert.ok(argumentsByFunction[fn], `Missing CLI acceptance scenario: ${fn}`)
      const entry = path.join(installedPackage, relative)
      const result = run([entry, '--book', book, ...argumentsByFunction[fn]])
      const item = { script: relative, exit: result.status, ok: false }
      report.scripts.push(item)
      if (result.status !== 0) item.error = result.stderr || result.error?.message || result.stdout
      assert.equal(result.status, 0, `${relative}: ${item.error}`)
      const value = JSON.parse(result.stdout)
      if ('ok' in value) assert.equal(value.ok, true, result.stdout)
      if (fn === 'draftLengthCli') {
        assert.equal(value.核验来源, '当前文件')
        assert.equal(value.统计状态, '已统计')
      }
      if (fn === 'runChecksCli') {
        assert.match(value.审读指纹, /^[a-f0-9]{64}$/)
        assert.equal(value.正文统计.汉字数, 12)
        assert.ok(value.回写载荷.length >= 2)
        for (const payload of value.回写载荷) {
          assert.equal(payload.审读指纹, value.审读指纹)
          assert.ok(Array.isArray(payload.发现项))
        }
      }
      if (fn === 'analyzeImpactCli') assert.ok(value.references.length > 0)
      if (fn === 'materialsCli') assert.equal(value.段.length, 10)
      if (fn === 'packCli') assert.ok(value.files.length >= 7)
      if (fn === 'volumeSummaryCli') assert.ok(value.候选.length > 0)
      if (fn === 'exportCli') {
        assert.equal(value.章数, 3)
        assert.equal(value.文件.length, 2)
        assert.ok(value.文件[1].content.includes('SHA-256'))
        assert.equal(value.目标.ok, true)
      }
      const invalid = run([entry])
      assert.equal(invalid.status, 1, `${relative}: ${invalid.stderr}`)
      assert.deepEqual(snapshot(book), before, `${relative} changed the book`)
      assert.ok(!fs.existsSync(target), 'Export wrote files')
      Object.assign(item, { ok: true, invalidArgsExit: invalid.status, outputBytes: Buffer.byteLength(result.stdout) })
    }
    for (const fn of ['runChecksCli', 'draftLengthCli']) {
      const [relative] = thinScripts.find(([, name]) => name === fn)
      const missing = run([path.join(installedPackage, relative), '--book', path.join(path.dirname(book), '不存在的书仓'), ...argumentsByFunction[fn]])
      assert.equal(missing.status, 1, missing.stderr)
    }
    Object.assign(report, { ok: true, filesUnchanged: Object.keys(before).length, writesDenied: true })
    return report
  } catch (error) {
    report.error = error.message
    throw error
  } finally {
    if (reportPath) fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n')
  }
}
