import { isRecord } from '@assistant-ui/core/internal'
import { atom, computed } from 'nanostores'

import { $gateway } from './gateway'

export type ConnectionTargetKind = 'connector' | 'mcp'
export type ConnectionAction = 'authorize' | 'enable' | 'install'

export interface ConnectionTarget {
  name: string
  kind: ConnectionTargetKind
  action: ConnectionAction
}

/** Backend-owned operation data; renderer must not recompute targets or deadline. */
export interface ConnectionRequest {
  requestId: string
  opId: string
  /** Unix seconds; backend-owned. */
  deadlineAt: number
  reason: string
  targets: ConnectionTarget[]
  /** Local receipt time (Unix seconds), used to reject stale resume cleanup. */
  receivedAt?: number
  sessionId: string | null
}

/** `declined` is a user deferral; `error` is recoverable. */
export type ConnectionTargetStatus = 'authorized' | 'declined' | 'enabled' | 'error' | 'installed'

export interface ConnectionTargetOutcome {
  name: string
  status: ConnectionTargetStatus
  detail?: string
  tools?: string[]
}

export interface ConnectionOutcome {
  targets: ConnectionTargetOutcome[]
  /** The backend derives the settle reason from target states. */
  settled_by?: 'all_resolved' | 'continue'
}

const keyFor = (sessionId: string | null | undefined): string => sessionId ?? ''

export const $connectionRequests = atom<Record<string, ConnectionRequest>>({})

export const sessionConnectionRequest = (sessionId: string | null) =>
  computed($connectionRequests, requests => requests[keyFor(sessionId)] ?? null)

const ACTIONS: readonly ConnectionAction[] = ['install', 'enable', 'authorize']

/** Mirrors `connection.request` and the `pending_connection` resume field. */
export interface ConnectionRequestWire {
  request_id?: string
  op_id?: string
  deadline_at?: number
  reason?: string
  targets?: unknown
}

const str = (value: string | undefined): string => value ?? ''

export function normalizeConnectionRequest(
  payload: ConnectionRequestWire | null | undefined,
  sessionId: string | null
): ConnectionRequest | null {
  if (!payload) {
    return null
  }

  const requestId = str(payload.request_id)
  const opId = str(payload.op_id)
  const deadlineAt = payload.deadline_at && payload.deadline_at > 0 ? payload.deadline_at : 0
  const rawTargets = Array.isArray(payload.targets) ? payload.targets : []

  const targets: ConnectionTarget[] = rawTargets.flatMap(entry => {
    if (!isRecord(entry)) {
      return []
    }

    // SAFETY: isRecord excludes arrays and primitives; fields are validated below.
    const t = entry as { action?: unknown; kind?: unknown; name?: unknown }
    const name = String(t.name ?? '').trim()
    const action = ACTIONS.find(a => a === t.action) ?? 'install'

    return name && t.name === name.trim() ? [{ action, kind: t.kind === 'connector' ? 'connector' : 'mcp', name }] : []
  })

  if (!requestId || !opId || !deadlineAt || targets.length === 0) {
    return null
  }

  return {
    deadlineAt,
    opId,
    reason: str(payload.reason),
    receivedAt: Date.now() / 1000,
    requestId,
    sessionId,
    targets
  }
}

export function setConnectionRequest(request: ConnectionRequest): void {
  $connectionRequests.set({ ...$connectionRequests.get(), [keyFor(request.sessionId)]: request })
}

export function clearConnectionRequest(requestId?: string, sessionId?: string | null): void {
  const requests = $connectionRequests.get()

  if (sessionId !== undefined) {
    const key = keyFor(sessionId)
    const current = requests[key]

    if (!current || (requestId && current.requestId !== requestId)) {
      return
    }

    const next = { ...requests }
    delete next[key]
    $connectionRequests.set(next)

    return
  }

  const next: Record<string, ConnectionRequest> = {}
  let changed = false

  for (const [key, value] of Object.entries(requests)) {
    if (requestId && value.requestId !== requestId) {
      next[key] = value
    } else {
      changed = true
    }
  }

  if (changed) {
    $connectionRequests.set(next)
  }
}

/** The composer's Enter handler reads this without subscribing. */
export const hasConnectionRequest = (sessionId: string | null | undefined): boolean =>
  Boolean($connectionRequests.get()[keyFor(sessionId)])

// Clear first so the card cannot be answered twice.
export async function respondToConnectionRequest(request: ConnectionRequest, outcome: ConnectionOutcome): Promise<boolean> {
  const current = $connectionRequests.get()[keyFor(request.sessionId)]

  if (!current || current.requestId !== request.requestId) {
    return false
  }

  clearConnectionRequest(request.requestId, request.sessionId)

  await $gateway.get()?.request('connection.respond', {
    request_id: request.requestId,
    result: JSON.stringify(outcome)
  })

  return true
}

// Decline before sending: the tool blocks the typed message until its deadline.
export async function skipConnectionRequest(sessionId: string | null | undefined): Promise<boolean> {
  const request = $connectionRequests.get()[keyFor(sessionId)]

  if (!request) {
    return false
  }

  try {
    await respondToConnectionRequest(request, {
      settled_by: 'all_resolved',
      targets: request.targets.map(target => ({ name: target.name, status: 'declined' }))
    })
  } catch {
    // A failed skip must not block the message; the tool settles at its deadline.
  }

  return true
}
