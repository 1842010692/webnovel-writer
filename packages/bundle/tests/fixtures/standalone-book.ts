import * as fs from 'node:fs'
import * as path from 'node:path'
import { makeFixtureBook } from '../../../core/tests/helpers/fixture-book'
import { serializeDocument } from '../../../core/src/repo/frontmatter'

/** Synthetic files only; this helper runs before the restricted CLI processes. */
export function createStandaloneBook(book: string): void {
  makeFixtureBook(book, 3)
  const draft = path.join(book, '草稿区/草稿/卷01-章1/稿1.md')
  fs.mkdirSync(path.dirname(draft), { recursive: true })
  fs.writeFileSync(draft, serializeDocument({ 角色: '待审稿', 版本: 1 },
    '主角在城门口交出通行文书。\n\n## 草稿候选事实\n- 此处不是正文，不计入字数。\n'))
}
