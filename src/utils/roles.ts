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
  return role.trim().toUpperCase().replace(/[\s-]+/g, '_')
}

export function isCanonicalRole(role: string): role is CanonicalRole {
  return CANONICAL_ROLES.includes(role as CanonicalRole)
}