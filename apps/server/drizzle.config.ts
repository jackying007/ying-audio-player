import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  schema: './src/db/schema/index.ts',
  dialect: 'sqlite',
  out: './drizzle'
})
