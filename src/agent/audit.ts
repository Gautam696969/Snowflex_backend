import { executeInsert } from '../config/snowflake'
import { logger } from '../utils/logger'

export interface AuditLogEntry {
  requestId: string
  userId: number
  toolName: string
  args: Record<string, unknown>
  status: 'SUCCESS' | 'ERROR' | 'VALIDATION_FAILED'
  errorMessage?: string | null
  executionTimeMs: number
}

export async function logAgentToolCall(entry: AuditLogEntry): Promise<void> {
  try {
    const sanitizedArgs = { ...entry.args }
    delete (sanitizedArgs as any).password
    delete (sanitizedArgs as any).token
    delete (sanitizedArgs as any).secret
    delete (sanitizedArgs as any).authorization

    const argsJson = JSON.stringify(sanitizedArgs).slice(0, 4000)
    const errorMsg = entry.errorMessage ? entry.errorMessage.slice(0, 1000) : null

    await executeInsert(
      `INSERT INTO AGENT_AUDIT_LOG (REQUEST_ID, USER_ID, TOOL_NAME, ARGUMENTS, STATUS, ERROR_MESSAGE, EXECUTION_TIME_MS, CREATED_AT)
       VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP())`,
      [
        entry.requestId || 'req-unknown',
        entry.userId,
        entry.toolName,
        argsJson,
        entry.status,
        errorMsg,
        entry.executionTimeMs,
      ],
    )
  } catch (err) {
    logger.warn('Failed to insert AGENT_AUDIT_LOG record', { error: String(err) })
  }
}
