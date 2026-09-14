import type {
  ConnectionOperationStatus,
  ConnectionOperationTarget,
  ConnectionRequestPayload,
  ConnectionRequestTarget,
  ConnectionSettleReason,
  ConnectionTargetAction,
  ConnectionTargetKind,
  ConnectionTargetState,
  ConnectionUpdatePayload
} from '@hermes/shared'
import { atom, computed } from 'nanostores'

import { $gateway } from './gateway'

export type { ConnectionSettleReason, ConnectionTargetAction, ConnectionTargetKind, ConnectionTargetState }

/** One target of the operation as the renderer knows it. State comes only from the backend
 *  (`connection.request`, `connectors.operation.status`, `connection.update`); the card never sets it. */
export interface ConnectionTarget {
  name: string
  kind: ConnectionTargetKind
  action: ConnectionTargetAction
  state: ConnectionTargetState
  detail: string
  connectUrl: null | string
  tools: string[]
}

/** The session's connection operation. `deadlineAt`, `opId`, `targets[].state`, `settled` and
 *  `settledBy` are backend-owned; the renderer holds a cache and drives it through `connection.respond`. */
export interface ConnectionRequest {
  /** Present when the card was raised by a `connection.request` event; absent on a resume snapshot. */
  requestId: null | string
  opId: string
  /** Unix seconds; backend-owned. */
  deadlineAt: number
  reason: string
  targets: ConnectionTarget[]
  settled: boolean
  settledBy: ConnectionSettleReason | null
  /** Local receipt time (Unix seconds), used to reject stale resume cleanup. */
  receivedAt?: number
  sessionId: string | null
}

/** What the card may say about one target. A managed target can only be skipped from the card; an
 *  MCP target's flow outcome is reported by the renderer that ran it. Anything else is refused by the
 *  backend's transition table (4002). */
export type ConnectionTargetOutcome =
  | { name: string; status: 'skipped' }
  | { name: string; status: 'connected'; tools?: string[] }
  | { name: string; status: 'initiated' }
  | { name: string; status: 'failed'; detail?: string }

export interface ConnectionOutcome {
  targets?: ConnectionTargetOutcome[]
  /** `continue` ends the operation now with unresolved targets stamped `not_connected`. */
  settled_by?: 'continue'
}

const keyFor = (sessionId: string | null | undefined): string => sessionId ?? ''

export const $connectionRequests = atom<Record<string, ConnectionRequest>>({})

export const sessionConnectionRequest = (sessionId: string | null) =>
  computed($connectionRequests, requests => requests[keyFor(sessionId)] ?? null)

const TARGET_STATES: readonly ConnectionTargetState[] = [
  'connected',
  'expired',
  'failed',
  'initiated',
  'not_connected',
  'pending',
  'skipped',
  'unavailable'
]

const ACTIONS: readonly ConnectionTargetAction[] = ['authorize', 'connect', 'enable', 'install', 'reconnect']
const SETTLE_REASONS: readonly ConnectionSettleReason[] = ['all_resolved', 'continue', 'deadline', 'interrupt', 'unavailable']

// The wire carries these as typed literals already; the lookups defend against a backend a version ahead.
const oneOf =
  <T extends string>(allowed: readonly T[]) =>
  (value: null | string | undefined): T | undefined =>
    allowed.find(candidate => candidate === value)

const targetState = oneOf(TARGET_STATES)
const targetAction = oneOf(ACTIONS)
const settleReason = oneOf(SETTLE_REASONS)

// The request payload names targets without state; a resume snapshot may carry a live snapshot row.
type WireTarget = ConnectionRequestTarget | ConnectionOperationTarget

function parseTarget(entry: WireTarget): ConnectionTarget | null {
  const name = entry.name.trim()

  if (!name) {
    return null
  }

  const live = 'state' in entry ? entry : null

  return {
    action: targetAction(entry.action) ?? 'install',
    connectUrl: live?.connect_url ?? null,
    detail: live?.detail ?? '',
    kind: entry.kind === 'connector' ? 'connector' : 'mcp',
    name,
    state: targetState(live?.state) ?? 'pending',
    tools: live?.tools ?? []
  }
}

/** Parse a `connection.request` event or the `pending_connection` resume field. Null when the payload
 *  carries no usable operation (no op id, no deadline, no targets). */
export function normalizeConnectionRequest(
  payload: ConnectionRequestPayload | null | undefined,
  sessionId: string | null
): ConnectionRequest | null {
  if (!payload) {
    return null
  }

  const targets = payload.targets.map(parseTarget).filter((target): target is ConnectionTarget => target !== null)

  if (!payload.op_id || !(payload.deadline_at > 0) || targets.length === 0) {
    return null
  }

  return {
    deadlineAt: payload.deadline_at,
    opId: payload.op_id,
    reason: payload.reason ?? '',
    receivedAt: Date.now() / 1000,
    requestId: payload.request_id ?? null,
    sessionId,
    settled: false,
    settledBy: null,
    targets
  }
}

