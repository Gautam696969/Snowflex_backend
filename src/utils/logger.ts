const RESET = '\x1b[0m'
const BRIGHT = '\x1b[1m'
const RED = '\x1b[31m'
const GREEN = '\x1b[32m'
const YELLOW = '\x1b[33m'
const CYAN = '\x1b[36m'
const DIM = '\x1b[2m'

function format(tag: string, color: string, message: string, meta?: unknown): void {
  const stamp = new Date().toISOString().slice(11, 19)
  const prefix = `${DIM}[${stamp}]${RESET} ${color}${tag}${RESET}`
  const body = `${BRIGHT}${message}${RESET}`
  if (meta !== undefined) {
    console.log(`${prefix} ${body} ${DIM}${JSON.stringify(meta)}${RESET}`)
  } else {
    console.log(`${prefix} ${body}`)
  }
}

export const logger = {
  info: (message: string, meta?: unknown) => format('INFO', CYAN, message, meta),
  success: (message: string, meta?: unknown) => format('OK', GREEN, message, meta),
  warn: (message: string, meta?: unknown) => format('WARN', YELLOW, message, meta),
  error: (message: string, meta?: unknown) => format('ERROR', RED, message, meta),
  request: (method: string, url: string, status: number, durationMs: number) => {
    const color = status >= 500 ? RED : status >= 400 ? YELLOW : GREEN
    const label = status >= 500 ? 'FAIL' : status >= 400 ? 'WARN' : 'HTTP'
    const stamp = new Date().toISOString().slice(11, 19)
    console.log(
      `${DIM}[${stamp}]${RESET} ${color}${label}${RESET} ${BRIGHT}${method} ${url} ${status}${RESET} ${DIM}${durationMs}ms${RESET}`,
    )
  },
}
