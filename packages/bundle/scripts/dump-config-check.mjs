import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'
import { thinScripts } from './artifact-contract.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
assert.deepEqual(parse(fs.readFileSync(path.join(root, 'cordis.patch.yml'), 'utf8')), [
  { insert: [{ id: 'webnovel', name: manifest.name }] },
])
assert.deepEqual(manifest.dsh.bundle.patch, ['./cordis.patch.yml', './presets/writing.patch.yml'])
const writing = parse(fs.readFileSync(path.join(root, 'presets/writing.patch.yml'), 'utf8'))
assert.equal(writing[0].insert[0].id, 'preset-scriptor')
assert.equal(writing[0].insert[0].config.id, 'scriptor')
assert.equal(writing[0].insert[0].config.name, '写作模式')
assert.equal(writing[0].insert[0].config.order, 5)
assert.equal(writing[0].insert[0].config.selectedDefault, undefined)
assert.equal(fs.readFileSync(path.join(root, 'presets/writing.patch.yml')).equals(fs.readFileSync(path.join(root, '../meta/presets/writing.patch.yml'))), true)
const lib = fs.readFileSync(path.join(root, 'lib/index.js'), 'utf8')
for (const [relative, name] of thinScripts) {
  const text = fs.readFileSync(path.join(root, relative), 'utf8')
  assert.ok(text.includes('lib/index.js'), relative)
  assert.ok(!/from\s*["']@webnovel\//.test(text), relative)
  assert.ok(lib.includes(name), `${name} missing from built library`)
}
console.log(`[bundle] config and ${thinScripts.length} installed script entrypoints: ok`)
