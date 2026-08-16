// Cursor-style in-place conversation edit (host half): editing a past user
// message must change what the model reads on the NEXT request, in the SAME
// session — no fork, no new dialog. The session log is append-only, so the
// edit lands as a positional surface replacement: the original node is
// shadowed on the model surface (deriveMessages) while the human transcript
// keeps the append-origin message. Editing "1" to "2" and then sending a new
// message at the bottom must derive as [2, reply-to-1, new-message]. The
// 发送 (edit-and-resend) path rewinds to BEFORE the edited turn, so the old
// reply falls away.
import { describe, expect, it } from 'vitest'
import { Session, SessionId } from '../../packages/core/session/lib/index.js'
import {
  applyConversationEdit, diffHunks, forkAnchorBeforeMessage, fsJournals, lineDiff, parseGitStatusZ, pendingFilesOf,
} from '../plugins/dsh-client-ui-desktop-plugins/lib/index.js'

/** One completed turn: a user prompt and its assistant reply. */
function completeTurn(session: Session, turn: number, messageId: string, prompt: string, replyId: string, reply: string): void {
  session.append('turn/start', { turn })
  session.append('user/message', {
    id: messageId,
    role: 'user',
    content: [{ type: 'text', text: prompt }],
    source: { kind: 'user' },
  }, { surfaceOp: 'append' })
  session.append('assistant/message', {
    turn,
    step: 1,
    message: {
      id: replyId,
      role: 'assistant',
      content: [{ type: 'text', text: reply }],
      source: { kind: 'model', provider: 'mock', model: 'mock' },
    },
  }, { surfaceOp: 'append' })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
}

/** The joined text of one derived message. */
function textOf(message: { content: readonly { type: string; text?: string }[] }): string {
  return (message.content ?? []).map(block => (block.type === 'text' && typeof block.text === 'string' ? block.text : '')).join('')
}

/** A fake SessionStore exposing only the live-session lookup. */
function storeOf(session: Session): { get: (id: unknown) => Session | undefined } {
  return { get: (id: unknown) => (id === session.id ? session : undefined) }
}

describe('desktop in-place conversation edit (surface replacement)', () => {
  it('replaces the edited message on the model surface without a fork', () => {
    const session = Session.create(SessionId('edit-replace'))
    completeTurn(session, 0, 'msg-1', '1', 'asst-1', 'reply to 1')

    const result = applyConversationEdit(storeOf(session), session.id, 'msg-1', '2')
    expect(result).toMatchObject({ ok: true })

    // The transcript (append-origin events) keeps the original message…
    const userEvents = session.events.filter(event => event.type === 'user/message')
    expect(userEvents.map(event => event.data.content)).toContainEqual([{ type: 'text', text: '1' }])
    // …while the model surface reads the edit, with the old reply kept in place.
    expect(session.deriveMessages().map(textOf)).toEqual(['2', 'reply to 1'])
  })

  it('makes the next bottom prompt read [edited, reply-to-1, new-message]', () => {
    const session = Session.create(SessionId('edit-then-send'))
    completeTurn(session, 0, 'msg-1', '1', 'asst-1', 'reply to 1')

    const result = applyConversationEdit(storeOf(session), session.id, 'msg-1', '2')
    expect(result).toMatchObject({ ok: true })

    // The user then sends "3" at the bottom (the normal composer path).
    session.append('turn/start', { turn: 1 })
    session.append('user/message', {
      id: 'msg-3',
      role: 'user',
      content: [{ type: 'text', text: '3' }],
      source: { kind: 'user' },
    }, { surfaceOp: 'append' })

    expect(session.deriveMessages().map(textOf)).toEqual(['2', 'reply to 1', '3'])
  })

  it('supports re-editing the same message (targets the replacement node)', () => {
    const session = Session.create(SessionId('edit-twice'))
    completeTurn(session, 0, 'msg-1', '1', 'asst-1', 'reply to 1')

    const first = applyConversationEdit(storeOf(session), session.id, 'msg-1', '2')
    expect(first).toMatchObject({ ok: true })

    const second = applyConversationEdit(storeOf(session), session.id, 'msg-1', '3')
    expect(second).toMatchObject({ ok: true })
    expect(session.deriveMessages().map(textOf)).toEqual(['3', 'reply to 1'])
  })

  it('preserves image blocks and drops the text block when the edit is blank', () => {
    const session = Session.create(SessionId('edit-images'))
    session.append('turn/start', { turn: 0 })
    session.append('user/message', {
      id: 'msg-img',
      role: 'user',
      content: [
        { type: 'image', attachment: { attachmentId: 'a-1', mediaType: 'image/png' } },
        { type: 'text', text: 'explain' },
      ],
      source: { kind: 'user' },
    }, { surfaceOp: 'append' })
    session.append('assistant/message', {
      turn: 0,
      step: 1,
      message: {
        id: 'asst-img',
        role: 'assistant',
        content: [{ type: 'text', text: 'sure' }],
        source: { kind: 'model', provider: 'mock', model: 'mock' },
      },
    }, { surfaceOp: 'append' })
    session.append('turn/end', { turn: 0, reason: { kind: 'completed' } })

    const result = applyConversationEdit(storeOf(session), session.id, 'msg-img', 'rephrase')
    expect(result).toMatchObject({ ok: true })
    expect(session.deriveMessages()[0]!.content).toEqual([
      { type: 'image', attachment: { attachmentId: 'a-1', mediaType: 'image/png' } },
      { type: 'text', text: 'rephrase' },
    ])
  })

  it('rejects unknown sessions, unknown messages, and blank payloads', () => {
    const session = Session.create(SessionId('edit-errors'))
    completeTurn(session, 0, 'msg-1', '1', 'asst-1', 'reply to 1')

    expect(applyConversationEdit({ get: () => undefined }, 'missing', 'msg-1', '2'))
      .toMatchObject({ ok: false, error: 'session-not-found' })
    expect(applyConversationEdit(storeOf(session), session.id, 'not-a-message', '2'))
      .toMatchObject({ ok: false, error: 'message-not-editable' })
  })
})

