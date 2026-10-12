import { afterEach, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { containingBookRoot } from '../src/book/identity'
import { canonicalizePath } from '../src/gate/canonical'
import { removeSync } from '../src/repo/remove'

const roots: string[] = []
afterEach(() => roots.splice(0).forEach(root => removeSync(root)))

it('实际目标归属不依赖 cwd、书id或有效 frontmatter，新建书立即生效', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'book-owner-')); roots.push(root)
  const book = path.join(root, 'book')
  const target = path.join(book, '草稿区/草稿/卷01-测试/稿1.md')
  expect(containingBookRoot(target)).toBeUndefined()
  fs.mkdirSync(path.join(book, '作品契约'), { recursive: true })
  fs.writeFileSync(path.join(book, '作品契约/契约.md'), '---\n坏: [\n---')
  expect(containingBookRoot(target)).toBe(canonicalizePath(book))
  expect(containingBookRoot(book)).toBe(canonicalizePath(book))
  expect(containingBookRoot(path.join(root, 'ordinary/file.md'))).toBeUndefined()
  const alias = path.join(root, 'alias')
  fs.symlinkSync(book, alias, process.platform === 'win32' ? 'junction' : 'dir')
  expect(containingBookRoot(path.join(alias, '定稿/卷01/0001-测试.md'))).toBe(canonicalizePath(book))
})
