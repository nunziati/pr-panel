/** One message in a pull request's discussion, in the order it was written. */
export type Entry = {
  kind: 'comment' | 'review' | 'thread'
  author: string
  /** ISO timestamp the entry was written. */
  at: string
  /** For a review its verdict, for a thread `path:line`. */
  label: string
  body: string
  /** Replies of a review thread after its first comment. */
  replies: Reply[]
  isResolved: boolean
  isOutdated: boolean
  url: string | null
}

export type Reply = { author: string; at: string; body: string }

export type PullRequest = {
  repo: string
  number: number
  title: string
  state: string
  isDraft: boolean
  isMerged: boolean
  author: string
  head: string
  base: string
  url: string
  body: string
  createdAt: string
  entries: Entry[]
}

export type Summary = {
  number: number
  title: string
  author: string
  isDraft: boolean
  updatedAt: string
}

export type Screen = {
  mode: 'list' | 'pr'
  repo: string | null
  number: number | null
  list: Summary[]
  pr: PullRequest | null
  isLoading: boolean
  error: string | null
  loadedAt: string | null
}

declare module 'claude-code' {
  interface PluginState {
    'pr-panel': { screen: Screen }
  }
}
