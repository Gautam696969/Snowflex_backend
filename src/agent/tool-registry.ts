import { AgentContext, AgentTool } from './types'
import { logAgentToolCall } from './audit'
import { logger } from '../utils/logger'
import { normalizeRole } from '../utils/roles'

export interface ToolExecutionOutput {
  success: boolean
  output: unknown
  error?: string
}

class ToolRegistry {
  private tools = new Map<string, AgentTool>()

  register(tool: AgentTool): void {
    if (this.tools.has(tool.name)) {
      logger.warn(`Overwriting tool registration for ${tool.name}`)
    }
    this.tools.set(tool.name, tool)
  }

  get(name: string): AgentTool | undefined {
    return this.tools.get(name)
  }

  getAll(): AgentTool[] {
    return Array.from(this.tools.values())
  }

  getAvailableForRole(userRole: string): AgentTool[] {
    const normalized = normalizeRole(userRole)
    return Array.from(this.tools.values()).filter((tool) => {
      if (!tool.requiredRoles || tool.requiredRoles.length === 0) return true
      return tool.requiredRoles.map(normalizeRole).includes(normalized)
    })
  }

  getOpenAiDefinitions(userRole: string): Array<{
    type: 'function'
    function: {
      name: string
      description: string
      parameters: Record<string, unknown>
    }
  }> {
    const available = this.getAvailableForRole(userRole)
    return available.map((tool) => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.openAiParameters,
      },
    }))
  }

  async execute(
    name: string,
    rawArgs: Record<string, unknown>,
    context: AgentContext,
  ): Promise<ToolExecutionOutput> {
    const startTime = Date.now()
    const tool = this.tools.get(name)

    // Security: Reject any tool attempt that tries to pass user_id or employee_id from model
    if (rawArgs && typeof rawArgs === 'object') {
      if ('user_id' in rawArgs || 'userId' in rawArgs || 'employee_id' in rawArgs || 'employeeId' in rawArgs) {
        const errorMsg = 'Access Denied: Impersonation or overriding user identity is strictly forbidden.'
        await logAgentToolCall({
          requestId: context.requestId,
          userId: context.userId,
          toolName: name,
          args: rawArgs,
          status: 'VALIDATION_FAILED',
          errorMessage: errorMsg,
          executionTimeMs: Date.now() - startTime,
        })
        return { success: false, output: null, error: errorMsg }
      }
    }

    if (!tool) {
      const errorMsg = `Tool '${name}' is not recognized.`
      await logAgentToolCall({
        requestId: context.requestId,
        userId: context.userId,
        toolName: name,
        args: rawArgs,
        status: 'VALIDATION_FAILED',
        errorMessage: errorMsg,
        executionTimeMs: Date.now() - startTime,
      })
      return { success: false, output: null, error: errorMsg }
    }

    // Role permission check
    if (tool.requiredRoles && tool.requiredRoles.length > 0) {
      const userRoleNormalized = normalizeRole(context.role)
      const allowed = tool.requiredRoles.map(normalizeRole).includes(userRoleNormalized)
      if (!allowed) {
        const errorMsg = `Permission denied: Tool '${name}' requires roles [${tool.requiredRoles.join(', ')}].`
        await logAgentToolCall({
          requestId: context.requestId,
          userId: context.userId,
          toolName: name,
          args: rawArgs,
          status: 'ERROR',
          errorMessage: errorMsg,
          executionTimeMs: Date.now() - startTime,
        })
        return { success: false, output: null, error: errorMsg }
      }
    }

    // Input schema validation using Zod
    const parsed = tool.parameters.safeParse(rawArgs)
    if (!parsed.success) {
      const errorMsg = `Invalid arguments for tool '${name}': ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`
      await logAgentToolCall({
        requestId: context.requestId,
        userId: context.userId,
        toolName: name,
        args: rawArgs,
        status: 'VALIDATION_FAILED',
        errorMessage: errorMsg,
        executionTimeMs: Date.now() - startTime,
      })
      return { success: false, output: null, error: errorMsg }
    }

    try {
      const result = await tool.execute(parsed.data, context)
      const executionTimeMs = Date.now() - startTime

      await logAgentToolCall({
        requestId: context.requestId,
        userId: context.userId,
        toolName: name,
        args: rawArgs,
        status: 'SUCCESS',
        errorMessage: null,
        executionTimeMs,
      })

      return { success: true, output: result }
    } catch (err) {
      const executionTimeMs = Date.now() - startTime
      const errorMsg = err instanceof Error ? err.message : String(err)

      await logAgentToolCall({
        requestId: context.requestId,
        userId: context.userId,
        toolName: name,
        args: rawArgs,
        status: 'ERROR',
        errorMessage: errorMsg,
        executionTimeMs,
      })

      return { success: false, output: null, error: errorMsg }
    }
  }
}

export const toolRegistry = new ToolRegistry()

import {
  getLeaveTypesTool,
  getMyLeaveBalanceTool,
  checkLeaveRequestTool,
  applyLeaveTool,
  getMyLeaveRequestsTool,
  cancelMyLeaveTool,
} from './tools/leave.tools'

toolRegistry.register(getLeaveTypesTool)
toolRegistry.register(getMyLeaveBalanceTool)
toolRegistry.register(checkLeaveRequestTool)
toolRegistry.register(applyLeaveTool)
toolRegistry.register(getMyLeaveRequestsTool)
toolRegistry.register(cancelMyLeaveTool)
