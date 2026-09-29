export function snowflakeTable(name: string): string {
  const quoteIdentifier = (identifier: string): string => {
    if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(identifier)) {
      throw new Error('Invalid Snowflake identifier')
    }
    return `"${identifier.toUpperCase()}"`
  }

  const database = process.env.SNOWFLAKE_DATABASE?.trim() || 'AUTH_PROJECT'
  const schema = process.env.SNOWFLAKE_SCHEMA?.trim() || 'PUBLIC'
  return `${quoteIdentifier(database)}.${quoteIdentifier(schema)}.${quoteIdentifier(name)}`
}