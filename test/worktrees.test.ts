import { test, expect, describe } from 'bun:test'
import { execFileSync } from 'child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { Client } from 'discord.js'
import { openDb } from '../src/store/db'
import { Repo } from '../src/store/repo'
import { handleCommand } from '../src/discord/commands'
import { addThreadWorktree, branchSlug, repoRoot, threadWorkspace } from '../src/engine/worktrees'

function gitRepo(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'dt-worktrees-')))
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' })
  git('init', '--quiet', '--initial-branch=main')
  writeFileSync(join(dir, 'README.md'), 'hello\n')
  git('add', 'README.md')
  git('-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '--quiet', '-m', 'init')
  return dir
}

function branches(repo: string): string[] {
  return execFileSync('git', ['-C', repo, 'branch', '--format=%(refname:short)'], { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
}

describe('branchSlug', () => {
  test('turns a message into a short kebab-case name', () => {
    expect(branchSlug('Fix the login bug on Safari!')).toBe('fix-the-login-bug-on-safari')
    expect(branchSlug('  why does `just check` fail on main, and what changed since Tuesday?  ')).toBe(
      'why-does-just-check-fail-on',
    )
  })

  test('falls back when nothing usable is left', () => {
    expect(branchSlug('')).toBe('thread')
    expect(branchSlug('🔥🔥🔥')).toBe('thread')
  })
})

describe('addThreadWorktree', () => {
  test('adds a worktree on a new branch under .claude/worktrees', async () => {
    const repo = gitRepo()
    const { path, branch } = await addThreadWorktree(repo, 'Add a dark mode toggle')

    expect(branch).toBe('add-a-dark-mode-toggle')
    expect(path).toBe(join(repo, '.claude', 'worktrees', 'add-a-dark-mode-toggle'))
    expect(readFileSync(join(path, 'README.md'), 'utf8')).toBe('hello\n')
    expect(branches(repo)).toContain('add-a-dark-mode-toggle')
  })

  test('picks a fresh name when the slug is taken', async () => {
    const repo = gitRepo()
    await addThreadWorktree(repo, 'same topic')
    const second = await addThreadWorktree(repo, 'same topic')
    expect(second.branch).toBe('same-topic-2')
  })

  test('keeps worktrees out of the main checkout status', async () => {
    const repo = gitRepo()
    await addThreadWorktree(repo, 'one')
    await addThreadWorktree(repo, 'two')
    const exclude = readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8')
    expect(exclude.split('\n').filter(line => line === '/.claude/worktrees/')).toHaveLength(1)
    const status = execFileSync('git', ['-C', repo, 'status', '--porcelain'], { encoding: 'utf8' })
    expect(status).toBe('')
  })
})

describe('threadWorkspace', () => {
  test('a channel with no project uses the default directory', async () => {
    expect(await threadWorkspace(null, 'anything')).toBeNull()
  })

  test('a project channel gets a worktree and says where', async () => {
    const repo = gitRepo()
    const workspace = await threadWorkspace(repo, 'Refactor the parser')
    expect(workspace?.cwd).toBe(join(repo, '.claude', 'worktrees', 'refactor-the-parser'))
    expect(workspace?.notice).toContain('refactor-the-parser')
  })

  test('a broken project still answers, in the repo itself, and says why', async () => {
    const notARepo = realpathSync(mkdtempSync(join(tmpdir(), 'dt-plain-')))
    const workspace = await threadWorkspace(notARepo, 'anything')
    expect(workspace?.cwd).toBe(notARepo)
    expect(workspace?.notice).toContain('Could not create a worktree')
  })
})

describe('/project', () => {
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

  test('binds the channel to the repository root, even from a subdirectory', async () => {
    const { repo, ctx } = setup()
    const git = gitRepo()
    mkdirSync(join(git, 'src'))
    await run(`/project ${join(git, 'src')}`, ctx('chan-1'))
    expect(repo.getProject('chan-1')).toBe((await repoRoot(git))!)
  })

  test('run inside a thread, it binds the parent channel', async () => {
    const { repo, ctx } = setup()
    const git = gitRepo()
    await run(`/project ${git}`, ctx('thread-1'))
    expect(repo.getProject('chan-1')).toBe(git)
    expect(repo.getProject('thread-1')).toBeNull()
  })

  test('refuses a directory outside any repository', async () => {
    const { repo, ctx } = setup()
    const plain = realpathSync(mkdtempSync(join(tmpdir(), 'dt-plain-')))
    const reply = await run(`/project ${plain}`, ctx('chan-1'))
    expect(reply).toContain('not inside a git repository')
    expect(repo.getProject('chan-1')).toBeNull()
  })

  test('shows and unbinds', async () => {
    const { repo, ctx } = setup()
    const git = gitRepo()
    expect(await run('/project', ctx('chan-1'))).toContain('no project')
    await run(`/project ${git}`, ctx('chan-1'))
    expect(await run('/project', ctx('chan-1'))).toContain(git)
    await run('/project none', ctx('chan-1'))
    expect(repo.getProject('chan-1')).toBeNull()
  })
})
