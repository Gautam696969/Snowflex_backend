export class ChatRateLimiter {
  private userTimestamps = new Map<number, number[]>()

  checkRateLimit(
    userId: number,
    maxMessages = Number(process.env.CHAT_RATE_LIMIT || 20),
    windowMs = 10000
  ): { allowed: boolean; retryAfterMs?: number } {
    const now = Date.now()
    const timestamps = (this.userTimestamps.get(userId) || []).filter((time) => now - time < windowMs)

    if (timestamps.length >= maxMessages) {
      const oldestInWindow = timestamps[0]
      const retryAfterMs = Math.max(0, windowMs - (now - oldestInWindow))
      return { allowed: false, retryAfterMs }
    }

    timestamps.push(now)
    this.userTimestamps.set(userId, timestamps)
    return { allowed: true }
  }

  reset(userId?: number): void {
    if (userId !== undefined) {
      this.userTimestamps.delete(userId)
    } else {
      this.userTimestamps.clear()
    }
  }
}

export const chatRateLimiter = new ChatRateLimiter()
