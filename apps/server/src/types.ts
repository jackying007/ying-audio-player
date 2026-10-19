import type { hc } from 'hono/client'
import type { api } from './business'
export type HcJsonRes<T extends (...args: any[]) => any> = Awaited<ReturnType<Awaited<ReturnType<T>>['json']>>
export type HCAPI = ReturnType<typeof hc<typeof api>>
