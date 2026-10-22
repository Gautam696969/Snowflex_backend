export function snowflakeTable(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(name)) {
    throw new Error('Invalid table identifier')
  }
  return `"${name.toUpperCase()}"`
}