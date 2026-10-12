import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { personaText } from '../src/persona'

const repo = fileURLToPath(new URL('../../..', import.meta.url))
/** 术语表「不要写」一列中适用于提示词与工具输出的词（docs/maintenance/writing-style.md）。 */
const BANNED = ['子 Agent', 'Subagent', '主 Agent', '书仓写入器', '作者同意']

function files(dir: string, ext: RegExp): string[] {
  const out: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...files(file, ext))
    else if (ext.test(entry.name)) out.push(file)
  }
  return out
}
/** Only string literals on non-comment lines are model-facing text. */
function literals(source: string): string {
  return source.split('\n').filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line) && !line.includes('BLACKLIST'))
    .flatMap((line) => line.match(/`(?:[^`\\]|\\.)*`|'(?:[^'\\]|\\.)*'/g) ?? []).join('\n')
}

describe('术语统一（PR-7）', () => {
  it('技能文件不含术语表禁用词', () => {
    for (const file of files(path.join(repo, 'packages/bundle/skills'), /\.md$/)) {
      const text = fs.readFileSync(file, 'utf8')
      for (const word of BANNED) expect(text.includes(word), `${path.relative(repo, file)} 含「${word}」`).toBe(false)
      expect(/(?<![待已])定稿包/.test(text), `${path.relative(repo, file)} 含「定稿包」简写`).toBe(false)
    }
  })

  it('persona 与工具输出字符串不含术语表禁用词', () => {
    expect(BANNED.some((word) => personaText.includes(word))).toBe(false)
    const sources = [
      ...files(path.join(repo, 'packages/bundle/src'), /\.ts$/).filter((file) => !file.includes(`${path.sep}client${path.sep}`)),
      ...files(path.join(repo, 'packages/core/src'), /\.ts$/),
    ]
    for (const file of sources) {
      const text = literals(fs.readFileSync(file, 'utf8'))
      for (const word of BANNED) expect(text.includes(word), `${path.relative(repo, file)} 含「${word}」`).toBe(false)
    }
  })

  it('client 界面文案不含术语表禁用词', () => {
    for (const file of files(path.join(repo, 'packages/bundle/src/client'), /\.(ts|tsx)$/)) {
      const visible = fs.readFileSync(file, 'utf8').split('\n').filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n')
      for (const word of BANNED) expect(visible.includes(word), `${path.relative(repo, file)} 含「${word}」`).toBe(false)
    }
  })
})
