import { 卷纲脚手架段 } from '../design/volume'
import { paths } from '../repo/paths'
import type { SupplementSource } from './sections'

export interface VolumeReferenceCandidate {
  readonly 标题: string
  readonly 来源: SupplementSource
  readonly 原文: string
}

export interface VolumeReferenceReport {
  readonly 自动定位: '有候选' | '未命中' | '卷纲缺失'
  readonly 候选: readonly VolumeReferenceCandidate[]
  readonly 已登记: readonly { 编号: string; 标题: string; 状态: '有效' | '已过期' }[]
}

function label(text: string): string {
  return text.replace(/\*\*|__|`/g, '').replace(/\s+#+\s*$/, '').trim()
}

function sectionTitle(text: string): string {
  return text.replace(/\s*[〔(](?:已确认|暂定|留白)[〕)]$/, '')
}

/** Only explicit labels are locators. Prose mentioning a chapter is not a chapter boundary. */
function matchesLabel(text: string, name: string): boolean {
  const normalized = label(text)
  return normalized === name || (normalized.startsWith(name) && /^[\s:：（(〔]/.test(normalized.slice(name.length)))
}

/** Return source ranges for selection; never promote a candidate to selected writing material. */
export function findVolumeReferences(text: string | null, volume: number, name: string): VolumeReferenceReport {
  if (text === null) return { 自动定位: '卷纲缺失', 候选: [], 已登记: [] }
  // Keep original line endings and line numbers for the supplement preview protocol.
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? []
  const headings = new Map<number, { level: number; title: string }>()
  const lists = new Map<number, { indent: number; title: string }>()
  let fence: { char: string; length: number } | undefined
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trimEnd()
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
    if (fence) {
      if (marker && marker[1]![0] === fence.char && marker[1]!.length >= fence.length && marker[2]!.trim() === '') fence = undefined
      continue
    }
    if (marker) { fence = { char: marker[1]![0]!, length: marker[1]!.length }; continue }
    const heading = /^ {0,3}(#{1,6})\s+(.+)$/.exec(line)
    if (heading) headings.set(i, { level: heading[1]!.length, title: label(heading[2]!) })
    // Deeper indentation can be code. Leave ambiguous nested lists to explicit selection.
    const item = /^( {0,3})(?:[-+*]|\d+[.)])\s+(.+)$/.exec(line)
    if (item) lists.set(i, { indent: item[1]!.length, title: item[2]! })
  }
  let allowed = false
  let excludedLevel: number | undefined
  const candidates: VolumeReferenceCandidate[] = []
  for (let i = 0; i < lines.length; i++) {
    const heading = headings.get(i)
    if (heading && excludedLevel !== undefined && heading.level <= excludedLevel) excludedLevel = undefined
    if (heading && heading.level <= 2) {
      const title = sectionTitle(heading.title)
      allowed = heading.level === 2 && (卷纲脚手架段 as readonly string[]).includes(title)
      continue
    }
    if (heading && sectionTitle(heading.title) === '方向选择') { excludedLevel = heading.level; continue }
    if (!allowed || excludedLevel !== undefined) continue
    const item = lists.get(i)
    const title = heading?.title ?? item?.title
    if (title === undefined || !matchesLabel(title, name)) continue
    let end = i + 1
    for (; end < lines.length; end++) {
      const nextHeading = headings.get(end)
      if (nextHeading && (heading === undefined || nextHeading.level <= heading.level || sectionTitle(nextHeading.title) === '方向选择')) break
      const nextItem = lists.get(end)
      if (item && nextItem && nextItem.indent <= item.indent) break
    }
    while (end > i + 1 && lines[end - 1]!.trim() === '') end--
    candidates.push({
      标题: label(title), 来源: { 域: '本书', 路径: paths.卷纲(volume), 起行: i + 1, 终行: end },
      原文: lines.slice(i, end).join(''),
    })
  }
  return { 自动定位: candidates.length ? '有候选' : '未命中', 候选: candidates, 已登记: [] }
}
