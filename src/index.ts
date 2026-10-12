import type { Context } from '@deepseek-ai/cordis'

export const name = 'homework-correction'
export const inject = ['tools']

export function apply(ctx: Context): void {
  void import('./runtime.js')
    .then(({ bootstrap }) => bootstrap(ctx))
    .catch((err) => console.error('[dsh-homework-correction] bootstrap failed:', err))
}
