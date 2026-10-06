import crypto from 'crypto'
import { HttpError } from '../utils/http-error'
import { LeaveConfirmationPayload } from './types'

interface StoredConfirmation {
  tokenId: string
  userId: number
  leaveTypeId: number
  leaveTypeName: string
  leaveTypeCode: string
  isPaid: boolean
  startDate: string
  endDate: string
  daysCount: number
  halfDaySession?: 'FIRST_HALF' | 'SECOND_HALF' | null
  reason: string
  balanceBefore: number
  balanceAfter: number
  isUnlimited: boolean
  expiresAt: number
}

// In-memory set of used token IDs to prevent replay attacks
const consumedTokenIds = new Set<string>()

// Periodic cleanup of stale tokens from consumedTokenIds
setInterval(() => {
  // If set grows large, clear old entries
  if (consumedTokenIds.size > 10000) {
    consumedTokenIds.clear()
  }
}, 10 * 60 * 1000)

function getSecret(): string {
  return process.env.JWT_SECRET || 'snowflex-agent-secret-fallback'
}

function signPayload(payloadJson: string): string {
  return crypto.createHmac('sha256', getSecret()).update(payloadJson).digest('hex')
}

export const confirmationService = {
  createToken(params: Omit<StoredConfirmation, 'tokenId' | 'expiresAt'>): LeaveConfirmationPayload {
    const tokenId = `act_${crypto.randomUUID()}`
    const expiresAt = Date.now() + 5 * 60 * 1000 // 5 minutes validity
    const data: StoredConfirmation = {
      ...params,
      tokenId,
      expiresAt,
    }

    const payloadJson = JSON.stringify(data)
    const signature = signPayload(payloadJson)
    const token = `${Buffer.from(payloadJson).toString('base64url')}.${signature}`

    return {
      token,
      leaveTypeId: data.leaveTypeId,
      leaveTypeName: data.leaveTypeName,
      leaveTypeCode: data.leaveTypeCode,
      isPaid: data.isPaid,
      startDate: data.startDate,
      endDate: data.endDate,
      daysCount: data.daysCount,
      halfDaySession: data.halfDaySession,
      reason: data.reason,
      balanceBefore: data.balanceBefore,
      balanceAfter: data.balanceAfter,
      isUnlimited: data.isUnlimited,
      expiresAt: data.expiresAt,
    }
  },

  verifyAndConsumeToken(tokenString: string, expectedUserId: number): StoredConfirmation {
    if (!tokenString || typeof tokenString !== 'string') {
      throw new HttpError(400, 'Confirmation token is required')
    }

    const parts = tokenString.trim().split('.')
    if (parts.length !== 2) {
      throw new HttpError(400, 'Invalid confirmation token format')
    }

    const [b64Payload, signature] = parts
    let payloadJson: string
    try {
      payloadJson = Buffer.from(b64Payload, 'base64url').toString('utf8')
    } catch {
      throw new HttpError(400, 'Malformed confirmation token')
    }

    const expectedSig = signPayload(payloadJson)
    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSig))) {
      throw new HttpError(400, 'Invalid confirmation token signature')
    }

    let payload: StoredConfirmation
    try {
      payload = JSON.parse(payloadJson)
    } catch {
      throw new HttpError(400, 'Invalid confirmation token payload')
    }

    if (payload.userId !== expectedUserId) {
      throw new HttpError(403, 'Confirmation token does not belong to the current authenticated user')
    }

    if (Date.now() > payload.expiresAt) {
      throw new HttpError(400, 'Confirmation token has expired. Please ask the assistant again.')
    }

    if (consumedTokenIds.has(payload.tokenId)) {
      throw new HttpError(409, 'Confirmation token has already been used.')
    }

    // Mark as consumed immediately
    consumedTokenIds.add(payload.tokenId)

    return payload
  },
}
