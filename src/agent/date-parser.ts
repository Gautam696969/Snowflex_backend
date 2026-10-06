const DAYS_OF_WEEK = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

export function getTodayInfo(timezone = 'Asia/Kolkata'): {
  isoDate: string
  dayOfWeek: string
  formattedDate: string
  timezone: string
} {
  // Use Intl to get date in specified timezone
  const now = new Date()
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
  const isoDate = formatter.format(now) // 'YYYY-MM-DD'

  const dateObj = new Date(`${isoDate}T00:00:00Z`)
  const dayOfWeek = DAYS_OF_WEEK[dateObj.getUTCDay()]

  const niceFormatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  })
  const formattedDate = `${dayOfWeek}, ${niceFormatter.format(now)}`

  return {
    isoDate,
    dayOfWeek,
    formattedDate,
    timezone,
  }
}

export function formatDateNice(dateStr: string): string {
  try {
    const parts = dateStr.split('-').map(Number)
    if (parts.length === 3) {
      const d = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]))
      const day = DAYS_OF_WEEK[d.getUTCDay()]
      const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
      return `${day.slice(0, 3)}, ${String(parts[2]).padStart(2, '0')} ${months[parts[1] - 1]} ${parts[0]}`
    }
  } catch {
    // fallback
  }
  return dateStr
}

export function resolveDateString(input: string, referenceIsoDate?: string): string {
  const trimmed = input.trim()

  // If already YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return trimmed
  }

  const baseDate = referenceIsoDate
    ? new Date(`${referenceIsoDate}T00:00:00Z`)
    : new Date()
  const lower = trimmed.toLowerCase()

  if (lower === 'today' || lower === 'aaj') {
    return baseDate.toISOString().split('T')[0]
  }

  if (lower === 'tomorrow' || lower === 'kal') {
    const d = new Date(baseDate)
    d.setUTCDate(d.getUTCDate() + 1)
    return d.toISOString().split('T')[0]
  }

  if (lower === 'day after tomorrow' || lower === 'parso') {
    const d = new Date(baseDate)
    d.setUTCDate(d.getUTCDate() + 2)
    return d.toISOString().split('T')[0]
  }

  if (lower === 'yesterday') {
    const d = new Date(baseDate)
    d.setUTCDate(d.getUTCDate() - 1)
    return d.toISOString().split('T')[0]
  }

  // Handle day of week (e.g. "this friday", "next monday")
  const dayMatch = lower.match(/(?:this|next|coming)?\s*(monday|tuesday|wednesday|thursday|friday|saturday|sunday)/)
  if (dayMatch) {
    const targetDayName = dayMatch[1]
    const targetDayIndex = DAYS_OF_WEEK.map((d) => d.toLowerCase()).indexOf(targetDayName)
    if (targetDayIndex !== -1) {
      const d = new Date(baseDate)
      const currentDayIndex = d.getUTCDay()
      let daysAhead = targetDayIndex - currentDayIndex
      if (daysAhead <= 0 || lower.includes('next')) {
        daysAhead += 7
      }
      d.setUTCDate(d.getUTCDate() + daysAhead)
      return d.toISOString().split('T')[0]
    }
  }

  // Handle "15 Oct" or "15 October" or "15th Oct"
  const monthNames: Record<string, number> = {
    jan: 1, janary: 1, january: 1,
    feb: 2, february: 2,
    mar: 3, march: 3,
    apr: 4, april: 4,
    may: 5,
    jun: 6, june: 6,
    jul: 7, july: 7,
    aug: 8, august: 8,
    sep: 9, sept: 9, september: 9,
    oct: 10, october: 10,
    nov: 11, november: 11,
    dec: 12, december: 12,
  }
  const dateMonthMatch = lower.match(/(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]+)/)
  if (dateMonthMatch) {
    const day = parseInt(dateMonthMatch[1], 10)
    const monthKey = dateMonthMatch[2].slice(0, 3)
    const monthNum = monthNames[monthKey]
    if (monthNum && day >= 1 && day <= 31) {
      const year = baseDate.getUTCFullYear()
      return `${year}-${String(monthNum).padStart(2, '0')}-${String(day).padStart(2, '0')}`
    }
  }

  return trimmed
}
