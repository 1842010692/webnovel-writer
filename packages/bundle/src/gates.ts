/**
 * 文件工具门禁挂钩(插件规格 §6 / §14.1 / 格式规格 §9)。
 *
 * R20 分区(M6 批③修复 A2a/A2b + N5 修复):门禁先解析目标再判分区——
 *   1) resolveToBookPath/parseBookPathInput 解析输入:裸相对路径直接拒绝(A2a);
 *      书id:仓内相对 → 该书仓绝对路径;绝对路径 → 校验落在工作范围
 *   2) 解析后判分区归属: `<工作范围>/书房/` → 可写(A2b,书房以书房为界);
 *      工作范围外路径 → ask(N10: 逐次提权确认);
 *      书仓内 → 走 core gateFileAccess(草稿区可写/定稿构想只读/真源仅写入器)
 *      + gateWriteDraft(N5: 未确认细纲不得写稿 不变量 1/6)
 * 判断位置与写入位置一致(用绝对路径判,不再用相对路径猜)。
 *
 * shell(bash/pwsh/terminal)不在本门禁范围——已知限制,靠沙箱+授信兜底
 * (M6 批②记录,见 plugin-spec §6)。
 */

import * as path from 'node:path'
import * as fs from 'node:fs'
import {
  gateFileAccess,
  assertWritableTargets,
  gateWriteDraft,
  isInsidePath,
  canonicalizePath,
  containingBookRoot,
  isFullyQualifiedPath,
  isMutatingFileTool,
  extractToolPath,
  resolveInsideBook,
  type ToolCall,
  type PreToolDecision,
} from '@webnovel/core'
import { parseBookPathInput } from './paths'

/** 与真实 dsh ToolExecution 的消费交集(窄声明)。 */
export interface PreToolExec {
  readonly parent?: symbol
  readonly callId?: string
  readonly name?: string
  readonly arguments?: unknown
  readonly agent?: { readonly id: string }
  readonly signal?: AbortSignal
}

/** 与真实 PreToolDecision 的允许/拒绝/确认交集。 */
export type PreToolDecisionLike = PreToolDecision

export interface GateDeps {
  readonly trustedNativeWrite?: (exec: PreToolExec) => boolean
  /** 当前书id → 书仓根（书id:相对路径解析用）。 */
  readonly bookRootOfId: (bookId: string) => string | undefined
  /** 绝对路径 → 所在书仓根(由调用方用书架扫描提供,避免循环依赖)。 */
  readonly bookRootForAbs: (abs: string) => string | undefined
  /** 工作范围根(用于书房分区判定);未装机 undefined。 */
  readonly workspaceRoot: () => string | undefined
  /** Resolve through the executing session's actual filesystem backend. */
  readonly resolveTarget?: (target: string, exec: PreToolExec) => Promise<string | undefined>
  readonly managedWorkspaces?: () => readonly string[]
}

/**
 * 对单一 agent scoped ctx 注册文件门禁。
 *
 * 交回注销函数（审计 B2）：`ctx.on` 回的注销函数原先被丢弃 —— bundle 卸载后
 * 门禁监听仍挂在该 agent 上，重装即两份门禁串联跑。
 * 无 on 表面时 fail-open 返回 undefined。
 */
export function attachFileGateToAgent(
  agentCtx: { readonly on?: (event: string, listener: (...args: never[]) => unknown) => unknown },
  deps: GateDeps,
): (() => void) | undefined {
  if (typeof agentCtx.on !== 'function') return undefined
  try {
    const listener = async (
      exec: PreToolExec | undefined,
      next: () => Promise<unknown>,
    ): Promise<unknown> => {
      if (exec === undefined || exec.agent === undefined) return next()
      if (deps.trustedNativeWrite?.(exec) === true) return next()
      const toolCall = normalizeToolCall(exec)
      if (toolCall === null) return next()
      const target = extractToolPath(toolCall)
      if (target === null) return next() // Native schemas own malformed arguments.
      let absolute: string | undefined
      try {
        absolute = deps.resolveTarget ? await deps.resolveTarget(target, exec)
          : isFullyQualifiedPath(target) ? canonicalizePath(target)
            : deps.workspaceRoot() ? canonicalizePath(path.resolve(deps.workspaceRoot()!, target)) : undefined
      } catch (error) {
        return { kind: 'deny', reason: error instanceof Error ? error.message : String(error) }
      }
      if (!absolute || !isFullyQualifiedPath(absolute)) return next()
      if (managedRoots(deps).some(root => inside(path.join(root, '书房/参考书'), absolute!))
        && /(?:^|[\\/])\.(?:analysis|webnovel)(?:[\\/]|$)/i.test(absolute)) {
        return { kind: 'deny', reason: '受管原文与机器状态仅供参考工具读取，请使用拆书或定点证据回查' }
      }
      if (!isMutatingFileTool(toolCall)) return next()
      const decision = decideTargetForFile(absolute, deps)
      if (decision.kind !== 'allow') {
        return Promise.resolve(decision as PreToolDecisionLike as never)
      }
      return next()
    }
    const off = agentCtx.on('tools/pre-execute', listener as never)
    return () => { if (typeof off === 'function') (off as () => void)() }
  } catch {
    return undefined
  }
}

