export const name = 'mock-external-cli-preset'

export function apply(ctx) {
  ctx.effect(() => ctx.on('agent/request', (_req, next) => next()), 'mock-external-cli-preset: request pass-through')
}
