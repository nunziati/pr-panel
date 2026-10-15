import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Entry, Screen } from '../types'
import {
  commentEntries,
  discussion,
  json,
  parseArgs,
  repoFromRemote,
  reviewEntries,
  threadEntries,
  toPullRequest,
  toSummaries,
  when,
} from './parse'

const PANE = 'pr-panel'
const SERVER = 'github'
const REFRESH_MS = 120_000
/** A drawing holds at most 100000 characters; leave room for the frame. */
const MAX_BODY = 6000

const empty: Screen = {
  mode: 'list',
  repo: null,
  number: null,
  list: [],
  pr: null,
  isLoading: false,
  error: null,
  loadedAt: null,
}
const screen = atom({ plugin: 'pr-panel', key: 'screen' } as const, empty)

const verdicts: Record<string, string> = {
  APPROVED: 'ha approvato',
  CHANGES_REQUESTED: 'ha chiesto modifiche',
  COMMENTED: 'ha commentato',
  DISMISSED: 'revisione annullata',
  PENDING: 'revisione in sospeso',
}

const clip = (body: string) =>
  body.length > MAX_BODY ? `${body.slice(0, MAX_BODY)}\n\n_… (testo tagliato)_` : body

/** Which way to GitHub works here: the session's MCP server, else the `gh` CLI. */
let route: 'mcp' | 'gh' | null = null

/**
 * One GitHub read: the MCP tool where the session has the server (a cloud
 * session), the same data through `gh api` where it doesn't (a local one).
 */
const github = async (
  $: EngineInterface,
  tool: string,
  args: Record<string, unknown>,
  rest: string,
): Promise<unknown> => {
  if (route !== 'gh') {
    let answer
    try {
      answer = await $.mcp.call(SERVER, tool, args)
      route = 'mcp'
    } catch (error) {
      if (route === 'mcp') throw error
      route = 'gh'
    }
    if (answer) {
      if (answer.isError) {
        const reason = answer.content
          .map(block => ('text' in block && typeof block.text === 'string' ? block.text : ''))
          .join(' ')
        throw new Error(reason || `${tool} failed`)
      }
      return json(answer.content)
    }
  }
  let ran
  try {
    ran = await $.process.run(['gh', 'api', rest], { timeoutMs: 30_000 })
  } catch {
    route = null
    throw new Error(
      `Non raggiungo GitHub: nessun server MCP "${SERVER}" e la CLI gh non parte (installala e fai gh auth login).`,
    )
  }
  if (ran.exitCode !== 0) throw new Error(ran.stderr.trim() || `gh api ${rest} failed`)
  return JSON.parse(ran.stdout)
}

/** The repository of the session's checkout, from its `origin` remote. */
const sessionRepo = async ($: EngineInterface): Promise<string | null> => {
  try {
    const { exitCode, stdout } = await $.process.run(['git', 'remote', 'get-url', 'origin'])
    return exitCode === 0 ? repoFromRemote(stdout) : null
  } catch {
    return null
  }
}

const load = async ($: EngineInterface) => {
  const now = await read($, screen)
  const repo = now.repo ?? (await sessionRepo($))
  if (!repo) {
    await update($, screen, s => ({
      ...s,
      error: 'Non trovo il repository: scrivi /pr-panel owner/repo 22',
    }))
    return
  }
  const [owner, name] = repo.split('/')
  await update($, screen, s => ({ ...s, repo, isLoading: true, error: null }))
  try {
    if (now.mode === 'pr' && now.number !== null) {
      const base = { owner, repo: name, pullNumber: now.number }
      const pulls = `repos/${repo}/pulls/${now.number}`
      const tool = 'pull_request_read'
      // The first call settles the route before the others run.
      const pr = await github($, tool, { ...base, method: 'get' }, pulls)
      const [comments, reviews, threads] = await Promise.all([
        github($, tool, { ...base, method: 'get_comments', perPage: 100 },
          `repos/${repo}/issues/${now.number}/comments?per_page=100`),
        github($, tool, { ...base, method: 'get_reviews', perPage: 100 },
          `${pulls}/reviews?per_page=100`),
        github($, tool, { ...base, method: 'get_review_comments', perPage: 100 },
          `${pulls}/comments?per_page=100`),
      ])
      const entries = discussion(
        commentEntries(comments),
        reviewEntries(reviews),
        threadEntries(threads),
      )
      await update($, screen, s => ({ ...s, pr: { ...toPullRequest(repo, pr), entries } }))
    } else {
      const prs = await github(
        $,
        'list_pull_requests',
        { owner, repo: name, state: 'open', perPage: 30 },
        `repos/${repo}/pulls?state=open&per_page=30`,
      )
      await update($, screen, s => ({ ...s, list: toSummaries(prs) }))
    }
    const loadedAt = new Date(await $.clock.now()).toISOString()
    await update($, screen, s => ({ ...s, isLoading: false, loadedAt }))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await update($, screen, s => ({ ...s, isLoading: false, error: message.slice(0, 500) }))
  }
}

