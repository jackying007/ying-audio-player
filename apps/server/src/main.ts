import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { HTTPException } from 'hono/http-exception'
import { timingSafeEqual } from 'hono/utils/buffer'
import { api } from '@/business'
import { appErrorHandler } from './app.error.handler'
import { createDb, dbMiddleware, type AppEnv } from './db'
import { cleanupAudio } from './business/cleanup'

const app = new Hono<AppEnv>()
app.onError(appErrorHandler)
app.use(
  '*',
  cors({
    origin: origin =>
      /^(https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?|https?:\/\/tauri\.localhost|tauri:\/\/localhost)$/.test(origin)
        ? origin
        : '',
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Authorization', 'Content-Type'],
    maxAge: 86400
  })
)
app.use('*', async (c, next) => {
  if (!c.env.API_TOKEN) throw new HTTPException(503, { message: '服务端未配置密钥' })
  if (!(await timingSafeEqual(c.req.header('Authorization') ?? '', `Bearer ${c.env.API_TOKEN}`)))
    throw new HTTPException(401, { message: '密钥错误' })
  await next()
})
app.use('*', dbMiddleware)
app.route('/api', api)

export default {
  fetch: app.fetch,
  scheduled: (_event: ScheduledController, env: Env, ctx: ExecutionContext) => {
    ctx.waitUntil(cleanupAudio(createDb(env.D1), env.R2))
  }
}
