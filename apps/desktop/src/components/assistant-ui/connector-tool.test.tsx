import type { ToolCallMessagePartProps } from '@assistant-ui/react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { atom } from 'nanostores'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { type SessionView, SessionViewProvider } from '@/app/chat/session-view'
import { ConnectorOffer, ConnectorTool } from '@/components/assistant-ui/connector-tool'
import { I18nProvider } from '@/i18n'
import { $connectionRequests, type ConnectionRequest, setConnectionRequest } from '@/store/connection-request'
import { $gateway } from '@/store/gateway'
import { _resetSessionOwnerHintsForTests, setSessionOwnerHint } from '@/store/session'

const SESSION_ID = 'session-1'
const OWNER = { connectionId: 'connection-1', profile: 'default' }

const REQUEST: ConnectionRequest = {
  deadlineAt: 1_800_000_000,
  opId: 'operation-1',
  reason: 'Use Gmail',
  requestId: 'connector-call-1',
  sessionId: SESSION_ID,
  settled: false,
  settledBy: null,
  targets: [
    {
      action: 'connect',
      connectUrl: 'https://connect.example/gmail',
      detail: '',
      kind: 'connector',
      name: 'gmail',
      state: 'pending',
      tools: []
    }
  ]
}

function props(): ToolCallMessagePartProps {
  const args = { action: 'connect', connectors: ['gmail'] }

  return {
    addResult: vi.fn(),
    args,
    argsText: JSON.stringify(args),
    isError: false,
    respondToApproval: vi.fn(),
    result: undefined,
    resume: vi.fn(),
    status: { type: 'running' },
    toolCallId: 'connector-call-1',
    toolName: 'manage_connections',
    type: 'tool-call'
  }
}

function view(sessionId: string): SessionView {
  return {
    $awaitingResponse: atom(false),
    $busy: atom(false),
    $cwd: atom(''),
    $fast: atom(false),
    $lastVisibleIsUser: atom(false),
    $messages: atom([]),
    $messagesEmpty: atom(false),
    $model: atom(''),
    $provider: atom(''),
    $reasoningEffort: atom(''),
    $runtimeId: atom(sessionId),
    $storedId: atom(sessionId),
    $turnStartedAt: atom(null),
    kind: 'primary'
  }
}

function renderOffer(request = REQUEST) {
  return render(
    <I18nProvider configClient={null} initialLocale="en">
      <ConnectorOffer owner={OWNER} request={request} />
    </I18nProvider>
  )
}

function renderConnector(request = REQUEST) {
  setSessionOwnerHint(SESSION_ID, OWNER)
  setConnectionRequest(request)

  return render(
    <I18nProvider configClient={null} initialLocale="en">
      <SessionViewProvider value={view(SESSION_ID)}>
        <ConnectorTool {...props()} />
      </SessionViewProvider>
    </I18nProvider>
  )
}

afterEach(() => {
  cleanup()
  $connectionRequests.set({})
  $gateway.set(null)
  _resetSessionOwnerHintsForTests({ storage: true })
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('ConnectorTool operation card', () => {
  it('does not call connectors.list or create a timer on mount', () => {
    vi.useFakeTimers()
    const request = vi.fn()
    // SAFETY: the store calls only `request`; the rest of the client is never touched in these tests.
    $gateway.set({ request } as never)

    renderOffer()

    expect(request).not.toHaveBeenCalledWith('connectors.list', expect.anything())
    expect(vi.getTimerCount()).toBe(0)
  })

  it('sends Not now as a per-target skipped response', async () => {
    const request = vi.fn().mockResolvedValue({ status: 'ok' })
    // SAFETY: the store calls only `request`; the rest of the client is never touched in these tests.
    $gateway.set({ request } as never)

    renderConnector()

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Not now' })).toBeTruthy()
    })
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }))

    await waitFor(() => {
      expect(request).toHaveBeenCalledWith('connection.respond', {
        op_id: 'operation-1',
        result: JSON.stringify({ targets: [{ name: 'gmail', status: 'skipped' }] }),
        session_id: SESSION_ID
      })
    })
  })

  it('renders settled operations with no live controls', () => {
    renderOffer({ ...REQUEST, settled: true, settledBy: 'all_resolved' })

    // ScaffoldRow paints every settled tool row as a disabled disclosure button; the contract is
    // that nothing is actionable: no enabled button, no Connect / Not now / Continue.
    const buttons = [...window.document.querySelectorAll('[data-connector-offer] button')]

    expect(buttons.every(button => button.hasAttribute('disabled'))).toBe(true)
    expect(screen.queryByRole('button', { name: 'Not now' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull()
  })
})
