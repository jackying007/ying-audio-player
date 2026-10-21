import { http } from './http-client'

export * from './http-error'
export type * from './types'
export { connectionSignal } from './http-client'

export const networkApi = await import('./business/network').then(res => res.default(http))
