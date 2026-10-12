/** Read the explicitly delivered draft; never run review, recovery, or a writer. */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { draftLengthFeedback, draftLengthTarget, isFullyQualifiedPath, readChapterLength, resolveInsideBook } from '@webnovel/core'

function unverified(reason: string, exitCode: number): number {
  console.log(JSON.stringify({ 核验来源: '当前文件', 统计状态: '未核验', 原因: reason }, null, 2))
  return exitCode
}

export function draftLengthCli(argv: readonly string[]): number {
  const args = new Map<string, string>()
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i]
    const value = argv[i + 1]
    if ((flag !== '--book' && flag !== '--稿件') || args.has(flag) || !value?.trim() || value.startsWith('--')) {
      return unverified('参数无效：须提供唯一的 --book 书仓绝对路径和 --稿件 仓内相对路径', 1)
    }
    args.set(flag, value.trim())
  }
  const book = args.get('--book')
  const requested = args.get('--稿件')
  if (!book || !isFullyQualifiedPath(book) || !requested || draftLengthTarget(requested)?.文本阶段 !== '草稿文件') {
    return unverified('须指定书仓绝对路径及正式稿件的仓内相对路径，不能使用暂存稿', 1)
  }
  try {
    if (!fs.statSync(book).isDirectory()) return unverified('书仓路径不是目录', 1)
    const resolved = resolveInsideBook(book, requested)
    if (!resolved.ok) return unverified(resolved.reason, 1)
    const target = draftLengthTarget(resolved.relPath)
    if (target?.文本阶段 !== '草稿文件') return unverified('实际目标不是规范完整稿', 1)
    const file = path.join(book, resolved.relPath)
    if (!fs.statSync(file).isFile()) return unverified('稿件目标不是普通文件', 1)
    const text = fs.readFileSync(file, 'utf8')
    const result = draftLengthFeedback(target, text, readChapterLength(book))
    console.log(JSON.stringify({ 核验来源: '当前文件', ...result }, null, 2))
    return result.统计状态 === '已统计' ? 0 : 1
  } catch (error) {
    const missing = error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')
    return unverified(missing ? '书仓或稿件不存在' : `字数核验异常：${error instanceof Error ? error.message : String(error)}`, missing ? 1 : 2)
  }
}
