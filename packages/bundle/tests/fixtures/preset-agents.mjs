/** Compose through the same public setup seam used by the real session controller. */
export function createPresetAgent(registry, options, preset = 'scriptor') {
  const parent = options.parentAgent
  const selected = parent?.ctx.get('agentPresets')?.composedPreset(parent.ctx) ?? preset
  return registry.create({ ...options, meta: { ...options.meta, agentPreset: selected },
    setup: async ctx => {
      if (parent) ctx.get('agentPresets').composeFrom(ctx, parent.ctx)
      else await ctx.get('agentPresets').mount(ctx, selected)
      return options.setup?.(ctx)
    },
  })
}

export function resumePresetAgent(registry, options, preset = 'scriptor') {
  return registry.resume({ ...options, setup: async ctx => {
    if (options.parentAgent) ctx.get('agentPresets').composeFrom(ctx, options.parentAgent.ctx)
    else await ctx.get('agentPresets').mount(ctx, preset)
    return options.setup?.(ctx)
  } })
}
