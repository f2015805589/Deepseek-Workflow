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
  /** sessionId -> current turn index, advanced on user/message events. */
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
  // so policy listeners and the write itself are untouched.
  ctx.on('fs/write-intent', async (target, actor, next) => {
    await snapshotFile(target, actor)
    return next()
  })
  ctx.on('fs/edit-intent', async (target, actor, next) => {
    await snapshotFile(target, actor)
    return next()
  })

  // Advance the per-session turn counter on each human prompt.
  ctx.on('session/event', (session, event) => {
    if (event.type !== 'user/message') return
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

  /** Summarize one session's pending file changes with diff stats. */
  async function changesList(sessionId) {
    const rows = []
    for (const [targetKey, snapshot] of pendingFilesOf(journals, sessionId)) {
      let current = ''
      let currentExists = true
      try {
        const info = await ctx.fs.stat(snapshot.target)
        if (info === undefined) {
          currentExists = false
        } else {
          current = await ctx.fs.readText(snapshot.target)
        }
      } catch {
        currentExists = false
      }
      const { additions, deletions } = lineDiff(
        snapshot.existed ? snapshot.content : '',
        current,
      )
      if (additions === 0 && deletions === 0) continue
      rows.push({
        targetKey,
        path: snapshot.path ?? String(targetKey),
        existed: snapshot.existed,
        currentExists,
        additions,
        deletions,
      })
    }
    rows.sort((left, right) => String(left.path).localeCompare(String(right.path)))
    return { ok: true, rows }
  }

  /** Restore one file to its pre-change baseline and drop its pending entries. */
  async function revertFile(sessionId, targetKey) {
    const snapshot = pendingFilesOf(journals, sessionId).get(targetKey)
    if (!snapshot) return { ok: false, error: 'file-not-found' }
    restoring = true
    try {
      if (snapshot.existed) {
        await ctx.fs.writeText(snapshot.target, snapshot.content)
      } else if (snapshot.path !== undefined) {
        // The file did not exist before the session touched it: revert = delete it.
        unlinkSync(snapshot.path)
      }
    } finally {
      restoring = false
    }
    dropFileEntries(sessionId, targetKey)
    return { ok: true }
  }

  /** Accept one file's current state: drop its pending entries (no disk write). */
  function saveFile(sessionId, targetKey) {
    return dropFileEntries(sessionId, targetKey)
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

  /** Restore every pending file to its pre-change baseline and clear the journal. */
  async function revertAllFiles(sessionId) {
    const snapshots = [...pendingFilesOf(sessionId).values()]
    restoring = true
    let restored = 0
    try {
      for (const snapshot of snapshots) {
        try {
          if (snapshot.existed) {
            await ctx.fs.writeText(snapshot.target, snapshot.content)
          } else if (snapshot.path !== undefined) {
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
    journals.delete(sessionId)
    return { ok: true, restored }
  }

  /** Accept every pending change: clear the session journal (no disk write). */
  function saveAllFiles(sessionId) {
    journals.delete(sessionId)
    return { ok: true }
  }

  // The revert and conversation-edit gateways ride the main process (this
  // plugin runs inside the desktop main's profile boot). Under plain-Node
  // probe/e2e boots the electron package resolves to its binary-path shim:
  // the journal still works, only the IPC handlers are skipped.
  import('electron').then(({ ipcMain }) => {
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
    const requireFileId = (value) => {
      if (typeof value !== 'string' || value.length === 0) {
        throw new Error('dsh desktop: invalid file payload')
      }
      return value
    }
    ipcMain.handle('dsh-desktop:fs-changes:list', (_event, sessionId) => changesList(requireSessionId(sessionId)))
    ipcMain.handle('dsh-desktop:fs-changes:revert', (_event, sessionId, targetKey) =>
      revertFile(requireSessionId(sessionId), requireFileId(targetKey)))
    ipcMain.handle('dsh-desktop:fs-changes:save', (_event, sessionId, targetKey) =>
      saveFile(requireSessionId(sessionId), requireFileId(targetKey)))
    ipcMain.handle('dsh-desktop:fs-changes:revert-all', (_event, sessionId) => revertAllFiles(requireSessionId(sessionId)))
    ipcMain.handle('dsh-desktop:fs-changes:save-all', (_event, sessionId) => saveAllFiles(requireSessionId(sessionId)))
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
