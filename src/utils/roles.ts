export function normalizeRole(role: string): string {
  return role.trim().toUpperCase().replace(/[\s-]+/g, '_')
}