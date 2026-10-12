import { createHash } from 'node:crypto'
import { checkChapterLength, type ChapterLengthCheck, type ChapterLengthPolicy } from '../design/chapter-length'
import { parseDocument } from './frontmatter'
import { countProseText, type ProseTextCounts } from './drafts'

export interface DraftLengthTarget {
  readonly 稿件: string
  readonly 文本阶段: '起草暂存' | '草稿文件'
}

/** Only numbered drafts and their optional non-Markdown work-in-progress files. */
export function draftLengthTarget(relative: string): DraftLengthTarget | undefined {
  const normalized = relative.replace(/\\/g, '/')
  if (normalized.split('/').some(part => part === '.' || part === '..')) return undefined
  const matchPath = process.platform === 'win32' ? normalized.toLowerCase() : normalized
  const match = /^草稿区\/草稿\/卷\d+-[^/]+\/稿\d+(\.md|\.起草中\.txt)$/.exec(matchPath)
  if (!match) return undefined
  return { 稿件: normalized, 文本阶段: match[1] === '.md' ? '草稿文件' : '起草暂存' }
}

export type DraftLengthFeedback = DraftLengthTarget & (
  | { readonly 统计状态: '未核验'; readonly 原因: string }
  | {
    readonly 统计状态: '已统计'
    readonly 正文统计: ProseTextCounts & {
      readonly 版本: number | null
      readonly 保存文本哈希: string
      readonly 统计口径: string
    }
    readonly 篇幅约定: ChapterLengthPolicy
    readonly 篇幅核对?: ChapterLengthCheck
    /** Signed remainders; negative values mean the saved text is already over. */
    readonly 距目标剩余汉字数?: number
    readonly 距上限剩余汉字数?: number
  }
)

/** Count a supplied complete snapshot; callers choose native after or a fresh read. */
export function draftLengthFeedback(
  target: DraftLengthTarget,
  text: string | undefined,
  policy: ChapterLengthPolicy,
): DraftLengthFeedback {
  if (text === undefined) return { ...target, 统计状态: '未核验', 原因: '原生工具未提供完整保存文本' }
  const doc = parseDocument(text)
  if (!doc.ok) return { ...target, 统计状态: '未核验', 原因: '保存文本的 frontmatter 无法解析' }
  const counts = countProseText(doc.data.body)
  const version = doc.data.fields['版本']
  return {
    ...target,
    统计状态: '已统计',
    正文统计: {
      ...counts,
      版本: typeof version === 'number' && Number.isSafeInteger(version) && version > 0 ? version : null,
      保存文本哈希: createHash('sha256').update(text).digest('hex'),
      统计口径: '正文含章标题，不含 frontmatter 和草稿候选事实。汉字数只计 Unicode Han；字符数含标点和空白，非空白字符数仅剔除空白。',
    },
    篇幅约定: policy,
    ...(target.文本阶段 === '草稿文件' ? { 篇幅核对: checkChapterLength(policy, counts.汉字数) } : {}),
    ...(policy.状态 === '已配置' ? {
      距目标剩余汉字数: policy.范围.目标汉字数 - counts.汉字数,
      距上限剩余汉字数: policy.范围.上限汉字数 - counts.汉字数,
    } : {}),
  }
}
