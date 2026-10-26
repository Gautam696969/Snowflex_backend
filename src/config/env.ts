import 'dotenv/config'
import { z } from 'zod'

const environmentSchema = z.object({
  PORT: z.coerce.number().int().positive().default(5000),
  CLOUDFLARE_ACCOUNT_ID: z.string().optional().default(''),
  CLOUDFLARE_DATABASE_ID: z.string().optional().default(''),
  CLOUDFLARE_API_TOKEN: z.string().optional().default(''),
  SNOWFLAKE_ACCOUNT: z.string().optional(),
  SNOWFLAKE_USERNAME: z.string().optional(),
  SNOWFLAKE_PASSWORD: z.string().optional(),
  SNOWFLAKE_WAREHOUSE: z.string().optional(),
  SNOWFLAKE_DATABASE: z.string().default('AUTH_PROJECT'),
  SNOWFLAKE_SCHEMA: z.string().default('PUBLIC'),
  SNOWFLAKE_ROLE: z.string().optional(),
  JWT_SECRET: z.string().min(32),
  JWT_EXPIRES_IN: z.string().default('1d'),
  CORS_ORIGIN: z.string().default(process.env.FRONTEND_URL || 'http://localhost:5173'),
  ATTENDANCE_START_TIME: z.string().regex(/^\d{2}:\d{2}$/).default('09:00'),
})

export type Environment = z.infer<typeof environmentSchema>

export function getEnvironment(): Environment {
  const parsed = environmentSchema.safeParse(process.env)
  if (!parsed.success) {
    const missing = parsed.error.issues.map((issue) => issue.path.join('.')).join(', ')
    throw new Error(`Invalid environment configuration: ${missing}`)
  }
  return parsed.data
}