// Host half of the desktop product plugins:
//   1. registers the durable `compaction` settings namespace backing the
//      composer tool-row threshold control and the compaction-basic backend's
//      per-measurement override;
//   2. keeps a per-turn journal of fs-tool mutations (snapshot before
//      write/edit) and exposes a revert gateway over the main-process IPC:
//      edit-resend can roll back the replaced turns' file changes, and the
//      turn tail offers a standalone per-turn 撤销修改.
import z from '@deepseek-ai/schemastery'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import { unlinkSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

/** The durable compaction settings namespace (plain string: settingsNamespace is a brand-only passthrough). */
export const COMPACTION_SETTINGS_NAMESPACE = settingsNamespace('compaction')

/** Valid user range: 10%..90% of the context window. */
export const COMPACTION_THRESHOLD_MIN = 0.1
export const COMPACTION_THRESHOLD_MAX = 0.9

/**
 * The per-session fs-mutation journal shared by the fs-revert gateway and the
 * file-changes panel. `sessionId -> Map<turn, Map<targetKey, snapshot>>` where
 * each snapshot is the file's PRE-mutation state at its first touch of that
 * turn: `{ target, path, existed, content }`. Module-level so the pure
 * aggregation helpers are unit-testable without booting the profile.
 */
export const fsJournals = new Map()

/**
 * Simple line diff: additions/deletions between two texts. Bounded LCS DP;
 * beyond the cell cap, raw line counts are reported (an approximation that
 * never under-reports either direction).
 * @param oldText - the baseline text.
 * @param newText - the current text.
 * @returns `{ additions, deletions }` in lines.
 */
export function lineDiff(oldText, newText) {
  const a = String(oldText ?? '').split(/\r?\n/)
  const b = String(newText ?? '').split(/\r?\n/)
  if (a[a.length - 1] === '') a.pop()
  if (b[b.length - 1] === '') b.pop()
  if (a.length === 0) return { additions: b.length, deletions: 0 }
  if (b.length === 0) return { additions: 0, deletions: a.length }
  if (a.length * b.length > 1_000_000) return { additions: b.length, deletions: a.length }
  const n = a.length
  const m = b.length
  const width = m + 1
  const dp = new Uint32Array((n + 1) * width)
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * width + j] = a[i] === b[j]
        ? dp[(i + 1) * width + j + 1] + 1
        : Math.max(dp[(i + 1) * width + j], dp[i * width + j + 1])
    }
  }
  let i = 0
  let j = 0
  let additions = 0
  let deletions = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      i++
      j++
    } else if (dp[(i + 1) * width + j] >= dp[i * width + j + 1]) {
      i++
      deletions++
    } else {
      j++
      additions++
    }
  }
  additions += m - j
  deletions += n - i
  return { additions, deletions }
}


/** Largest LCS DP this diff renderer will build before falling back to stats-only. */
const DIFF_DP_CELL_CAP = 600_000

/** Longest diff render output before truncating. */
const DIFF_OPS_CAP = 6_000

/**
 * Unified-diff hunks for the right-side Git-style file changes panel.
 */