/** 规整为 pure 工具面(只取 name/arguments)。 */
function normalizeToolCall(exec: PreToolExec): ToolCall | null {
  const name = exec.name
  if (typeof name !== 'string' || name === '') return null
  const args = exec.arguments
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return null
  return { name, arguments: args }
}

/**
 * 判目标可写:返回 PreToolDecision（allow | deny | ask）。
 * A2a:裸相对路径拒绝; A2b:书房可写; 工作范围外:ask (N10); 书仓内走 core 分区 + 写稿门槛 (N5)。
 */
export function decideTargetForFile(target: string, deps: GateDeps): PreToolDecision {
  const ws = deps.workspaceRoot()
  const parsed = parseBookPathInput(target)
  if (parsed.kind !== 'book-relative') {
    const abs = parsed.kind === 'absolute' ? parsed.abs : ws ? path.resolve(ws, target) : undefined
    if (abs === undefined) return { kind: 'allow' }
    const bookRoot = deps.bookRootForAbs(abs) ?? containingBookRoot(abs)
    // 书房分区:以 工作范围/书房 为界可写(A2b)
    for (const root of managedRoots(deps)) {
      if (!inside(path.join(root, '书房'), abs)) continue
      if (inside(path.join(root, '书房/参考书'), abs)) return { kind: 'deny', reason: '参考库由拆书工具维护；修改机制请在书房编辑器保存版本' }
      if (fs.existsSync(path.join(root, '书房/作品契约/契约.md'))) return { kind: 'deny', reason: '共享目录与书仓重叠，拒绝共享写入豁免' }
    }
    if (bookRoot === undefined) return { kind: 'allow' }
    return gateBookRoot(bookRoot, abs)
  }

  // book-relative: 书id → 书仓根 → 书仓内分区
  const bookRoot = deps.bookRootOfId(parsed.bookId)
  if (bookRoot === undefined) return { kind: 'deny', reason: `未知书目：${parsed.bookId}。书id 必须已在书架扫描中发现；请先调用 novel_select_book 核对书id` }
  return gateBookRoot(bookRoot, parsed.rel)
}

function managedRoots(deps: GateDeps): string[] {
  const root = deps.workspaceRoot()
  return [...new Set([...(root ? [root] : []), ...deps.managedWorkspaces?.() ?? []])].filter(isFullyQualifiedPath)
}

/** 书仓内分区判定:草稿区可写(只留路径形状校验,R1 落码后细纲/材料状态改播报);定稿/构想只读;真源仅写入器。 */
function gateBookRoot(bookRoot: string, target: string): PreToolDecision {
  const access = gateFileAccess(bookRoot, target)
  if (!access.allow) return { kind: 'deny', reason: access.reason }
  // 草稿区路径形状校验(R1 落码:未确认细纲/材料包非可写改为播报,不再拒绝)
  const resolved = resolveInsideBook(bookRoot, target)
  if (!resolved.ok) return { kind: 'deny', reason: resolved.reason }
  const draft = gateWriteDraft(bookRoot, resolved.relPath)
  if (!draft.allow) return { kind: 'deny', reason: draft.reason }
  try { assertWritableTargets(bookRoot, [resolved.relPath]) } catch (error) {
    return { kind: 'deny', reason: error instanceof Error ? error.message : String(error) }
  }
  return { kind: 'allow' }
}

/** 子路径判定(dsh 运行时对齐批:canonical 化后比较,junction/盘符大小写别名不再误判)。 */
function inside(root: string, target: string): boolean {
  return isInsidePath(root, target)
}
