/**
 * Helper to validate CORS origins for HTTP requests and WebSockets.
 */
export function isAllowedOrigin(origin?: string): boolean {
  // Allow server-to-server, curl, Postman, mobile requests without Origin header
  if (!origin) {
    return true
  }

  const cleanOrigin = origin.trim().replace(/\/+$/, '')

  // Allow localhost / 127.0.0.1 on any port (development and preview)
  if (/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(cleanOrigin)) {
    return true
  }

  // Allow Snowflex and Render deployments
  if (/^https:\/\/([a-z0-9-]+\.)?onrender\.com$/i.test(cleanOrigin)) {
    return true
  }

  // Allow common deployment hosts (Vercel, Netlify)
  if (
    /^https:\/\/([a-z0-9-]+\.)?vercel\.app$/i.test(cleanOrigin) ||
    /^https:\/\/([a-z0-9-]+\.)?netlify\.app$/i.test(cleanOrigin)
  ) {
    return true
  }

  // Allow explicitly configured origins in environment
  const configured = [
    process.env.CORS_ORIGIN,
    process.env.FRONTEND_URL,
  ]
    .filter(Boolean)
    .flatMap((val) => (val as string).split(','))
    .map((o) => o.trim().replace(/\/+$/, ''))
    .filter(Boolean)

  if (configured.includes('*')) {
    return true
  }

  const cleanLower = cleanOrigin.toLowerCase()
  return configured.some((c) => c.toLowerCase() === cleanLower)
}
