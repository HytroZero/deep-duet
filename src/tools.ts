import type { Context } from '@deepseek-ai/cordis'
import './index.js'

export const name = 'deepduet-tools'
export const inject = ['deepduet', 'systemPrompt', 'tools', 'workingDirectory']

/** Mount DeepDuet Master prompt and orchestration tools inside the `deepduet` Agent Preset. */
export function apply(ctx: Context) {
  ctx.deepduet.registerMasterSurface(ctx)
}