describe('desktop edit-and-resend fork anchor (发送 deletes the old reply)', () => {
  it('anchors the fork at the turn/end before the edited turn', () => {
    const session = Session.create(SessionId('anchor-mid'))
    completeTurn(session, 0, 'msg-1', '1', 'asst-1', 'reply to 1')
    completeTurn(session, 1, 'msg-2', '3', 'asst-2', 'reply to 3')

    const msg2Seq = session.events.find(event => event.type === 'user/message' && event.data.id === 'msg-2')!.seq
    const anchor = forkAnchorBeforeMessage(session, msg2Seq)
    const turnEnd0 = session.events.find(event => event.type === 'turn/end' && event.data.turn === 0)!
    expect(anchor).toMatchObject({ ok: true, atSeq: turnEnd0.seq })
  })

  it('reports first-turn for a message opening the first turn', () => {
    const session = Session.create(SessionId('anchor-first'))
    completeTurn(session, 0, 'msg-1', '1', 'asst-1', 'reply to 1')
    const msg1Seq = session.events.find(event => event.type === 'user/message' && event.data.id === 'msg-1')!.seq
    expect(forkAnchorBeforeMessage(session, msg1Seq)).toMatchObject({ ok: false, error: 'first-turn' })
  })

  it('rewinds before the edited turn: the resend drops the old reply', () => {
    const session = Session.create(SessionId('resend-drop'))
    completeTurn(session, 0, 'msg-1', '1', 'asst-1', 'reply to 1')
    completeTurn(session, 1, 'msg-2', '3', 'asst-2', 'reply to 3')

    // Edit msg-2 (turn 1) to "4" and press 发送: rewind to before turn 1.
    const msg2Seq = session.events.find(event => event.type === 'user/message' && event.data.id === 'msg-2')!.seq
    const anchor = forkAnchorBeforeMessage(session, msg2Seq)
    expect(anchor).toMatchObject({ ok: true })

    // The wire fork cuts through the first turn/end at or after atSeq (= turn 0's end).
    const boundary = session.events.find(event => event.type === 'turn/end' && event.seq >= anchor.atSeq)!
    const child = Session.create(SessionId('resend-child'), session.events.slice(0, boundary.seq + 1))

    // The edited text is sent into the child.
    child.append('turn/start', { turn: 2 })
    child.append('user/message', {
      id: 'msg-2-edit',
      role: 'user',
      content: [{ type: 'text', text: '4' }],
      source: { kind: 'user' },
    }, { surfaceOp: 'append' })

    // Turn 1 (msg-2 "3" and its reply "reply to 3") is gone; only the edited
    // "4" and the retained prior turn remain.
    expect(child.deriveMessages().map(textOf)).toEqual(['1', 'reply to 1', '4'])
  })
})

