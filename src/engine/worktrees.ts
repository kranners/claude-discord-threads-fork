import { execFile } from 'child_process'
import { existsSync } from 'fs'
import { appendFile, mkdir, readFile } from 'fs/promises'
import { dirname, join } from 'path'
import { promisify } from 'util'
import { describeError } from '../log'

const execFileAsync = promisify(execFile)

const WORKTREES_DIR = join('.claude', 'worktrees')
const MAX_SLUG_WORDS = 6
const MAX_SLUG_LENGTH = 48

export type ThreadWorkspace = { cwd: string; notice: string }

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', cwd, ...args])
  return stdout.trim()
}

export async function repoRoot(path: string): Promise<string | null> {
  try {
    return await git(path, 'rev-parse', '--show-toplevel')
  } catch {
    return null
  }
}

export function branchSlug(seed: string): string {
  const slug = seed
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .split('-')
    .filter(Boolean)
    .slice(0, MAX_SLUG_WORDS)
    .join('-')
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/, '')
  return slug || 'thread'
}

async function branchExists(repo: string, branch: string): Promise<boolean> {
  try {
    await git(repo, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`)
    return true
  } catch {
    return false
  }
}

async function unusedName(repo: string, base: string): Promise<string> {
  for (let n = 1; ; n++) {
    const name = n === 1 ? base : `${base}-${n}`
    const taken = existsSync(join(repo, WORKTREES_DIR, name)) || (await branchExists(repo, name))
    if (!taken) return name
  }
}

async function excludeWorktreesFromStatus(repo: string): Promise<void> {
  const commonDir = await git(repo, 'rev-parse', '--path-format=absolute', '--git-common-dir')
  const excludeFile = join(commonDir, 'info', 'exclude')
  const pattern = `/${WORKTREES_DIR}/`
  const current = await readFile(excludeFile, 'utf8').catch(() => '')
  if (current.split('\n').includes(pattern)) return
  await mkdir(dirname(excludeFile), { recursive: true })
  const separator = current && !current.endsWith('\n') ? '\n' : ''
  await appendFile(excludeFile, `${separator}${pattern}\n`)
}

export async function addThreadWorktree(
  repo: string,
  seed: string,
): Promise<{ path: string; branch: string }> {
  const branch = await unusedName(repo, branchSlug(seed))
  const path = join(repo, WORKTREES_DIR, branch)
  await excludeWorktreesFromStatus(repo)
  await git(repo, 'worktree', 'add', '-b', branch, path, 'HEAD')
  return { path, branch }
}

export async function threadWorkspace(
  project: string | null,
  seed: string,
): Promise<ThreadWorkspace | null> {
  if (!project) return null
  try {
    const { path, branch } = await addThreadWorktree(project, seed)
    return { cwd: path, notice: `🌿 Working in \`${path}\` on branch \`${branch}\`.` }
  } catch (err) {
    return {
      cwd: project,
      notice:
        `⚠️ Could not create a worktree (${describeError(err)}). ` +
        `Working in \`${project}\` directly.`,
    }
  }
}