export function diffHunks(oldText, newText, context = 3) {
  const a = String(oldText ?? '').split(/\r?\n/)
  const b = String(newText ?? '').split(/\r?\n/)
  if (a[a.length - 1] === '') a.pop()
  if (b[b.length - 1] === '') b.pop()
  const truncated = a.length * b.length > DIFF_DP_CELL_CAP
  if (truncated) return { additions: b.length, deletions: a.length, truncated: true, hunks: [] }
  if (a.length === 0 && b.length === 0) return { additions: 0, deletions: 0, truncated: false, hunks: [] }
  const n = a.length
  const m = b.length
  const width = m + 1
  const dp = new Uint32Array((n + 1) * width)
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * width + j] = a[i] === b[j]
        ? dp[(i + 1) * width + j + 1] + 1
        : Math.max(dp[(i + 1) * width + j], dp[i * width + j + 1])
    }
  }
  const ops = []
  let i = 0
  let j = 0
  let additions = 0
  let deletions = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ kind: 'context', text: a[i] })
      i++
      j++
    } else if (dp[(i + 1) * width + j] >= dp[i * width + j + 1]) {
      ops.push({ kind: 'del', text: a[i] })
      i++
      deletions++
    } else {
      ops.push({ kind: 'add', text: b[j] })
      j++
      additions++
    }
    if (ops.length >= DIFF_OPS_CAP && (i < n || j < m)) return { additions, deletions, truncated: true, hunks: [] }
  }
  while (i < n) {
    ops.push({ kind: 'del', text: a[i] })
    i++
    deletions++
    if (ops.length >= DIFF_OPS_CAP) return { additions, deletions, truncated: true, hunks: [] }
  }
  while (j < m) {
    ops.push({ kind: 'add', text: b[j] })
    j++
    additions++
    if (ops.length >= DIFF_OPS_CAP) return { additions, deletions, truncated: true, hunks: [] }
  }
  const changed = new Set()
  ops.forEach((op, index) => { if (op.kind !== 'context') changed.add(index) })
  const hunks = []
  let cursor = 0
  while (cursor < ops.length) {
    let nextChange = cursor
    while (nextChange < ops.length && !changed.has(nextChange)) nextChange++
    if (nextChange >= ops.length) break
    const start = Math.max(0, nextChange - context)
    let end = nextChange
    while (end < ops.length && changed.has(end)) end++
    end = Math.min(ops.length, end + context)
    hunks.push({ lines: ops.slice(start, end) })
    cursor = end
  }
  return { additions, deletions, truncated: false, hunks }
}

/** Parse git status --porcelain=v1 -z. Renames report the NEW path as path. */
export function parseGitStatusZ(output) {
  const parts = String(output ?? '').split('\0')
  const entries = []
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index]
    if (part === undefined || part.length < 4) continue
    const code = part.slice(0, 2)
    const path = part.slice(3)
    if (path === '') continue
    const next = parts[index + 1]
    if ((code.startsWith('R') || code.startsWith('C')) && next !== undefined && next !== '') {
      entries.push({ code, path: next, origPath: path })
      index++
    } else {
      entries.push({ code, path })
    }
  }
  return entries
}

/**
 * Baseline snapshots of every pending file of one session. The EARLIEST turn
 * wins per file: its snapshot is the state before ANY of the session's
 * changes to that file (first mutation of the file in the earliest turn).
 * @param journals - the shared fs journal (see {@link fsJournals}).
 * @param sessionId - the session id.
 * @returns `Map<targetKey, snapshot>` in earliest-turn order.
 */
export function pendingFilesOf(journals, sessionId) {
  const files = new Map()
  const bySession = journals.get(sessionId)
  if (!bySession) return files
  for (const turn of [...bySession.keys()].sort((left, right) => left - right)) {
    const turnFiles = bySession.get(turn)
    if (!turnFiles) continue
    for (const [targetKey, snapshot] of turnFiles) {
      if (!files.has(targetKey)) files.set(targetKey, snapshot)
    }
  }
  return files
}

/**
 * Resolve the fork anchor for an edit-and-resend: the seq of the `turn/end`
 * of the completed turn BEFORE the one containing `messageSeq`. The wire
 * `session.fork` cuts at the first `turn/end` at or after its `atSeq`, so
 * this anchor makes the child = [everything before the edited turn] — the
 * edited message and its whole reply (plus any later turns) fall away, which
 * is exactly what edit-and-resend means. A message opening the FIRST turn has
 * no prior completed turn (an empty child cannot be forked), reported as
 * `{ ok: false, error: 'first-turn' }` so the client can rewind to a fresh
 * blank session instead.
 * @param session - the live session.
 * @param messageSeq - the edited user message's event seq (client node.anchorSeq).
 * @returns `{ ok: true, atSeq }`, `{ ok: false, error: 'first-turn' }`, or a
 *   validation error.
 */
