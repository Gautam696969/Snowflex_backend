import { z } from 'zod'

export interface AgentContext {
  userId: number
  role: string
  fullName: string
  employeeCode?: string | null
  requestId: string
  timezone?: string
}

export interface AgentTool<TParams extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string
  description: string
  parameters: TParams
  openAiParameters: Record<string, unknown>
  requiredRoles?: string[]
  execute: (args: z.infer<TParams>, context: AgentContext) => Promise<unknown>
}

export interface LeaveConfirmationPayload {
  token: string
  leaveTypeId: number
  leaveTypeName: string
  leaveTypeCode: string
  isPaid: boolean
  startDate: string
  endDate: string
  daysCount: number
  halfDaySession?: 'FIRST_HALF' | 'SECOND_HALF' | null
  reason: string
  balanceBefore: number
  balanceAfter: number
  isUnlimited: boolean
  expiresAt: number
}

export interface AgentResult {
  reply: string
  model: string
  toolCallsExecuted: number
  confirmation?: LeaveConfirmationPayload | null
  suggestedActions?: string[]
}

export function defineTool<T extends z.ZodTypeAny>(tool: AgentTool<T>): AgentTool<T> {
  return tool
}
