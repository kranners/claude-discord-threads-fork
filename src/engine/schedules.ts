export type ScheduleRule =
  | { kind: 'every'; everyMs: number }
  | { kind: 'daily'; minuteOfDay: number }

export type ScheduleSpec = ScheduleRule & { prompt: string }

export type StoredRule = {
  kind: string
  every_ms: number | null
  minute_of_day: number | null
}

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS
const UNIT_MS: Record<string, number> = { m: MINUTE_MS, h: HOUR_MS, d: DAY_MS }

export const MIN_INTERVAL_MS = 15 * MINUTE_MS
export const SCHEDULE_TICK_MS = 30_000

export const SCHEDULE_USAGE =
  'Use `/schedule every 6h <prompt>` or `/schedule daily 09:00 <prompt>`. ' +
  '`/schedule` on its own lists this thread’s schedules.'

export function parseSchedule(arg: string): ScheduleSpec | { error: string } {
  const every = arg.match(/^every\s+(\d+)\s*([mhd])\s+([\s\S]+)$/i)
  if (every) {
    const everyMs = Number(every[1]) * UNIT_MS[every[2]!.toLowerCase()]!
    if (everyMs < MIN_INTERVAL_MS) {
      return { error: `Schedules run at most every ${MIN_INTERVAL_MS / MINUTE_MS} minutes.` }
    }
    return { kind: 'every', everyMs, prompt: every[3]!.trim() }
  }

  const daily = arg.match(/^daily\s+(\d{1,2}):(\d{2})\s+([\s\S]+)$/i)
  if (daily) {
    const hours = Number(daily[1])
    const minutes = Number(daily[2])
    if (hours > 23 || minutes > 59) return { error: `\`${daily[1]}:${daily[2]}\` is not a time of day.` }
    return { kind: 'daily', minuteOfDay: hours * 60 + minutes, prompt: daily[3]!.trim() }
  }

  return { error: SCHEDULE_USAGE }
}

export function nextRunAt(rule: ScheduleRule, now: number, lastDue: number = now): number {
  if (rule.kind === 'every') {
    const missed = Math.max(0, Math.floor((now - lastDue) / rule.everyMs))
    return lastDue + rule.everyMs * (missed + 1)
  }
  const next = new Date(now)
  next.setHours(Math.floor(rule.minuteOfDay / 60), rule.minuteOfDay % 60, 0, 0)
  if (next.getTime() <= now) next.setDate(next.getDate() + 1)
  return next.getTime()
}

export function ruleOf(stored: StoredRule): ScheduleRule {
  return stored.kind === 'daily'
    ? { kind: 'daily', minuteOfDay: stored.minute_of_day ?? 0 }
    : { kind: 'every', everyMs: stored.every_ms ?? DAY_MS }
}

export function describeRule(rule: ScheduleRule): string {
  if (rule.kind === 'daily') {
    const hours = String(Math.floor(rule.minuteOfDay / 60)).padStart(2, '0')
    const minutes = String(rule.minuteOfDay % 60).padStart(2, '0')
    return `daily at ${hours}:${minutes}`
  }
  if (rule.everyMs % DAY_MS === 0) return `every ${rule.everyMs / DAY_MS}d`
  if (rule.everyMs % HOUR_MS === 0) return `every ${rule.everyMs / HOUR_MS}h`
  return `every ${rule.everyMs / MINUTE_MS}m`
}

export function discordTime(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  return `<t:${seconds}:f> (<t:${seconds}:R>)`
}