const show = async ($: EngineInterface, change: Partial<Screen>) => {
  await update($, screen, s => ({ ...s, ...change, error: null }))
  const s = await read($, screen)
  const title = s.mode === 'pr' && s.number !== null ? `PR #${s.number}` : 'Pull request aperte'
  const opened = await $.ui.open({ id: PANE, title })
  await load($)
  return opened.isPlaced ? '' : ` Il pannello non è disegnato: ${opened.reason}`
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'pr-panel',
      description: 'Mostra descrizione e discussione di una PR (/pr-panel 22) o l’elenco (/pr-panel)',
    })
    // A pane open on a PR follows its discussion while the session runs.
    $.clock.every(REFRESH_MS, () => {
      void (async () => {
        const panes = await $.ui.panes()
        const s = await read($, screen)
        if (s.mode === 'pr' && !s.isLoading && panes.some(p => p.id === PANE)) await load($)
      })()
    })
    return next(e)
  })

  on('command.run', { command: 'pr-panel' }, async ($, e) => {
    const target = parseArgs(e.args)
    const now = await read($, screen)
    const repo = target.repo ?? now.repo
    if (target.number !== null) {
      const isOther = target.number !== now.number || repo !== now.repo
      const why = await show($, {
        mode: 'pr',
        repo,
        number: target.number,
        ...(isOther ? { pr: null } : {}),
      })
      return { text: `Pannello aperto sulla PR #${target.number}.${why}` }
    }
    const why = await show($, { mode: 'list', repo })
    return { text: `Pannello aperto sulle pull request aperte.${why}` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Link, Markdown } = $.ui.resolve(e)
    const s = await read($, screen)

    const toolbar = (
      <Box flexDirection="row" gap={1}>
        <Button key="refresh" label="Aggiorna" hotkey="r" onPress={() => load($)} />
        {s.mode === 'pr' && (
          <Button key="list" label="Elenco PR" hotkey="l" onPress={() => show($, { mode: 'list' })} />
        )}
        <Text dimColor>
          {s.isLoading ? 'carico…' : s.loadedAt ? `aggiornato ${when(s.loadedAt)}` : ''}
        </Text>
      </Box>
    )
    const error = s.error && <Text color="red">{s.error}</Text>

    if (s.mode === 'list') {
      return (
        <Box flexDirection="column" gap={1}>
          {toolbar}
          {error}
          <Text bold>Pull request aperte{s.repo ? ` in ${s.repo}` : ''}</Text>
          {!s.isLoading && s.list.length === 0 && <Text dimColor>Nessuna pull request aperta.</Text>}
          {s.list.map(pr => (
            <Button
              key={`pr-${pr.number}`}
              plain
              onPress={() => show($, { mode: 'pr', number: pr.number, pr: null })}
            >
              #{pr.number} {pr.title}{' '}
              <Text dimColor>
                {pr.isDraft ? 'bozza · ' : ''}
                {when(pr.updatedAt)}
              </Text>
            </Button>
          ))}
        </Box>
      )
    }

    const pr = s.pr
    if (!pr) {
      return (
        <Box flexDirection="column" gap={1}>
          {toolbar}
          {error}
          <Text dimColor>Carico la PR #{s.number}…</Text>
        </Box>
      )
    }

    const state = pr.isMerged ? 'unita' : pr.state === 'closed' ? 'chiusa' : pr.isDraft ? 'bozza' : 'aperta'
    const message = (entry: Entry, index: number) => {
      const what =
        entry.kind === 'review'
          ? verdicts[entry.label] ?? entry.label.toLowerCase()
          : entry.kind === 'thread'
            ? `su ${entry.label}`
            : 'ha commentato'
      const tags = [
        entry.isResolved ? 'risolto' : '',
        entry.isOutdated ? 'superato' : '',
      ].filter(Boolean)
      return (
        <Box key={`entry-${index}`} flexDirection="column" borderStyle="round" paddingX={1}>
          <Text>
            <Text bold>{entry.author}</Text> {what}{' '}
            <Text dimColor>
              {when(entry.at)}
              {tags.length > 0 ? ` · ${tags.join(', ')}` : ''}
            </Text>
          </Text>
          {entry.body.trim() !== '' && <Markdown text={clip(entry.body)} dimColor={entry.isResolved} />}
          {entry.replies.map((reply, n) => (
            <Box key={`reply-${index}-${n}`} flexDirection="column" paddingLeft={2} marginTop={1}>
              <Text>
                <Text bold>{reply.author}</Text> <Text dimColor>{when(reply.at)}</Text>
              </Text>
              <Markdown text={clip(reply.body)} dimColor={entry.isResolved} />
            </Box>
          ))}
        </Box>
      )
    }

    return (
      <Box flexDirection="column" gap={1}>
        {toolbar}
        {error}
        <Text bold>
          #{pr.number} {pr.title}
        </Text>
        <Text dimColor>
          {state} · {pr.author} · {pr.head} → {pr.base} · aperta {when(pr.createdAt)}
        </Text>
        {pr.url !== '' && <Link href={pr.url} label="Apri su GitHub" />}
        <Text bold>Descrizione</Text>
        <Markdown text={pr.body.trim() === '' ? '_Nessuna descrizione._' : clip(pr.body)} />
        <Text bold>Discussione ({pr.entries.length})</Text>
        {pr.entries.length === 0 && <Text dimColor>Ancora nessun commento né revisione.</Text>}
        {pr.entries.map(message)}
      </Box>
    )
  })
}