/** Overlay the authoritative `connectors.operation.status` snapshot on the cached request. */
export function applyOperationStatus(request: ConnectionRequest, status: ConnectionOperationStatus): ConnectionRequest {
  if (status.op_id !== request.opId) {
    return request
  }

  const byName = new Map(status.targets.map(target => [target.name, target] as const))

  return {
    ...request,
    deadlineAt: status.deadline_at,
    settled: status.settled,
    settledBy: settleReason(status.settled_by) ?? null,
    targets: request.targets.map(target => {
      const live: ConnectionOperationTarget | undefined = byName.get(target.name)

      return live ? mergeLiveTarget(target, live) : target
    })
  }
}

function mergeLiveTarget(target: ConnectionTarget, live: ConnectionOperationTarget): ConnectionTarget {
  return {
    ...target,
    connectUrl: live.connect_url ?? target.connectUrl,
    detail: live.detail ?? target.detail,
    state: live.state,
    tools: live.tools ?? target.tools
  }
}

/** Apply one `connection.update` frame. Frames for another operation or for a settled request are ignored. */
export function applyConnectionUpdate(request: ConnectionRequest, update: ConnectionUpdatePayload): ConnectionRequest {
  if (update.op_id !== request.opId || request.settled) {
    return request
  }

  const to = targetState(update.to)

  const targets =
    update.target && to
      ? request.targets.map(target =>
          target.name === update.target ? { ...target, detail: update.detail ?? target.detail, state: to } : target
        )
      : request.targets

  return {
    ...request,
    settled: update.settled,
    settledBy: settleReason(update.settled_by) ?? request.settledBy,
    targets
  }
}

export function setConnectionRequest(request: ConnectionRequest): void {
  $connectionRequests.set({ ...$connectionRequests.get(), [keyFor(request.sessionId)]: request })
}

export function updateConnectionRequest(sessionId: string | null, update: ConnectionUpdatePayload): void {
  const current = $connectionRequests.get()[keyFor(sessionId)]

  if (!current) {
    return
  }

  const next = applyConnectionUpdate(current, update)

  if (next !== current) {
    setConnectionRequest(next)
  }
}

export function clearConnectionRequest(opId?: string, sessionId?: string | null): void {
  const requests = $connectionRequests.get()

  if (sessionId !== undefined) {
    const key = keyFor(sessionId)
    const current = requests[key]

    if (!current || (opId && current.opId !== opId)) {
      return
    }

    const next = { ...requests }
    delete next[key]
    $connectionRequests.set(next)

    return
  }

  const kept = Object.entries(requests).filter(([, value]) => opId && value.opId !== opId)

  if (kept.length !== Object.keys(requests).length) {
    $connectionRequests.set(Object.fromEntries(kept))
  }
}

/** The composer's Enter handler reads this without subscribing. */
export const hasConnectionRequest = (sessionId: string | null | undefined): boolean => {
  const request = $connectionRequests.get()[keyFor(sessionId)]

  return Boolean(request && !request.settled)
}

/** Drive the operation. The entry stays in the store: the backend answers with `connection.update`
 *  and the card re-renders from that; only settlement removes it. */
export async function respondToConnectionRequest(request: ConnectionRequest, outcome: ConnectionOutcome): Promise<boolean> {
  const current = $connectionRequests.get()[keyFor(request.sessionId)]

  if (!current || current.opId !== request.opId || current.settled) {
    return false
  }

  await $gateway.get()?.request('connection.respond', {
    op_id: request.opId,
    result: JSON.stringify(outcome),
    session_id: request.sessionId
  })

  return true
}

/** Not now on one target. */
export const skipConnectionTarget = (request: ConnectionRequest, name: string): Promise<boolean> =>
  respondToConnectionRequest(request, { targets: [{ name, status: 'skipped' }] })

/** Continue: end the operation now with whatever is unresolved. */
export const continueConnectionRequest = (request: ConnectionRequest): Promise<boolean> =>
  respondToConnectionRequest(request, { settled_by: 'continue' })

// Typing a message while the card is open ends the operation, otherwise the typed message waits behind
// the blocked tool until the deadline.
export async function skipConnectionRequest(sessionId: string | null | undefined): Promise<boolean> {
  const request = $connectionRequests.get()[keyFor(sessionId)]

  if (!request || request.settled) {
    return false
  }

  try {
    await continueConnectionRequest(request)
  } catch {
    // A failed skip must not block the message; the tool settles at its deadline.
  }

  return true
}
