/** A capability owned by one live, isolated preset revision. */
export interface WritingCapability {
  readonly mode: 'writing'
  /** Invalid as soon as teardown begins, before Cordis removes the service slot. */
  readonly disposed?: boolean
}

interface AgentContext {
  readonly ctx?: unknown
}

/** Use the live preset binding; titles, cwd, and historical origin are not mode evidence. */
export function writingCapabilityOf(agent: AgentContext | undefined): WritingCapability | undefined {
  try {
    const ctx = agent?.ctx as { get?(name: string): unknown } | undefined
    const registry = ctx?.get?.('agentPresets') as { serviceFor?(agent: AgentContext, name: string): unknown } | undefined
    if (!agent || typeof registry?.serviceFor !== 'function') return undefined
    const capability = registry.serviceFor(agent, 'webnovelWriting')
    return capability !== null && typeof capability === 'object' && 'mode' in capability && capability.mode === 'writing'
      && !('disposed' in capability && capability.disposed === true)
      ? capability as WritingCapability : undefined
  } catch { return undefined }
}

export function isWritingAgent(agent: AgentContext | undefined): boolean {
  return writingCapabilityOf(agent) !== undefined
}
