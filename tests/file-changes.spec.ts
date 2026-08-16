import { describe, expect, it } from 'vitest'
import { apply, fsJournals } from '../plugins/dsh-client-ui-desktop-plugins/lib/index.js'

/** Minimal Cordis-shaped context for exercising the plugin's event wiring. */
function makeCtx(overrides = {}) {
  const hooks = new Map()
  const ctx = {
    fs: {
      stat: async () => ({ size: 1 }),
      readText: async () => '',
      processPath: () => 'C:\\work\\file.txt',
      ...overrides.fs,
    },
    get: (name) => (name === 'sessions' ? overrides.sessions : undefined),
    inject: (_needs, callback) => {
      callback({
        settings: {
          register: () => {},
        },
      })
    },
    on: (name, listener, options) => {
      const list = hooks.get(name) ?? []
      if (options === true || options?.prepend === true) list.unshift(listener)
      else list.push(listener)
      hooks.set(name, list)
      return () => true
    },
    emit: (name, ...args) => {
      for (const listener of hooks.get(name) ?? []) listener(...args)
    },
    waterfall: (name, ...args) => {
      const inner = args.pop()
      const callbacks = [...(hooks.get(name) ?? [])]
      const next = () => {
        const callback = callbacks.shift() ?? inner
        return callback(...args)
      }
      args.push(next)
      return next()
    },
    ...overrides.ctx,
  }
  return ctx
}

describe('desktop file-changes journal wiring', () => {
  it('prepends its snapshot listener before a vetoing fs policy listener', async () => {
    fsJournals.clear()
    const calls = []
    const session = { id: 's-policy-order' }
    const target = { targetKey: 'a.txt', displayPath: 'a.txt' }
    const ctx = makeCtx({
      fs: {
        stat: async () => ({ size: 3 }),
        readText: async () => 'old',
        processPath: () => 'C:\\work\\a.txt',
      },
    })

    // The base composition registers the observation-policy listener first;
    // it occupies the single-slot waterfall and never calls next().
    ctx.on('fs/write-intent', (_target, _actor, _next) => {
      calls.push('policy')
      return { kind: 'createIfAbsent' }
    })
    apply(ctx)

    const intent = await ctx.waterfall('fs/write-intent', target, { agent: { session } }, () => ({ kind: 'inner' }))

    expect(calls).toEqual(['policy'])
    expect(intent).toEqual({ kind: 'createIfAbsent' })
    expect(fsJournals.get('s-policy-order')?.get(0)?.get('a.txt')).toMatchObject({
      path: 'C:\\work\\a.txt',
      existed: true,
      content: 'old',
    })
  })

  it('groups snapshots by the turn number carried by turn/start', async () => {
    fsJournals.clear()
    const session = { id: 's-turn-boundary' }
    const target = { targetKey: 'b.txt', displayPath: 'b.txt' }
    const ctx = makeCtx({
      fs: {
        stat: async () => ({ size: 4 }),
        readText: async () => 'baseline',
        processPath: () => 'C:\\work\\b.txt',
      },
    })
    apply(ctx)

    // `user/message` carries no turn; the journal must read turn/start.
    ctx.emit('session/event', session, { type: 'user/message', data: { id: 'msg-1' } })
    ctx.emit('session/event', session, { type: 'turn/start', data: { turn: 3 } })
    await ctx.waterfall('fs/edit-intent', target, { agent: { session } }, () => ({ version: 'v1' }))

    const byTurn = fsJournals.get('s-turn-boundary')
    expect(byTurn?.get(0)).toBeUndefined()
    expect(byTurn?.get(3)?.get('b.txt')).toMatchObject({
      path: 'C:\\work\\b.txt',
      existed: true,
      content: 'baseline',
    })
  })
})
