import { Router, Request, Response } from 'express'
import rateLimit from 'express-rate-limit'
import { z } from 'zod'
import { getGroqConfig } from '../config/groq'
import { logger } from '../utils/logger'

const MAX_SESSION_MESSAGES = 10
const SESSION_TTL_MS = 60 * 60 * 1000 // 1 hour

const sessionCounts = new Map<string, { count: number; expiresAt: number }>()

const demoBodySchema = z.object({
  message: z.string().trim().min(1, 'Message cannot be empty').max(300, 'Message cannot exceed 300 characters'),
  sessionId: z.string().trim().min(1).max(128).optional(),
  history: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant']),
        content: z.string().max(400),
      })
    )
    .max(10)
    .optional(),
})

const publicDemoLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many demo messages! Please wait a minute and try again. 😊',
    error: 'TOO_MANY_REQUESTS',
  },
})

const DEMO_SYSTEM_PROMPT = `You are Snowflex AI, the friendly assistant of Snowflex employee management software. Answer only about Snowflex features (attendance, shifts, leave, reports, notifications, team chat & meetings), using clearly labeled sample (demo data). Keep replies under 60 words, friendly and slightly casual with 1-2 emojis. Reply in Hinglish if the user writes in Hinglish. Politely decline unrelated topics and invite the user to sign up.`

function isHinglish(text: string): boolean {
  return /\b(kya|hai|kaun|chutti|aaj|kal|mera|meri|batao|bata|kaise|kitne|haan|nahi|bhai|yaar|karo|hoga)\b/i.test(
    text
  )
}

function getScriptedDemoReply(message: string): string {
  const q = message.toLowerCase()
  const hinglish = isHinglish(q)

  if (q.includes('leave') || q.includes('chutti') || q.includes('absent')) {
    return hinglish
      ? 'Aaj 2 log leave par hain (demo data): Priya Sharma (Sick Leave) aur Rohan Mehta (Casual Leave). 1 request approval ke liye pending hai! 📋'
      : 'Today 2 teammates are on leave (demo data): Priya Sharma (Sick Leave) and Rohan Mehta (Casual Leave), with 1 request pending approval. 📋'
  }
  if (q.includes('attendance') || q.includes('present') || q.includes('check-in') || q.includes('checkin')) {
    return hinglish
      ? 'Aaj ki attendance 94% hai (demo data): 47/50 employees ne selfie check-in kiya hai aur 2 log thoda late aaye. 📸'
      : "Today's attendance is 94% (demo data): 47 of 50 employees checked in with verified selfies, and 2 arrived slightly late. 📸"
  }
  if (q.includes('shift') || q.includes('timing') || q.includes('next shift')) {
    return hinglish
      ? 'Aapki next shift kal 09:00 AM – 06:00 PM IST hai (demo data). Shift start aur end se 5 min pehle push reminder milega! ⏰'
      : 'Your next shift is tomorrow 09:00 AM – 06:00 PM IST (demo data). Snowflex sends a push reminder 5 minutes before check-in and check-out! ⏰'
  }
  if (q.includes('tell me about snowflex') || q.includes('what is snowflex') || q.includes('features') || q.includes('about')) {
    return 'Snowflex is an all-in-one employee management PWA! ✨ It includes selfie attendance, 5-min shift reminders, leave approvals, team chat, HD video meetings, and an AI assistant.'
  }
  if (q.includes('report') || q.includes('analytics') || q.includes('summary')) {
    return 'Weekly Report (demo data): 96.2% on-time punches, 184 total hours logged, and 3 approved leaves across Engineering & Ops! 📊'
  }
  if (q.includes('notification') || q.includes('push') || q.includes('alert') || q.includes('reminder')) {
    return 'Snowflex sends real-time mobile push alerts 5 minutes before shift start/end, plus instant updates for leave approvals and team meetings! 🔔'
  }
  if (q.includes('chat') || q.includes('meet') || q.includes('video') || q.includes('call') || q.includes('screen')) {
    return 'Teams can message live, start 1-to-1 video calls, or launch multi-user meetings with screen sharing right inside Snowflex Chat! 🎥'
  }
  if (q.includes('price') || q.includes('pricing') || q.includes('cost') || q.includes('free') || q.includes('signup')) {
    return 'You can create a free workspace right now to test all features with your team! Click "Start your free trial" whenever you\'re ready. 🚀'
  }
  if (/^(hi|hii|hello|hey|namaste)\b/i.test(q.trim())) {
    return hinglish
      ? 'Hii! 👋 Main Snowflex AI hoon. Attendance, shifts, leave ya reports ke baare me kuch bhi poochho!'
      : 'Hey there! 👋 Ask me about today\'s attendance, who is on leave, shift reminders, or Snowflex features!'
  }
  if (q.includes('thank') || q.includes('thanks') || q.includes('shukriya')) {
    return "You're welcome! 😊 Let me know if you'd like to explore anything else or start your free trial."
  }

  return 'I can help with Snowflex attendance, shifts, leave summaries, and reminders! 😊 Try tapping one of the quick questions like "Who is on leave today?" or "Show today\'s attendance".'
}

