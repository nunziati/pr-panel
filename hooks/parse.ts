import type { Entry, PullRequest, Reply, Summary } from '../types'

type Json = Record<string, unknown>

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const text = (value: unknown): string => (typeof value === 'string' ? value : '')

/** The first of `keys` that holds a string, or `""`. */
const pick = (object: Json, ...keys: string[]): string => {
  for (const key of keys) {
    if (typeof object[key] === 'string') return object[key] as string
  }
  return ''
}

const flag = (object: Json, ...keys: string[]): boolean =>
  keys.some(key => object[key] === true)

/** A login wherever the GitHub REST or GraphQL shape puts it. */
const login = (object: Json): string => {
  for (const key of ['user', 'author']) {
    const who = object[key]
    if (isObject(who) && typeof who.login === 'string') return who.login
    if (typeof who === 'string') return who
  }
  return 'unknown'
}

/** An array, or the `nodes` of a GraphQL connection, or nothing. */
const list = (value: unknown): unknown[] => {
  if (Array.isArray(value)) return value
  if (isObject(value) && Array.isArray(value.nodes)) return value.nodes
  return []
}

/** `owner/repo` from a git remote URL (https, ssh or a proxy path), or null. */
export const repoFromRemote = (remote: string): string | null => {
  const match = remote.trim().match(/[/:]([^/:]+)\/([^/]+?)(?:\.git)?\/?$/)
  return match ? `${match[1]}/${match[2]}` : null
}

export type Target = { repo: string | null; number: number | null }

/**
 * What `/pr-panel` was asked for: `22`, `owner/repo 22`, `owner/repo#22`,
 * a pull request URL, or nothing (the list).
 */
export const parseArgs = (args: string): Target => {
  const target: Target = { repo: null, number: null }
  for (const word of args.trim().split(/\s+/).filter(Boolean)) {
    const url = word.match(/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/)
    const short = word.match(/^([\w.-]+\/[\w.-]+)#(\d+)$/)
    if (url || short) {
      const [, repo = null, number] = (url ?? short) as RegExpMatchArray
      target.repo = repo
      target.number = Number(number)
    } else if (/^#?\d+$/.test(word)) {
      target.number = Number(word.replace('#', ''))
    } else if (/^[\w.-]+\/[\w.-]+$/.test(word)) {
      target.repo = word
    }
  }
  return target
}

/** The JSON a GitHub MCP tool answered with, from its first text block. */
export const json = (content: readonly unknown[]): unknown => {
  for (const block of content) {
    if (isObject(block) && block.type === 'text' && typeof block.text === 'string') {
      return JSON.parse(block.text)
    }
  }
  throw new Error('GitHub answered with no text')
}

export const toSummaries = (answer: unknown): Summary[] =>
  list(answer)
    .filter(isObject)
    .map(pr => ({
      number: Number(pr.number),
      title: pick(pr, 'title'),
      author: login(pr),
      isDraft: flag(pr, 'draft', 'isDraft'),
      updatedAt: pick(pr, 'updated_at', 'updatedAt'),
    }))

export const toPullRequest = (repo: string, answer: unknown): Omit<PullRequest, 'entries'> => {
  const pr = isObject(answer) ? answer : {}
  const ref = (side: string) => (isObject(pr[side]) ? pick(pr[side] as Json, 'ref') : '')
  return {
    repo,
    number: Number(pr.number),
    title: pick(pr, 'title'),
    state: pick(pr, 'state'),
    isDraft: flag(pr, 'draft'),
    isMerged: flag(pr, 'merged'),
    author: login(pr),
    head: ref('head'),
    base: ref('base'),
    url: pick(pr, 'html_url', 'url'),
    body: text(pr.body),
    createdAt: pick(pr, 'created_at', 'createdAt'),
  }
}

const entry = (fields: Partial<Entry> & Pick<Entry, 'kind' | 'author' | 'at'>): Entry => ({
  label: '',
  body: '',
  replies: [],
  isResolved: false,
  isOutdated: false,
  url: null,
  ...fields,
})

export const commentEntries = (answer: unknown): Entry[] =>
  list(answer)
    .filter(isObject)
    .map(comment =>
      entry({
        kind: 'comment',
        author: login(comment),
        at: pick(comment, 'created_at', 'createdAt'),
        body: text(comment.body),
        url: pick(comment, 'html_url', 'url') || null,
      }),
    )

/** Reviews with a verdict or a text; a bare "commented" review only carries threads. */
export const reviewEntries = (answer: unknown): Entry[] =>
  list(answer)
    .filter(isObject)
    .filter(review => text(review.body).trim() !== '' || pick(review, 'state') !== 'COMMENTED')
    .map(review =>
      entry({
        kind: 'review',
        author: login(review),
        at: pick(review, 'submitted_at', 'submittedAt', 'created_at'),
        label: pick(review, 'state'),
        body: text(review.body),
        url: pick(review, 'html_url', 'url') || null,
      }),
    )

/**
 * The REST API's review comments are flat, each reply naming the comment it
 * answers: grouped here into threads shaped like the MCP server's.
 */
const groupReplies = (comments: Json[]): Json[] => {
  const threads = new Map<unknown, Json[]>()
  for (const comment of comments) {
    const root = comment.in_reply_to_id ?? comment.id
    threads.set(root, [...(threads.get(root) ?? []), comment])
  }
  return [...threads.values()].map(group => ({ comments: group }))
}

export const threadEntries = (answer: unknown): Entry[] => {
  const threads = isObject(answer)
    ? list(answer.review_threads ?? answer.reviewThreads ?? answer.threads)
    : groupReplies(list(answer).filter(isObject))
  return threads.filter(isObject).flatMap(thread => {
    const comments = list(thread.comments).filter(isObject)
    const [first, ...rest] = comments
    if (!first) return []
    const path = pick(thread, 'path') || pick(first, 'path')
    const line = thread.line ?? thread.original_line ?? first.line ?? first.original_line
    const replies: Reply[] = rest.map(reply => ({
      author: login(reply),
      at: pick(reply, 'created_at', 'createdAt'),
      body: text(reply.body),
    }))
    return [
      entry({
        kind: 'thread',
        author: login(first),
        at: pick(first, 'created_at', 'createdAt'),
        label: typeof line === 'number' ? `${path}:${line}` : path,
        body: text(first.body),
        replies,
        isResolved: flag(thread, 'is_resolved', 'isResolved'),
        isOutdated: flag(thread, 'is_outdated', 'isOutdated'),
        url: pick(first, 'html_url', 'url') || null,
      }),
    ]
  })
}

/** Every entry, oldest first. */
export const discussion = (...groups: Entry[][]): Entry[] =>
  groups.flat().sort((a, b) => a.at.localeCompare(b.at))

/** `15 ott, 18:37` in Italian time, or the timestamp as given. */
export const when = (iso: string): string => {
  if (!iso) return ''
  try {
    return new Date(iso).toLocaleString('it-IT', {
      timeZone: 'Europe/Rome',
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return iso.replace('T', ' ').slice(0, 16)
  }
}
