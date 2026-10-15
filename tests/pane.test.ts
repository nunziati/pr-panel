import { describe, expect, test } from 'claude-code/testing'

import { parseArgs, repoFromRemote, threadEntries } from '../hooks/parse'

const PR = {
  number: 22,
  title: 'Windows: no console windows',
  body: 'Closes #20.\n\n## What\nHidden consoles.',
  state: 'open',
  draft: false,
  merged: false,
  html_url: 'https://github.com/acme/widgets/pull/22',
  user: { login: 'giacomo' },
  head: { ref: 'claude/issue-20' },
  base: { ref: 'main' },
  created_at: '2026-10-15T15:58:00Z',
}

const COMMENTS = [
  { body: 'Looks good, one question.', user: { login: 'alice' }, created_at: '2026-10-15T16:10:00Z' },
]

const REVIEWS = [
  { state: 'CHANGES_REQUESTED', body: 'Please add a test.', user: { login: 'bob' }, submitted_at: '2026-10-15T16:05:00Z' },
  { state: 'COMMENTED', body: '', user: { login: 'bob' }, submitted_at: '2026-10-15T16:06:00Z' },
]

const THREADS = {
  review_threads: [
    {
      is_resolved: true,
      is_outdated: false,
      comments: [
        { path: 'src/a.rs', line: 12, body: 'Typo here.', author: { login: 'bob' }, created_at: '2026-10-15T16:06:00Z' },
        { body: 'Fixed.', author: { login: 'giacomo' }, created_at: '2026-10-15T16:20:00Z' },
      ],
    },
  ],
}

const answers: Record<string, unknown> = {
  get: PR,
  get_comments: COMMENTS,
  get_reviews: REVIEWS,
  get_review_comments: THREADS,
}

const text = (value: unknown) => ({
  value: { content: [{ type: 'text', text: JSON.stringify(value) }], isError: false },
})

describe('parsing', () => {
  test('the command takes a number, a repository and a URL', async () => {
    expect(parseArgs('')).toEqual({ repo: null, number: null })
    expect(parseArgs('#22')).toEqual({ repo: null, number: 22 })
    expect(parseArgs('acme/widgets 7')).toEqual({ repo: 'acme/widgets', number: 7 })
    expect(parseArgs('acme/widgets#7')).toEqual({ repo: 'acme/widgets', number: 7 })
    expect(parseArgs('https://github.com/acme/widgets/pull/9')).toEqual({ repo: 'acme/widgets', number: 9 })
  })

  test('the repository comes from any kind of remote', async () => {
    expect(repoFromRemote('https://github.com/acme/widgets.git\n')).toBe('acme/widgets')
    expect(repoFromRemote('git@github.com:acme/widgets.git')).toBe('acme/widgets')
    expect(repoFromRemote('http://proxy@127.0.0.1:1234/git/acme/widgets')).toBe('acme/widgets')
  })

  test('a review thread keeps its place, its replies and whether it is resolved', async () => {
    const [thread] = threadEntries(THREADS)
    expect(thread?.label).toBe('src/a.rs:12')
    expect(thread?.isResolved).toBe(true)
    expect(thread?.replies.map(reply => reply.author)).toEqual(['giacomo'])
  })
})

test('the pane shows the description and the discussion in order', async ($, on) => {
  on('process.run', () => ({
    value: {
      exitCode: 0,
      stdout: 'https://github.com/acme/widgets.git\n',
      stderr: '',
      isStdoutTruncated: false,
      isStderrTruncated: false,
    },
  }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('mcp.call', ($, e) => {
    expect(e.server).toBe('github')
    expect(e.args.owner).toBe('acme')
    return text(answers[String(e.args.method)])
  })

  await $.command.run({
    command: 'pr-panel',
    args: '22',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 120 },
  })

  for (const surface of ['terminal', 'desktop', 'mobile'] as const) {
    const ui = await $.ui.mount({
      plugin: 'pr-panel',
      surface,
      component: 'Pane',
      requestId: 'pr-panel',
      props: {
        title: 'PR #22',
        isFocused: false,
        bodyColumns: 80,
        placement: 'dock',
        scroll: { offset: 0, bodyRows: 40 },
        view: {},
      },
    })
    expect(await ui.find({ text: /Windows: no console windows/ })).toBeDefined()
    expect(await ui.find({ type: 'Markdown', text: /Hidden consoles/ })).toBeDefined()
    expect(await ui.find({ text: /ha chiesto modifiche/ })).toBeDefined()
    expect(await ui.find({ text: /su src\/a\.rs:12/ })).toBeDefined()
    expect(await ui.find({ type: 'Markdown', text: /Fixed\./ })).toBeDefined()
    expect(await ui.find({ text: /Discussione \(3\)/ })).toBeDefined()
    await ui.unmount()
  }
})

const REST_REVIEW_COMMENTS = [
  { id: 1, path: 'src/b.rs', line: 3, body: 'Why here?', user: { login: 'bob' }, created_at: '2026-10-15T16:07:00Z' },
  { id: 2, in_reply_to_id: 1, body: 'Moved it.', user: { login: 'giacomo' }, created_at: '2026-10-15T16:21:00Z' },
]

const rest: Record<string, unknown> = {
  'repos/acme/widgets/pulls/22': PR,
  'repos/acme/widgets/issues/22/comments?per_page=100': COMMENTS,
  'repos/acme/widgets/pulls/22/reviews?per_page=100': REVIEWS,
  'repos/acme/widgets/pulls/22/comments?per_page=100': REST_REVIEW_COMMENTS,
}

test('without the MCP server the pane reads GitHub through gh api', async ($, on) => {
  const asked: string[] = []
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('mcp.call', () => ({ deny: 'no MCP server named github' }))
  on('process.run', ($, e) => {
    const [program, , path = ''] = e.argv
    const stdout =
      program === 'git' ? 'git@github.com:acme/widgets.git\n' : JSON.stringify(rest[path] ?? null)
    if (program === 'gh') asked.push(path)
    return {
      value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    }
  })

  await $.command.run({
    command: 'pr-panel',
    args: '22',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 120 },
  })

  expect(asked).toContain('repos/acme/widgets/pulls/22')
  const ui = await $.ui.mount({
    plugin: 'pr-panel',
    surface: 'desktop',
    component: 'Pane',
    requestId: 'pr-panel',
    props: {
      title: 'PR #22',
      isFocused: false,
      bodyColumns: 80,
      placement: 'dock',
      scroll: { offset: 0, bodyRows: 40 },
      view: {},
    },
  })
  expect(await ui.find({ text: /su src\/b\.rs:3/ })).toBeDefined()
  expect(await ui.find({ type: 'Markdown', text: /Moved it\./ })).toBeDefined()
  expect(await ui.find({ text: /Discussione \(3\)/ })).toBeDefined()
  await ui.unmount()
})
