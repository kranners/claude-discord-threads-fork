import { test, expect, describe } from 'bun:test'
import type { Client } from 'discord.js'
import { openDb } from '../src/store/db'
import { Repo } from '../src/store/repo'
import { handleCommand } from '../src/discord/commands'
import {
  describeRule,
  nextRunAt,
  parseSchedule,
  ruleOf,
  type ScheduleSpec,
} from '../src/engine/schedules'

const MINUTE = 60_000
const HOUR = 60 * MINUTE

function spec(arg: string): ScheduleSpec {
  const parsed = parseSchedule(arg)
  if ('error' in parsed) throw new Error(parsed.error)
  return parsed
}

describe('parseSchedule', () => {
  test('reads intervals in minutes, hours and days', () => {
    expect(spec('every 30m check the build')).toEqual({ kind: 'every', everyMs: 30 * MINUTE, prompt: 'check the build' })
    expect(spec('every 6h summarise new issues')).toMatchObject({ everyMs: 6 * HOUR })
    expect(spec('EVERY 2D tidy branches')).toMatchObject({ everyMs: 48 * HOUR })
  })

  test('reads a daily time of day', () => {
    expect(spec('daily 09:00 post the standup')).toEqual({ kind: 'daily', minuteOfDay: 540, prompt: 'post the standup' })
    expect(spec('daily 7:05 wake up')).toMatchObject({ minuteOfDay: 425 })
  })

  test('keeps a multi-line prompt whole', () => {
    expect(spec('every 1h first line\nsecond line').prompt).toBe('first line\nsecond line')
  })

  test('refuses intervals shorter than the floor', () => {
    expect(parseSchedule('every 5m spam')).toEqual({ error: 'Schedules run at most every 15 minutes.' })
  })

  test('refuses times that do not exist', () => {
    expect('error' in parseSchedule('daily 24:00 x')).toBe(true)
    expect('error' in parseSchedule('daily 09:60 x')).toBe(true)
  })

  test('explains the syntax for anything else', () => {
    for (const arg of ['every 6h', 'daily 09:00', 'hourly do it', 'every six hours do it']) {
      expect(parseSchedule(arg)).toMatchObject({ error: expect.stringContaining('/schedule every 6h') })
    }
  })
})

describe('nextRunAt', () => {
  test('an interval counts from now when first created', () => {
    expect(nextRunAt({ kind: 'every', everyMs: HOUR }, 1_000_000)).toBe(1_000_000 + HOUR)
  })

  test('an interval keeps its phase and skips runs missed while down', () => {
    const rule = { kind: 'every' as const, everyMs: HOUR }
    const due = 10 * HOUR
    expect(nextRunAt(rule, due, due)).toBe(11 * HOUR)
    expect(nextRunAt(rule, due + 3.5 * HOUR, due)).toBe(14 * HOUR)
  })

  test('a daily run is later today, or tomorrow once the time has passed', () => {
    const rule = { kind: 'daily' as const, minuteOfDay: 9 * 60 }
    const morning = new Date(2026, 6, 15, 8, 30).getTime()
    const evening = new Date(2026, 6, 15, 18, 0).getTime()
    expect(nextRunAt(rule, morning)).toBe(new Date(2026, 6, 15, 9, 0).getTime())
    expect(nextRunAt(rule, evening)).toBe(new Date(2026, 6, 16, 9, 0).getTime())
    expect(nextRunAt(rule, new Date(2026, 6, 15, 9, 0).getTime())).toBe(new Date(2026, 6, 16, 9, 0).getTime())
  })
})

describe('describeRule', () => {
  test('names the rule the way it was typed', () => {
    expect(describeRule(spec('every 90m x'))).toBe('every 90m')
    expect(describeRule(spec('every 6h x'))).toBe('every 6h')
    expect(describeRule(spec('every 1d x'))).toBe('every 1d')
    expect(describeRule(spec('daily 7:05 x'))).toBe('daily at 07:05')
  })
})

describe('schedule storage', () => {
  test('due schedules come back in order, and advancing one takes it off the list', () => {
    const repo = new Repo(openDb(':memory:'))
    const a = repo.addSchedule('thread-1', spec('every 1h a'), 200)
    const b = repo.addSchedule('thread-1', spec('daily 09:00 b'), 100)
    repo.addSchedule('thread-2', spec('every 1h c'), 900)

    expect(repo.dueSchedules(500).map(s => s.id)).toEqual([b.id, a.id])
    repo.setScheduleNextRun(b.id, 1_000)
    expect(repo.dueSchedules(500).map(s => s.id)).toEqual([a.id])
    expect(ruleOf(repo.threadSchedules('thread-1')[1]!)).toEqual({ kind: 'daily', minuteOfDay: 540 })
  })

  test('a thread can only delete its own schedules', () => {
    const repo = new Repo(openDb(':memory:'))
    const row = repo.addSchedule('thread-1', spec('every 1h a'), 0)
    expect(repo.deleteSchedule(row.id, 'thread-2')).toBe(false)
    expect(repo.deleteSchedule(row.id, 'thread-1')).toBe(true)
    expect(repo.threadSchedules('thread-1')).toEqual([])
  })
})

describe('/schedule and /unschedule', () => {
  function setup() {
    const repo = new Repo(openDb(':memory:'))
    repo.createThread({
      thread_id: 'thread-1',
      channel_id: 'chan-1',
      root_message_id: 'msg-1',
      guild_id: 'guild-1',
      cc_session_id: null,
      cwd: '/home/agent',
      title: null,
      state: 'open',
      model: null,
      permission_mode: null,
      header_message_id: null,
    })
    const ctx = (conversationId: string) => ({ client: {} as Client, repo, conversationId })
    return { repo, ctx }
  }

  async function run(text: string, ctx: Parameters<typeof handleCommand>[1]): Promise<string> {
    const outcome = await handleCommand(text, ctx)
    if (!outcome.handled) throw new Error(`${text} was not handled`)
    return outcome.reply
  }

  test('needs a thread to run in', async () => {
    const { repo, ctx } = setup()
    expect(await run('/schedule every 1h x', ctx('chan-1'))).toContain('no conversation here yet')
    expect(repo.dueSchedules(Number.MAX_SAFE_INTEGER)).toEqual([])
  })

  test('adds, lists and stops a schedule', async () => {
    const { repo, ctx } = setup()
    const added = await run('/schedule every 6h check CI on main', ctx('thread-1'))
    expect(added).toContain('Schedule #1 runs every 6h')
    expect(added).toContain('<t:')

    const listed = await run('/schedule', ctx('thread-1'))
    expect(listed).toContain('#1')
    expect(listed).toContain('check CI on main')

    expect(await run('/unschedule 2', ctx('thread-1'))).toContain('no schedule #2')
    expect(await run('/unschedule #1', ctx('thread-1'))).toBe('Stopped schedule #1.')
    expect(repo.threadSchedules('thread-1')).toEqual([])
  })

  test('a bad rule explains itself and stores nothing', async () => {
    const { repo, ctx } = setup()
    expect(await run('/schedule every 1m x', ctx('thread-1'))).toContain('15 minutes')
    expect(await run('/unschedule soon', ctx('thread-1'))).toContain('/unschedule 3')
    expect(repo.threadSchedules('thread-1')).toEqual([])
  })
})