export function forkAnchorBeforeMessage(session, messageSeq) {
  const events = session.events
  if (!Number.isSafeInteger(messageSeq) || messageSeq < 0 || messageSeq >= events.length) {
    return { ok: false, error: 'invalid-message-seq' }
  }
  // The turn containing the message: the nearest turn/start at or before it.
  let turnStart = -1
  for (let i = messageSeq; i >= 0; i--) {
    if (events[i]?.type === 'turn/start') {
      turnStart = i
      break
    }
  }
  if (turnStart === -1) return { ok: false, error: 'message-not-in-turn' }
  // The nearest turn/end BEFORE that turn's start: the prior completed turn.
  for (let i = turnStart - 1; i >= 0; i--) {
    if (events[i]?.type === 'turn/end') return { ok: true, atSeq: events[i].seq }
  }
  // No completed turn precedes the edited turn: the message opens turn 0.
  return { ok: false, error: 'first-turn' }
}

/**
 * Replace one finalized user message on the model surface with the edited
 * text, IN PLACE, in the SAME session — no fork, no new dialog. The session
 * log stays append-only: a new `user/message` event with a positional
 * `surfaceOp: replace` shadows the original node, so every later request's
 * derived history (`session.deriveMessages()`, the sole context source the
 * agent loop feeds the model from) reads the edited wording, while the
 * human transcript keeps the append-origin message (the renderer overlay
 * shows the edited copy).
 *
 * The replaced range is the single surface node of this message, so a reply
 * that followed it stays in place — editing "1" to "2" and then sending a
 * new message at the bottom reads as [2, reply-to-1, new-message]. This is
 * the "stage the edit" path (clicking elsewhere); the 发送 path uses
 * {@link forkAnchorBeforeMessage} to rewind and resend instead.
 *
 * Exported separately from `apply` so the pure logic is unit-testable
 * without booting the profile; `apply` wires it behind the IPC handler.
 *
 * @param sessions - the host SessionStore (`ctx.get('sessions')`).
 * @param sessionId - the live session id.
 * @param messageId - the message id the surface node carries (client node.id).
 * @param text - the edited prompt text; the text block is dropped when blank.
 * @returns `{ ok: true, seq }` or `{ ok: false, error }`.
 */
