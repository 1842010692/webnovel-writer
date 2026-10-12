import type { Context } from '@deepseek-ai/cordis'
import * as skillFilesystem from '@deepseek-ai/dsh-skill-filesystem'
import { fileURLToPath } from 'node:url'
import type { WritingCapability } from './agent-mode'

declare module '@deepseek-ai/cordis' {
  interface Context {
    webnovelWriting: WritingCapability
    webnovelHost: { readonly active: true, refresh?: () => void | Promise<void> }
  }
  interface Events { 'webnovel/writing-capability-updated'(): void }
}

export const name = 'scriptor-writing-preset'
export const inject = ['skills', 'webnovelHost']

/** The declaration isolates the capability; local/user and bundled skills share one layer. */
export function apply(ctx: Context): void {
  const capability = { mode: 'writing' as const, disposed: false }
  ctx.provide('webnovelWriting', capability)
  const host = ctx.webnovelHost
  ctx.plugin(skillFilesystem, {
    providerName: 'webnovel-bundled',
    includeDefaultRoots: true,
    bundledSkillDir: fileURLToPath(new URL('../skills/', import.meta.url)),
  })
  const changed = async () => {
    try { ctx.root.emit('webnovel/writing-capability-updated') } catch { /* Host shutdown. */ }
    try { await host.refresh?.() } catch { /* Host shutdown. */ }
  }
  ctx.effect(() => {
    void changed()
    return async () => {
      capability.disposed = true
      await changed()
    }
  })
}
