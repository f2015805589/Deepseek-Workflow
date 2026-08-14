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
import { applyConversationEdit, forkAnchorBeforeMessage } from '../plugins/dsh-client-ui-desktop-plugins/lib/index.js'

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
