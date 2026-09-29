import 'dotenv/config'
import { z } from 'zod'

const environmentSchema = z.object({
  PORT: z.coerce.number().int().positive().default(5000),
  SNOWFLAKE_ACCOUNT: z.string().min(1),
  SNOWFLAKE_USERNAME: z.string().min(1),
  SNOWFLAKE_PASSWORD: z.string().min(1),
  SNOWFLAKE_WAREHOUSE: z.string().min(1),
  SNOWFLAKE_DATABASE: z.string().default('AUTH_PROJECT'),
  SNOWFLAKE_SCHEMA: z.string().default('PUBLIC'),
  SNOWFLAKE_ROLE: z.string().min(1),
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