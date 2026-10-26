export type CanonicalRole = 'SUPER_ADMIN' | 'ADMIN' | 'HR' | 'MANAGER' | 'EMPLOYEE'

export const CANONICAL_ROLES: CanonicalRole[] = [
  'SUPER_ADMIN',
  'ADMIN',
  'HR',
  'MANAGER',
  'EMPLOYEE',
]

export function normalizeRole(role: string | null | undefined): string {
  if (!role) return 'EMPLOYEE'
  const normalized = role.trim().toUpperCase().replace(/[\s-]+/g, '_')
  if (
    normalized === 'SUPERADMIN' ||
    normalized === 'SUPER_ADMIN' ||
    normalized === 'SUPER_ADMINISTRATOR' ||
    normalized === 'SUPERADMINISTRATOR'
  ) {
    return 'SUPER_ADMIN'
  }
  if (normalized === 'ADMINISTRATOR') {
    return 'ADMIN'
  }
  return normalized
}

export function isCanonicalRole(role: string): role is CanonicalRole {
  return CANONICAL_ROLES.includes(role as CanonicalRole)
}