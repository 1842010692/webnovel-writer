/**
 * 作者层记忆仅保存明确跨书的结论；条目与派生索引同批写入。
 */
import * as path from 'node:path'
import { withBookWrite, writeBatchAtomic, writeFileAtomic } from '../repo/atomic'
import type { MemoryKind } from '../repo/paths'
import {
  memoryDocuments, memoryIndex, memoryPath, prepareMemory, type MemoryMutation, MemoryWriteError,
} from './write'

export const 作者记忆相对目录 = '书房/作者记忆'
export const 作者记忆类别 = ['文风', '决策', '对话', '灵感'] as const
export type 作者记忆类 = MemoryKind

export interface AuthorMemoryInput extends MemoryMutation {
  readonly 名称: string
  readonly 描述: string
  readonly 类: 作者记忆类
  readonly 标签?: readonly string[]
  readonly 来源: string
  readonly 正文: string
}

export type AuthorMemoryResult =
  | { readonly ok: true; readonly relPath: string; readonly updated: boolean; readonly changed: boolean; readonly duplicate?: true }
  | { readonly ok: false; readonly reason: string }

function writeAuthorMemoryLocked(workspaceRoot: string, input: AuthorMemoryInput): AuthorMemoryResult {
  if (!input.描述.trim() || /[\r\n]/.test(input.描述)) return { ok: false, reason: '记忆描述须为非空单行' }
  if (!input.来源.trim()) return { ok: false, reason: '记忆来源必填' }
  const docs = memoryDocuments(workspaceRoot, 作者记忆相对目录)
  const index = `${作者记忆相对目录}/索引.md`
  memoryPath(workspaceRoot, index)
  const prepared = prepareMemory(workspaceRoot, 作者记忆相对目录, input, {
    描述: input.描述.trim(), 来源: input.来源.trim(), 适用范围: '作者',
    ...(input.标签 === undefined ? {} : { 标签: input.标签.map(t => t.trim()).filter(Boolean) }),
  }, docs)
  if (prepared.changed) writeBatchAtomic(path.join(workspaceRoot, '书房'), [
    { relPath: prepared.relPath.slice('书房/'.length), content: prepared.content },
    { relPath: index.slice('书房/'.length), content: memoryIndex('作者记忆索引', docs, [prepared]) },
  ])
  return { ok: true, relPath: prepared.relPath, updated: prepared.updated, changed: prepared.changed, ...(prepared.duplicate ? { duplicate: true } : {}) }
}

export function authorMemoryWriteRoot(root: string): string {
  return memoryPath(root, '书房', true)
}

export const writeAuthorMemory = (root: string, input: AuthorMemoryInput): AuthorMemoryResult => withBookWrite(authorMemoryWriteRoot(root), () => {
  try { return writeAuthorMemoryLocked(root, input) }
  catch (error) {
    if (error instanceof MemoryWriteError) return { ok: false, reason: error.message }
    throw error
  }
})

export function 作者记忆目录(workspaceRoot: string): string {
  return path.join(workspaceRoot, ...作者记忆相对目录.split('/'))
}

export interface AuthorMemoryEntry {
  readonly 名称: string
  readonly 描述: string
  readonly 类: string
  readonly 标签: readonly string[]
  readonly 适用范围?: string
  readonly relPath: string
  readonly 正文: string
}

export function listAuthorMemory(workspaceRoot: string): readonly AuthorMemoryEntry[] {
  const docs = memoryDocuments(workspaceRoot, 作者记忆相对目录)
  return docs.map(({ relPath, fields, body }) => ({
    名称: typeof fields['名称'] === 'string' ? fields['名称'] : path.basename(relPath, '.md'),
    描述: typeof fields['描述'] === 'string' ? fields['描述'] : '',
    类: typeof fields['类'] === 'string' ? fields['类'] : '',
    标签: Array.isArray(fields['标签']) ? fields['标签'].map(String) : [],
    ...(typeof fields['适用范围'] === 'string' ? { 适用范围: fields['适用范围'] } : {}),
    relPath, 正文: body,
  }))
}

export const rebuildAuthorMemoryIndex = (workspaceRoot: string): string => withBookWrite(authorMemoryWriteRoot(workspaceRoot), () => {
  const relPath = `${作者记忆相对目录}/索引.md`
  memoryPath(workspaceRoot, relPath)
  writeFileAtomic(path.join(workspaceRoot, '书房'), relPath.slice('书房/'.length), memoryIndex('作者记忆索引', memoryDocuments(workspaceRoot, 作者记忆相对目录), []))
  return path.join(workspaceRoot, relPath)
})
