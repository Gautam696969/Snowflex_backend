import { normalizeRole, CanonicalRole } from '../utils/roles'

export type ChatRole = CanonicalRole

export interface ChatPermissionOptions {
  allowAdminToAdminChat?: boolean
}

export function isAllowAdminToAdminChat(): boolean {
  return process.env.ALLOW_ADMIN_TO_ADMIN_CHAT === 'true'
}

/**
 * Data-driven permission matrix: Maps each role to the target roles they are permitted to chat with.
 */
export function getChatPermissionMatrix(options: ChatPermissionOptions = {}): Record<ChatRole, ChatRole[]> {
  const allowAdminToAdmin = options.allowAdminToAdminChat ?? isAllowAdminToAdminChat()

  const adminTargets: ChatRole[] = ['EMPLOYEE', 'MANAGER', 'HR', 'SUPER_ADMIN']
  if (allowAdminToAdmin) {
    adminTargets.push('ADMIN')
  }

  return {
    EMPLOYEE: ['ADMIN'],
    ADMIN: adminTargets,
    MANAGER: ['ADMIN', 'MANAGER', 'HR', 'SUPER_ADMIN'],
    HR: ['ADMIN', 'MANAGER', 'HR', 'SUPER_ADMIN'],
    SUPER_ADMIN: ['ADMIN', 'MANAGER', 'HR', 'SUPER_ADMIN'],
  }
}

/**
 * Symmetric helper:
 * canChat(roleA, roleB) returns true only if the permission matrix allows:
 * - roleA to chat with roleB, AND
 * - roleB to chat with roleA.
 * This guarantees completely symmetric 2-way permissions without one-sided conversations.
 */
function toChatRole(role: string | null | undefined): ChatRole {
  const norm = normalizeRole(role)
  if (norm === 'USER') return 'EMPLOYEE'
  return norm as ChatRole
}

export function canChat(
  roleA: string | null | undefined,
  roleB: string | null | undefined,
  options: ChatPermissionOptions = {}
): boolean {
  if (!roleA || !roleB) return false

  const normA = toChatRole(roleA)
  const normB = toChatRole(roleB)

  const matrix = getChatPermissionMatrix(options)
  const allowedTargetsForA = matrix[normA] || []
  const allowedTargetsForB = matrix[normB] || []

  const aAllowsB = allowedTargetsForA.includes(normB)
  const bAllowsA = allowedTargetsForB.includes(normA)

  return aAllowsB && bAllowsA
}

/**
 * Returns the list of roles that a given role is allowed to chat with symmetrically.
 */
export function getAllowedChatRoles(role: string | null | undefined, options: ChatPermissionOptions = {}): ChatRole[] {
  if (!role) return []
  const norm = toChatRole(role)
  const allRoles: ChatRole[] = ['SUPER_ADMIN', 'ADMIN', 'HR', 'MANAGER', 'EMPLOYEE']
  return allRoles.filter((targetRole) => canChat(norm, targetRole, options))
}
