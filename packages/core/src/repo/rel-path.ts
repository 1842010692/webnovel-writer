import * as path from 'node:path'

/** 相对路径的问题类别；null 表示可以用作书仓相对路径。 */
export type RelPathProblem = 'absolute' | 'traversal' | 'invalid'

/**
 * 统一判断书仓相对路径：按路径段判断 `..`，因此 `A..B.md` 这类文件名是合法的。
 * `strict` 额外拒绝空路径、`.`、冒号和 NUL（事务清单使用）。
 */
export function relPathProblem(relPath: string, options: { readonly strict?: boolean } = {}): RelPathProblem | null {
  if (path.isAbsolute(relPath) || path.win32.isAbsolute(relPath) || /^[a-zA-Z]:/.test(relPath)) return 'absolute'
  const segments = relPath.split(/[\\/]/)
  if (segments.includes('..')) return 'traversal'
  if (options.strict === true && (relPath === '' || relPath === '.' || relPath.includes(':') || relPath.includes('\0'))) return 'invalid'
  return null
}

/** 规范化为 posix 形式的书仓相对路径；不合法时抛出由调用方给出的报错。 */
export function safeRelPath(relPath: string, fail: (problem: RelPathProblem) => Error, options: { readonly strict?: boolean } = {}): string {
  const problem = relPathProblem(relPath, options)
  if (problem !== null) throw fail(problem)
  return path.posix.normalize(relPath.split(/[\\/]/).join('/'))
}