describe('desktop file-changes panel diff and baseline aggregation', () => {
  it('counts pure additions, pure deletions, and mixed edits', () => {
    expect(lineDiff('', 'a\nb\nc')).toEqual({ additions: 3, deletions: 0 })
    expect(lineDiff('a\nb\nc', '')).toEqual({ additions: 0, deletions: 3 })
    expect(lineDiff('keep\nold\nend', 'keep\nnew\nend')).toEqual({ additions: 1, deletions: 1 })
    expect(lineDiff('a\nb', 'a\nb')).toEqual({ additions: 0, deletions: 0 })
  })

  it('ignores the trailing newline when counting', () => {
    expect(lineDiff('a\n', 'a\nb\n')).toEqual({ additions: 1, deletions: 0 })
    expect(lineDiff('a\nb\n', 'a\n')).toEqual({ additions: 0, deletions: 1 })
  })

  it('renders unified hunks with add/del/context lines and bounded truncation', () => {
    const diff = diffHunks('keep\nold\nend', 'keep\nnew\nend\nextra')
    expect(diff.additions).toBe(2)
    expect(diff.deletions).toBe(1)
    expect(diff.truncated).toBe(false)
    expect(diff.hunks).toHaveLength(1)
    const kinds = diff.hunks[0].lines.map(line => line.kind)
    expect(kinds).toEqual(['context', 'del', 'add', 'context', 'add'])
    expect(diff.hunks[0].lines[1].text).toBe('old')
    expect(diff.hunks[0].lines[2].text).toBe('new')
  })

  it('falls back to stats-only for oversized diffs', () => {
    const largeOld = Array.from({ length: 900 }, (_, index) => `old-${index}`).join('\n')
    const largeNew = Array.from({ length: 900 }, (_, index) => `new-${index}`).join('\n')
    const diff = diffHunks(largeOld, largeNew)
    expect(diff.truncated).toBe(true)
    expect(diff.hunks).toEqual([])
    expect(diff.additions).toBe(900)
    expect(diff.deletions).toBe(900)
  })

  it('parses porcelain v1 -z output including rename entries', () => {
    expect(parseGitStatusZ(' M src/a.ts\0?? new.txt\0R  old.txt\0new.txt\0')).toEqual([
      { code: ' M', path: 'src/a.ts' },
      { code: '??', path: 'new.txt' },
      { code: 'R ', path: 'new.txt', origPath: 'old.txt' },
    ])
    expect(parseGitStatusZ('')).toEqual([])
  })


  it('aggregates pending files with the EARLIEST turn winning as the baseline', () => {
    const journals = new Map()
    const bySession = new Map()
    // Turn 0 touches alpha.txt (baseline "old-a") and beta.txt (baseline "old-b").
    const turn0 = new Map()
    turn0.set('alpha.txt', { target: {}, path: '/p/alpha.txt', existed: true, content: 'old-a' })
    turn0.set('beta.txt', { target: {}, path: '/p/beta.txt', existed: true, content: 'old-b' })
    bySession.set(0, turn0)
    // Turn 1 re-touches alpha.txt: its snapshot is the state AT turn 1, not
    // the pre-session baseline — the earliest entry must win.
    const turn1 = new Map()
    turn1.set('alpha.txt', { target: {}, path: '/p/alpha.txt', existed: true, content: 'mid-a' })
    turn1.set('gamma.txt', { target: {}, path: '/p/gamma.txt', existed: false, content: '' })
    bySession.set(1, turn1)
    journals.set('s1', bySession)

    const pending = pendingFilesOf(journals, 's1')
    expect([...pending.keys()].sort()).toEqual(['alpha.txt', 'beta.txt', 'gamma.txt'])
    expect(pending.get('alpha.txt')).toMatchObject({ content: 'old-a' })
    expect(pending.get('beta.txt')).toMatchObject({ content: 'old-b' })
    expect(pending.get('gamma.txt')).toMatchObject({ existed: false })
  })

  it('returns an empty map for sessions with no journal', () => {
    expect(pendingFilesOf(fsJournals, 'no-such-session').size).toBe(0)
    expect(pendingFilesOf(new Map(), 'any').size).toBe(0)
  })
})
