import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  $connectionRequests,
  applyConnectionUpdate,
  applyOperationStatus,
  clearConnectionRequest,
  type ConnectionRequest,
  continueConnectionRequest,
  hasConnectionRequest,
  normalizeConnectionRequest,
  respondToConnectionRequest,
  setConnectionRequest,
  skipConnectionRequest,
  skipConnectionTarget,
  updateConnectionRequest
} from './connection-request'
import { $gateway } from './gateway'

const WIRE = {
  deadline_at: 1_800_000_000,
  op_id: 'op-1',
  reason: 'inbox',
  request_id: 'req-1',
  targets: [
    { action: 'connect' as const, kind: 'connector' as const, name: 'gmail' },
    { action: 'connect' as const, kind: 'connector' as const, name: 'notion' }
  ]
}

type Gateway = NonNullable<ReturnType<typeof $gateway.get>>

function fakeGateway(rpc: Gateway['request']): Gateway {
  // SAFETY: the store calls only `request`; the rest of the client is never touched in these tests.
  return { request: rpc } as Gateway
}

function request(sessionId: string | null, opId = 'op-1'): ConnectionRequest {
  return normalizeConnectionRequest({ ...WIRE, op_id: opId }, sessionId)!
}

describe('connection-request store', () => {
  beforeEach(() => {
    $connectionRequests.set({})
  })

  afterEach(() => {
    $connectionRequests.set({})
    $gateway.set(null)
  })

  it('normalizes the wire payload and keeps the server-owned deadline verbatim', () => {
    const parsed = normalizeConnectionRequest(WIRE, 's1')

    expect(parsed?.deadlineAt).toBe(WIRE.deadline_at)
    expect(parsed?.opId).toBe('op-1')
    expect(parsed?.targets.map(t => [t.name, t.kind, t.state])).toEqual([
      ['gmail', 'connector', 'pending'],
      ['notion', 'connector', 'pending']
    ])
    expect(parsed?.settled).toBe(false)
  })

  it('accepts a resume snapshot with no request id', () => {
    const { request_id: _omitted, ...snapshot } = WIRE

    expect(normalizeConnectionRequest(snapshot, 's1')?.requestId).toBeNull()
  })

  it('rejects a payload with no targets, no op id or no deadline', () => {
    expect(normalizeConnectionRequest({ ...WIRE, targets: [] }, 's1')).toBeNull()
    expect(normalizeConnectionRequest({ ...WIRE, op_id: '' }, 's1')).toBeNull()
    expect(normalizeConnectionRequest({ ...WIRE, deadline_at: 0 }, 's1')).toBeNull()
    expect(normalizeConnectionRequest(null, 's1')).toBeNull()
  })

  it('never recomputes the deadline: status overlays the server value, updates leave it alone', () => {
    const req = request('a')

    const overlaid = applyOperationStatus(req, {
      deadline_at: WIRE.deadline_at,
      op_id: 'op-1',
      settled: false,
      settled_by: null,
      targets: [
        { action: 'connect', connect_url: 'https://l/gmail', kind: 'connector', name: 'gmail', state: 'initiated' },
        { action: 'connect', kind: 'connector', name: 'notion', state: 'pending' }
      ]
    })

    expect(overlaid.deadlineAt).toBe(WIRE.deadline_at)
    expect(overlaid.targets[0]).toMatchObject({ connectUrl: 'https://l/gmail', state: 'initiated' })

    const updated = applyConnectionUpdate(overlaid, {
      actor: 'backend_watcher',
      from: 'initiated',
      op_id: 'op-1',
      settled: false,
      target: 'gmail',
      to: 'connected'
    })

    expect(updated.deadlineAt).toBe(WIRE.deadline_at)
    expect(updated.targets[0].state).toBe('connected')
    expect(updated.targets[0].connectUrl).toBe('https://l/gmail')
  })

  it('ignores an update for another operation or after settlement', () => {
    const req = request('a')
    const foreign = applyConnectionUpdate(req, { op_id: 'op-9', settled: false, target: 'gmail', to: 'connected' })

    expect(foreign).toBe(req)

    const settled = applyConnectionUpdate(req, { op_id: 'op-1', settled: true, settled_by: 'deadline' })

    expect(settled.settled).toBe(true)
    expect(settled.settledBy).toBe('deadline')
    expect(applyConnectionUpdate(settled, { op_id: 'op-1', settled: false, target: 'gmail', to: 'connected' })).toBe(settled)
  })

  it('updateConnectionRequest writes the store only when something changed', () => {
    setConnectionRequest(request('a'))
    const before = $connectionRequests.get().a

    updateConnectionRequest('a', { op_id: 'op-9', settled: false })
    expect($connectionRequests.get().a).toBe(before)

    updateConnectionRequest('a', { op_id: 'op-1', settled: false, target: 'notion', to: 'skipped' })
    expect($connectionRequests.get().a.targets[1].state).toBe('skipped')
  })

  it('keeps requests from concurrent sessions independent', () => {
    setConnectionRequest(request('a', 'op-a'))
    setConnectionRequest(request('b', 'op-b'))

    expect(hasConnectionRequest('a')).toBe(true)
    clearConnectionRequest('op-a', 'a')
    expect(hasConnectionRequest('a')).toBe(false)
    expect(hasConnectionRequest('b')).toBe(true)
  })

  it('a stale op id never clears a newer card', () => {
    setConnectionRequest(request('a', 'op-new'))
    clearConnectionRequest('op-old', 'a')

    expect($connectionRequests.get().a?.opId).toBe('op-new')
  })

  it('respond keys on op_id, keeps the entry (the backend answers via connection.update), refuses once settled', async () => {
    const rpc = vi.fn().mockResolvedValue({ status: 'ok', settled: false })
    $gateway.set(fakeGateway(rpc))
    const req = request('a')
    setConnectionRequest(req)

    expect(await skipConnectionTarget(req, 'notion')).toBe(true)
    expect(rpc.mock.calls[0][0]).toBe('connection.respond')
    expect(rpc.mock.calls[0][1]).toMatchObject({ op_id: 'op-1', session_id: 'a' })
    expect(JSON.parse(rpc.mock.calls[0][1].result)).toEqual({ targets: [{ name: 'notion', status: 'skipped' }] })
    expect($connectionRequests.get().a).toBeDefined()

    updateConnectionRequest('a', { op_id: 'op-1', settled: true, settled_by: 'all_resolved' })
    expect(await respondToConnectionRequest(req, { settled_by: 'continue' })).toBe(false)
    expect(hasConnectionRequest('a')).toBe(false)
  })

  it('typing while the card is open sends Continue, not a per-target decline', async () => {
    const rpc = vi.fn().mockResolvedValue({ status: 'ok', settled: true })
    $gateway.set(fakeGateway(rpc))
    setConnectionRequest(request('a'))

    expect(await skipConnectionRequest('a')).toBe(true)
    expect(JSON.parse(rpc.mock.calls[0][1].result)).toEqual({ settled_by: 'continue' })
  })

  it('continue is a one-field payload', async () => {
    const rpc = vi.fn().mockResolvedValue({ status: 'ok', settled: true })
    $gateway.set(fakeGateway(rpc))
    const req = request('a')
    setConnectionRequest(req)

    await continueConnectionRequest(req)
    expect(JSON.parse(rpc.mock.calls[0][1].result)).toEqual({ settled_by: 'continue' })
  })
})
