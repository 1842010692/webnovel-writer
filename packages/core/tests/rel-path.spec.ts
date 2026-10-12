import { describe, expect, it } from 'vitest'
import { parseSourceRef } from '../src/repo/sourceRef'
import { relPathProblem, safeRelPath } from '../src/repo/rel-path'

describe('safeRelPath / relPathProblem（按路径段判断 ..）', () => {
  it('文件名里的 .. 不算路径穿越', () => {
    expect(parseSourceRef('来源:定稿/卷01/0001-A..B.md@1')).toEqual({ kind: '仓内', path: '定稿/卷01/0001-A..B.md', version: '1' })
    expect(relPathProblem('定稿/卷01/0001-A..B.md')).toBeNull()
  })

  it('路径段 .. 、绝对路径与盘符仍被拒绝', () => {
    expect(parseSourceRef('来源:定稿/../外部.md@1')).toBeNull()
    expect(parseSourceRef('来源:/etc/passwd@1')).toBeNull()
    expect(parseSourceRef('来源:C:/x.md@1')).toBeNull()
    expect(relPathProblem('a\\..\\b')).toBe('traversal')
    expect(relPathProblem('\\\\server\\share')).toBe('absolute')
  })

  it('strict 模式拒绝空路径、. 、冒号和 NUL，并规范化分隔符', () => {
    for (const bad of ['', '.', '卷:01', 'a\0b']) expect(relPathProblem(bad, { strict: true })).toBe('invalid')
    expect(safeRelPath('a\\b/./c.md', () => new Error('x'), { strict: true })).toBe('a/b/c.md')
    expect(() => safeRelPath('../x', (problem) => new Error(problem))).toThrow('traversal')
  })
})
