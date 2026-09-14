import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  $connectionRequests,
  applyConnectionUpdate,
  type ConnectionRequest,
  normalizeConnectionRequest,
  setConnectionRequest
} from '@/store/connection-request'

import { restorePendingConnectionFromSnapshot } from './restore-pending-connection'

const SESSION_ID = 'session-1'

const SNAPSHOT = {
  deadline_at: 1_800_000_000,
  op_id: 'op-1',
  seq: 3,
  targets: [{ action: 'connect' as const, kind: 'connector' as const, name: 'gmail', state: 'pending' as const }],
  tool_call_id: 'call-1'
}

const cached = (overrides: Partial<ConnectionRequest> = {}): ConnectionRequest => ({
  ...normalizeConnectionRequest(SNAPSHOT, SESSION_ID)!,
  ...overrides
})

beforeEach(() => {
  $connectionRequests.set({})
})

afterEach(() => {
  $connectionRequests.set({})
})

describe('restoring a pending connection from a resume snapshot', () => {
  it('never revives a card the operation already settled', () => {
    const settled = cached({ settled: true, settledBy: 'continue' })
    setConnectionRequest(settled)

    const state = restorePendingConnectionFromSnapshot({ pending_connection: SNAPSHOT }, SESSION_ID, Date.now() / 1000)

    expect($connectionRequests.get()[SESSION_ID]).toBe(settled)
    expect(state.request).toBe(settled)
  })

  it('never regresses a row a newer frame already moved', () => {
    const live = applyConnectionUpdate(cached(), {
      deadline_at: SNAPSHOT.deadline_at,
      op_id: 'op-1',
      seq: 7,
      settled: false,
      targets: [{ action: 'connect', kind: 'connector', name: 'gmail', state: 'connected' }]
    })

    setConnectionRequest(live)

    restorePendingConnectionFromSnapshot({ pending_connection: SNAPSHOT }, SESSION_ID, Date.now() / 1000)

    expect($connectionRequests.get()[SESSION_ID]).toBe(live)
    expect($connectionRequests.get()[SESSION_ID].targets[0].state).toBe('connected')
  })

  it('takes the snapshot when it is the newer word on the operation', () => {
    setConnectionRequest(cached({ seq: 1 }))

    const newer = { ...SNAPSHOT, seq: 4 }
    const state = restorePendingConnectionFromSnapshot({ pending_connection: newer }, SESSION_ID, Date.now() / 1000)

    expect(state.request?.seq).toBe(4)
    expect($connectionRequests.get()[SESSION_ID].seq).toBe(4)
  })
})