export const publicAiRouter = Router()

publicAiRouter.post('/ai-demo', publicDemoLimiter, async (req: Request, res: Response) => {
  const parsed = demoBodySchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({
      success: false,
      message: parsed.error.issues[0]?.message || 'Invalid message',
    })
    return
  }

  const { message, sessionId, history = [] } = parsed.data

  // Enforce max 10 messages per session
  const sessionKey = sessionId || req.ip || 'visitor'
  const now = Date.now()
  const current = sessionCounts.get(sessionKey)
  if (current && current.expiresAt > now) {
    if (current.count >= MAX_SESSION_MESSAGES) {
      res.status(429).json({
        success: false,
        message: 'Demo limit reached (10 messages per session). Sign up for a free workspace to keep chatting! 🚀',
        error: 'SESSION_LIMIT_REACHED',
      })
      return
    }
    current.count += 1
  } else {
    sessionCounts.set(sessionKey, { count: 1, expiresAt: now + SESSION_TTL_MS })
  }

  // Try configured LLM (Groq / OpenAI-compatible) if API key is present; otherwise use scripted fallback
  const groq = getGroqConfig()
  const apiKey = groq?.apiKey || process.env.AI_API_KEY?.trim()
  const apiBaseUrl = groq?.apiBaseUrl || process.env.AI_BASE_URL?.trim() || 'https://api.groq.com/openai/v1'
  const model = groq?.chatModel || process.env.AGENT_MODEL?.trim() || 'qwen/qwen3.8-27b'

  if (apiKey) {
    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 9000)

      const llmResponse = await fetch(`${apiBaseUrl}/chat/completions`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          temperature: 0.5,
          max_tokens: 140,
          messages: [
            { role: 'system', content: DEMO_SYSTEM_PROMPT },
            ...history.slice(-6).map((h) => ({ role: h.role, content: h.content.slice(0, 300) })),
            { role: 'user', content: message },
          ],
        }),
      })

      clearTimeout(timeout)

      if (llmResponse.ok) {
        const json = (await llmResponse.json().catch(() => null)) as {
          choices?: Array<{ message?: { content?: string } }>
        } | null
        const reply = json?.choices?.[0]?.message?.content?.trim()
        if (reply) {
          res.status(200).json({
            success: true,
            data: { reply, source: 'ai' },
          })
          return
        }
      }
    } catch (err) {
      logger.warn('[PUBLIC_AI_DEMO] LLM call failed, falling back to scripted engine:', err)
    }
  }

  const fallbackReply = getScriptedDemoReply(message)
  res.status(200).json({
    success: true,
    data: { reply: fallbackReply, source: 'demo-script' },
  })
})
