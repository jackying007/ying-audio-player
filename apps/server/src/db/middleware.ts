import { createMiddleware } from 'hono/factory'
import { drizzle } from 'drizzle-orm/d1'
import { relations } from './relations'

export const createDb = (binding: Env['D1']) => drizzle(binding, { relations })
export type Database = ReturnType<typeof createDb>

export type AppEnv = {
  Bindings: Env
  Variables: {
    db: Database
  }
}

export const dbMiddleware = createMiddleware<AppEnv>(async (c, next) => {
  const db = createDb(c.env.D1)
  c.set('db', db)
  await next()
})