export function applyConversationEdit(sessions, sessionId, messageId, text) {
  if (!sessions || typeof sessions.get !== 'function') {
    return { ok: false, error: 'sessions-service-unavailable' }
  }
  const session = sessions.get(sessionId)
  if (!session) return { ok: false, error: 'session-not-found' }
  const surface = session.surface
  if (!surface || !Array.isArray(surface.nodes)) {
    return { ok: false, error: 'surface-unavailable' }
  }
  // Locate the CURRENT surface node for this message. After a previous edit
  // the surface node is the replacement event (same message id), not the
  // original append-origin event, so re-editing stays accurate; a message
  // already shadowed by compaction is not editable.
  let target
  for (const seq of surface.nodes) {
    const event = session.events[seq]
    if (event && event.type === 'user/message' && event.data && event.data.id === messageId) {
      target = event
      break
    }
  }
  if (!target) return { ok: false, error: 'message-not-editable' }
  const original = target.data
  const blocks = Array.isArray(original.content) ? original.content : []
  const content = [
    ...blocks.filter(block => block && block.type === 'image'),
    ...(typeof text === 'string' && text.trim() !== '' ? [{ type: 'text', text }] : []),
  ]
  const replacement = { ...original, content }
  try {
    const logged = session.append('user/message', replacement, {
      surfaceOp: { op: 'replace', start: target.seq, end: target.seq },
      sourceEventSeqs: [target.seq],
    })
    return { ok: true, seq: logged.seq }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * The desktop product surface plugin body.
 * @param ctx - the host context (desktop main process profile boot).
 */
export function apply(ctx) {
  // ── compaction threshold settings namespace ───────────────────────────────
  // Registered WITHOUT a default: an absent section means "not configured", so
  // the backend keeps its composition config until the user picks a threshold.
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.register(COMPACTION_SETTINGS_NAMESPACE, z.object({
      thresholdRatio: z.number(),
    }), {
      validate(value) {
        const ratio = value.thresholdRatio
        // The section starts empty ("not configured"); only a SET value must
        // fall inside the user range.
        if (ratio === undefined) return
        if (typeof ratio !== 'number' || ratio < COMPACTION_THRESHOLD_MIN || ratio > COMPACTION_THRESHOLD_MAX) {
          throw new Error(`compaction thresholdRatio must be ${String(COMPACTION_THRESHOLD_MIN)}..${String(COMPACTION_THRESHOLD_MAX)}, got ${String(ratio)}`)
        }
      },
    })
  })

  // ── per-turn fs mutation journal ───────────────────────────────────────────
  // The map itself lives at module level (fsJournals) so the pure aggregation
  // helpers are unit-testable; this apply binds the local name for brevity.
  const journals = fsJournals
  /** sessionId -> { cwd, files } for Git-backed pending changes. */
  const gitPending = new Map()
  const gitKept = new Map()
  const execFileAsync = promisify(execFile)
  /** sessionId -> current turn index, advanced on turn/start events. */
  const turnBySession = new Map()
  /** True while the revert gateway is writing restored content back. */
  let restoring = false

  const turnOf = (session) => turnBySession.get(session.id) ?? 0

  const safeProcessPath = (target) => {
    try {
      return ctx.fs.processPath(target)
    } catch {
      return undefined
    }
  }

  /** Snapshot one target's pre-mutation state into the current turn's entry. */
  async function snapshotFile(target, actor) {
    if (restoring) return
    const session = actor && actor.agent && actor.agent.session
    if (!session) return
    let existed = true
    let content = ''
    try {
      const info = await ctx.fs.stat(target)
      if (info === undefined) {
        existed = false
      } else {
        content = await ctx.fs.readText(target)
      }
    } catch {
      // Unreadable/racy targets are skipped; the mutation itself must never
      // be blocked by the journal.
      return
    }
    let bySession = journals.get(session.id)
    if (!bySession) {
      bySession = new Map()
      journals.set(session.id, bySession)
    }
    const turn = turnOf(session)
    let files = bySession.get(turn)
    if (!files) {
      files = new Map()
      bySession.set(turn, files)
    }
    // First mutation of the file in this turn wins: that snapshot IS the
    // file's state at the start of the turn's changes.
    if (!files.has(target.targetKey)) {
      files.set(target.targetKey, { target, path: safeProcessPath(target), existed, content })
    }
  }

  // Transparent waterfall participants: snapshot, then compose (`return next()`)
  // so policy listeners and the write itself are untouched. `fs/write-intent`
  // and `fs/edit-intent` are single-slot waterfalls: the base composition's
  // observation-policy listener deliberately does NOT call next(), so these
  // journal listeners must be prepended. Otherwise every registered policy
  // vetoes the rest of the chain and non-git workspaces never record a file.
  ctx.on('fs/write-intent', async (target, actor, next) => {
    await snapshotFile(target, actor)
    return next()
  }, true)
  ctx.on('fs/edit-intent', async (target, actor, next) => {
    await snapshotFile(target, actor)
    return next()
  }, true)

  // Advance the per-session turn counter from the turn boundary. The
  // `user/message` payload carries no turn number; `turn/start` is the event
  // that owns it and always precedes the turn's tool calls.
  ctx.on('session/event', (session, event) => {
    if (event.type !== 'turn/start') return
    const turn = event.data?.turn
    if (typeof turn === 'number') turnBySession.set(session.id, turn)
  })

  /** Summarize one session's journal for the manager UI. */
  function listTurns(sessionId) {
    const bySession = journals.get(sessionId)
    if (!bySession) return []
    const rows = []
    for (const [turn, files] of bySession) {
      rows.push({
        turn,
        files: [...files.values()].map((snapshot) => ({ path: snapshot.path, existed: snapshot.existed })),
      })
    }
    rows.sort((left, right) => left.turn - right.turn)
    return rows
  }

  /**
   * Restore the journaled snapshots of turns [fromTurn, toTurn]. Restoring in
   * reverse turn order makes the EARLIEST snapshot (the pre-turn-fromTurn
   * state) win for any file touched by several reverted turns.
   * @param sessionId - the session whose journal is reverted.
   * @param fromTurn - first turn to revert (inclusive).
   * @param toTurn - last turn to revert (inclusive); defaults to fromTurn.
   * @returns the number of restored files.
   */
  async function revertSession(sessionId, fromTurn, toTurn = fromTurn) {
    const bySession = journals.get(sessionId)
    if (!bySession) return { restored: 0 }
    const snapshots = []
    for (const [turn, files] of bySession) {
      if (turn < fromTurn || turn > toTurn) continue
      for (const snapshot of files.values()) snapshots.push({ turn, ...snapshot })
    }
    snapshots.sort((left, right) => right.turn - left.turn)
    restoring = true
    let restored = 0
    try {
      for (const snapshot of snapshots) {
        try {
          if (snapshot.existed) {
            await ctx.fs.writeText(snapshot.target, snapshot.content)
          } else if (snapshot.path !== undefined) {
            // The file did not exist before the turn: revert = delete it.
            unlinkSync(snapshot.path)
          }
          restored += 1
        } catch {
          // The user may have moved or deleted a file since; keep going.
        }
      }
    } finally {
      restoring = false
    }
    for (const turn of [...bySession.keys()]) {
      if (turn >= fromTurn && turn <= toTurn) bySession.delete(turn)
    }
    return { restored }
  }

  // ── per-session file-changes panel (right-side dock) ──────────────────────
  // Backed by the same journal: for every file the session touched, the
  // EARLIEST snapshot across its turns IS the pre-change baseline (first
  // mutation of the file in the earliest turn wins). The panel diffs that
  // baseline against the file's CURRENT disk content and reports +N / -N
  // lines; 保存 accepts the current state (drops the pending entry), 撤销
  // restores the baseline.

  function normalizeSessionRequests(value) {
    const items = Array.isArray(value) ? value : [value]
    return items.map(item => {
      if (typeof item === 'string') return { sessionId: item, cwd: '' }
      if (item && typeof item === 'object' && typeof item.sessionId === 'string' && item.sessionId.length > 0) {
        return { sessionId: item.sessionId, cwd: typeof item.cwd === 'string' ? item.cwd : '' }
      }
      throw new Error('dsh desktop: invalid session request')
    }).filter(item => item.sessionId !== '')
  }

  function sessionCwd(sessionId) {
    try {
      const store = ctx.get('sessions')
      const session = typeof store?.get === 'function' ? store.get(sessionId) : undefined
      const cwd = session?.header?.cwd
      return typeof cwd === 'string' && cwd !== '' ? cwd : undefined
    } catch {
      return undefined
    }
  }

  async function gitShowHead(cwd, rel) {
    const { stdout } = await execFileAsync('git', ['-C', cwd, 'show', 'HEAD:' + rel], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 })
    return stdout
  }

  async function refreshGitPending(sessionId, cwd) {
    let output = ''
    try {
      const result = await execFileAsync('git', ['-C', cwd, 'status', '--porcelain=v1', '-z'], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 })
      output = result.stdout ?? ''
    } catch {
      gitPending.delete(sessionId)
      return
    }
    const entries = parseGitStatusZ(output)
    const previous = gitPending.get(sessionId)
    const files = new Map(previous?.files ?? [])
    const kept = gitKept.get(sessionId) ?? new Set()
    const seen = new Set()
    for (const entry of entries) {
      const rel = entry.path
      seen.add(rel)
      if (kept.has(rel) || files.has(rel)) continue
      const code = entry.code
      const untracked = code === '??'
      const deleted = code[1] === 'D' || code === 'D '
      const addedToIndex = code[0] === 'A'
      let baseline = ''
      let existed = false
      if (deleted || (!untracked && !addedToIndex)) {
        try {
          baseline = await gitShowHead(cwd, rel)
          existed = true
        } catch {}
      }
      let target
      try { target = await ctx.fs.resolve(rel, { cwd }) } catch { continue }
      let path = rel
      try { path = ctx.fs.processPath(target) } catch {}
      files.set(rel, { target, path, rel, existed, content: baseline, worktreeDeleted: deleted, indexAdded: addedToIndex })
    }
    for (const rel of [...files.keys()]) { if (!seen.has(rel) && !kept.has(rel)) files.delete(rel) }
    gitPending.set(sessionId, { cwd, files })
  }

  async function gitChangesRows(sessionId, cwd) {
    await refreshGitPending(sessionId, cwd)
    const state = gitPending.get(sessionId)
    if (state === undefined) return []
    const rows = []
    for (const [rel, snapshot] of state.files) {
      let current = ''
      let currentExists = !snapshot.worktreeDeleted
      try {
        const info = await ctx.fs.stat(snapshot.target)
        if (info === undefined) currentExists = false
        else current = await ctx.fs.readText(snapshot.target)
      } catch { currentExists = false }
      const oldText = snapshot.existed ? snapshot.content : ''
      const { additions, deletions } = lineDiff(oldText, current)
      if (additions === 0 && deletions === 0) continue
      rows.push({
        targetKey: 'git:' + sessionId + ':' + rel,
        path: snapshot.path || rel,
        existed: snapshot.existed,
        currentExists,
        additions,
        deletions,
        diff: diffHunks(oldText, current, 3),
      })
    }
    rows.sort((left, right) => String(left.path).localeCompare(String(right.path)))
    return rows
  }

  async function revertGitFile(sessionId, rel) {
    const state = gitPending.get(sessionId)
    const snapshot = state?.files.get(rel)
    if (snapshot === undefined) return { ok: false, error: 'file-not-found' }
    const cwd = state.cwd
    try {
      if (snapshot.existed) {
        await execFileAsync('git', ['-C', cwd, 'checkout', 'HEAD', '--', rel], { windowsHide: true })
      } else {
        if (snapshot.indexAdded === true) {
          try { await execFileAsync('git', ['-C', cwd, 'restore', '--staged', '--', rel], { windowsHide: true }) } catch {}
        }
        if (snapshot.path !== undefined) unlinkSync(snapshot.path)
      }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
    state.files.delete(rel)
    return { ok: true }
  }

  function saveGitFile(sessionId, rel) {
    const state = gitPending.get(sessionId)
    if (state?.files.delete(rel) !== true) return { ok: false, error: 'file-not-found' }
    const kept = gitKept.get(sessionId) ?? new Set()
    kept.add(rel)
    gitKept.set(sessionId, kept)
    return { ok: true }
  }

  async function revertAllGitFiles(sessionId) {
    const state = gitPending.get(sessionId)
    if (state === undefined) return 0
    let restored = 0
    for (const rel of [...state.files.keys()]) {
      const result = await revertGitFile(sessionId, rel)
      if (result.ok) restored++
    }
    return restored
  }

  function saveAllGitFiles(sessionId) {
    const state = gitPending.get(sessionId)
    if (state === undefined) return
    const kept = gitKept.get(sessionId) ?? new Set()
    for (const rel of state.files.keys()) kept.add(rel)
    gitKept.set(sessionId, kept)
    state.files.clear()
  }

  /** Summarize pending file changes across one or more sessions (fs journal + git). */
  async function changesList(sessionIds) {
    const requests = normalizeSessionRequests(sessionIds)
    const byPath = new Map()
    for (const request of requests) {
      const ownerSessionId = request.sessionId
      for (const [targetKey, snapshot] of pendingFilesOf(journals, ownerSessionId)) {
        let current = ''
        let currentExists = true
        try {
          const info = await ctx.fs.stat(snapshot.target)
          if (info === undefined) currentExists = false
          else current = await ctx.fs.readText(snapshot.target)
        } catch { currentExists = false }
        const { additions, deletions } = lineDiff(snapshot.existed ? snapshot.content : '', current)
        if (additions === 0 && deletions === 0) continue
        const path = snapshot.path ?? String(targetKey)
        if (!byPath.has(path)) {
          byPath.set(path, {
            targetKey: 'fs:' + ownerSessionId + ':' + targetKey,
            path,
            existed: snapshot.existed,
            currentExists,
            additions,
            deletions,
            diff: diffHunks(snapshot.existed ? snapshot.content : '', current, 3),
          })
        }
      }
      const cwd = sessionCwd(ownerSessionId) ?? request.cwd
      if (cwd !== undefined && cwd !== '') {
        try {
          for (const row of await gitChangesRows(ownerSessionId, cwd)) {
            if (!byPath.has(row.path)) byPath.set(row.path, row)
          }
        } catch {}
      }
    }
    const rows = [...byPath.values()]
    rows.sort((left, right) => String(left.path).localeCompare(String(right.path)))
    return { ok: true, rows }
  }

  /** Restore one file to its pre-change baseline and drop its pending entries. */
  async function revertFile(sessionId, targetKey) {
    let ownerSessionId = sessionId
    let rawKey = targetKey
    if (String(targetKey).startsWith('git:')) {
      const encoded = String(targetKey).slice(4)
      const sep = encoded.indexOf(':')
      if (sep !== -1) { ownerSessionId = encoded.slice(0, sep); rawKey = encoded.slice(sep + 1) }
      return revertGitFile(ownerSessionId, rawKey)
    }
    if (String(targetKey).startsWith('fs:')) {
      const encoded = String(targetKey).slice(3)
      const sep = encoded.indexOf(':')
      if (sep !== -1) { ownerSessionId = encoded.slice(0, sep); rawKey = encoded.slice(sep + 1) }
    }
    const snapshot = pendingFilesOf(journals, ownerSessionId).get(rawKey)
    if (!snapshot) return { ok: false, error: 'file-not-found' }
    restoring = true
    try {
      if (snapshot.existed) await ctx.fs.writeText(snapshot.target, snapshot.content)
      else if (snapshot.path !== undefined) unlinkSync(snapshot.path)
    } finally { restoring = false }
    dropFileEntries(ownerSessionId, rawKey)
    return { ok: true }
  }

  /** Accept one file's current state: drop its pending entries (no disk write). */
  function saveFile(sessionId, targetKey) {
    let ownerSessionId = sessionId
    let rawKey = targetKey
    if (String(targetKey).startsWith('git:')) {
      const encoded = String(targetKey).slice(4)
      const sep = encoded.indexOf(':')
      if (sep !== -1) { ownerSessionId = encoded.slice(0, sep); rawKey = encoded.slice(sep + 1) }
      return saveGitFile(ownerSessionId, rawKey)
    }
    if (String(targetKey).startsWith('fs:')) {
      const encoded = String(targetKey).slice(3)
      const sep = encoded.indexOf(':')
      if (sep !== -1) { ownerSessionId = encoded.slice(0, sep); rawKey = encoded.slice(sep + 1) }
    }
    return dropFileEntries(ownerSessionId, rawKey)
      ? { ok: true }
      : { ok: false, error: 'file-not-found' }
  }

  /** Remove every journal entry of one file across all turns; true when any existed. */
  function dropFileEntries(sessionId, targetKey) {
    const bySession = journals.get(sessionId)
    if (!bySession) return false
    let removed = false
    for (const turn of [...bySession.keys()]) {
      const turnFiles = bySession.get(turn)
      if (!turnFiles) continue
      if (turnFiles.delete(targetKey)) removed = true
      if (turnFiles.size === 0) bySession.delete(turn)
    }
    return removed
  }

  /** Restore every pending file across every requested session. */
  async function revertAllFiles(sessionIds) {
    const requests = normalizeSessionRequests(sessionIds)
    let restored = 0
    for (const request of requests) {
      const id = request.sessionId
      const snapshots = [...pendingFilesOf(journals, id).values()]
      restoring = true
      try {
        for (const snapshot of snapshots) {
          try {
            if (snapshot.existed) await ctx.fs.writeText(snapshot.target, snapshot.content)
            else if (snapshot.path !== undefined) unlinkSync(snapshot.path)
            restored += 1
          } catch {}
        }
      } finally { restoring = false }
      journals.delete(id)
      restored += await revertAllGitFiles(id)
    }
    return { ok: true, restored }
  }

  /** Accept every pending change across every requested session. */
  function saveAllFiles(sessionIds) {
    const requests = normalizeSessionRequests(sessionIds)
    for (const request of requests) {
      const id = request.sessionId
      saveAllGitFiles(id)
      journals.delete(id)
    }
    return { ok: true }
  }

  // The revert and conversation-edit gateways ride the main process (this
  // plugin runs inside the desktop main's profile boot). Under plain-Node
  // probe/e2e boots the electron package resolves to its binary-path shim:
  // the journal still works, only the IPC handlers are skipped.
  import('electron').then((electron) => {
    const ipcMain = electron && electron.ipcMain
    // Plain-Node probe/e2e boots resolve the electron package to its
    // binary-path shim (no ipcMain): the journal still works, the IPC
    // handlers are skipped.
    if (!ipcMain || typeof ipcMain.handle !== 'function') return
    ipcMain.handle('dsh-desktop:fs-revert:list', (_event, sessionId) => listTurns(sessionId))
    ipcMain.handle('dsh-desktop:fs-revert:apply', (_event, sessionId, fromTurn, toTurn) => {
      if (typeof sessionId !== 'string' || sessionId.length === 0
        || typeof fromTurn !== 'number' || !Number.isInteger(fromTurn) || fromTurn < 0) {
        throw new Error('dsh desktop: invalid fs-revert payload')
      }
      return revertSession(sessionId, fromTurn, typeof toTurn === 'number' ? toTurn : fromTurn)
    })
      const requireSessionId = (value) => {
        if (typeof value !== 'string' || value.length === 0) {
          throw new Error('dsh desktop: invalid session payload')
        }
        return value
      }
        const requireSessionIds = (value) => {
          const items = Array.isArray(value) ? value : [value]
          return items.map(item => {
            if (typeof item === 'string') return { sessionId: item, cwd: '' }
            if (item && typeof item === 'object' && typeof item.sessionId === 'string' && item.sessionId.length > 0) {
              return { sessionId: item.sessionId, cwd: typeof item.cwd === 'string' ? item.cwd : '' }
            }
            throw new Error('dsh desktop: invalid session-id list')
          })
        }
    const requireFileId = (value) => {
      if (typeof value !== 'string' || value.length === 0) {
        throw new Error('dsh desktop: invalid file payload')
      }
      return value
    }
      ipcMain.handle('dsh-desktop:fs-changes:list', (_event, sessionIds) => changesList(requireSessionIds(sessionIds)))
    ipcMain.handle('dsh-desktop:fs-changes:revert', (_event, sessionId, targetKey) =>
      revertFile(requireSessionId(sessionId), requireFileId(targetKey)))
    ipcMain.handle('dsh-desktop:fs-changes:save', (_event, sessionId, targetKey) =>
      saveFile(requireSessionId(sessionId), requireFileId(targetKey)))
      ipcMain.handle('dsh-desktop:fs-changes:revert-all', (_event, sessionIds) => revertAllFiles(requireSessionIds(sessionIds)))
      ipcMain.handle('dsh-desktop:fs-changes:save-all', (_event, sessionIds) => saveAllFiles(requireSessionIds(sessionIds)))
    ipcMain.handle('dsh-desktop:conversation-edit:apply', (_event, sessionId, messageId, text) => {
      if (typeof sessionId !== 'string' || sessionId.length === 0
        || typeof messageId !== 'string' || messageId.length === 0
        || typeof text !== 'string') {
        throw new Error('dsh desktop: invalid conversation-edit payload')
      }
      // ctx.get resolves the service without the inject requirement (same
      // path as the desktop main's ctx.get('webServer')); the plugin's apply
      // context must not declare 'sessions' as a required service to keep the
      // boot graph lean.
      return applyConversationEdit(
        typeof ctx.get === 'function' ? ctx.get('sessions') : undefined,
        sessionId,
        messageId,
        text,
      )
    })
    ipcMain.handle('dsh-desktop:conversation-edit:prior-turn-end', (_event, sessionId, messageSeq) => {
      if (typeof sessionId !== 'string' || sessionId.length === 0
        || typeof messageSeq !== 'number' || !Number.isSafeInteger(messageSeq) || messageSeq < 0) {
        throw new Error('dsh desktop: invalid conversation-edit prior-turn payload')
      }
      const session = typeof ctx.get === 'function'
        ? ctx.get('sessions')?.get(sessionId)
        : undefined
      if (!session) return { ok: false, error: 'session-not-found' }
      return forkAnchorBeforeMessage(session, messageSeq)
    })
  }).catch(() => {
    // Plain node boot: no Electron IPC available.
  })
}
