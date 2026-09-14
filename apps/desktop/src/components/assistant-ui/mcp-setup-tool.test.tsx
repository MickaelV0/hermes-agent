import type { ToolCallMessagePartProps } from '@assistant-ui/react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { atom } from 'nanostores'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { type SessionView, SessionViewProvider } from '@/app/chat/session-view'
import type { ConnectorOwner } from '@/components/assistant-ui/connector-tool'
import { McpSetupOffer, McpSetupPending, McpSetupTool } from '@/components/assistant-ui/mcp-setup-tool'
import { I18nProvider } from '@/i18n'
import {
  $connectionRequests,
  type ConnectionRequest,
  type ConnectionTarget,
  setConnectionRequest
} from '@/store/connection-request'
import { $gateway, setPrimaryGateway } from '@/store/gateway'

const SESSION_ID = 'session-1'
// A null connection id routes the card's own RPCs through the primary gateway socket.
const PRIMARY_OWNER: ConnectorOwner = { connectionId: null, profile: 'default' }

const LINEAR: ConnectionTarget = {
  action: 'install',
  connectUrl: null,
  connectionId: '',
  detail: '',
  kind: 'mcp',
  name: 'linear',
  requiredEnv: [],
  state: 'pending',
  tools: []
}

const REQUEST: ConnectionRequest = {
  deadlineAt: 1_800_000_000,
  opId: 'operation-1',
  seq: 0,
  toolCallId: 'mcp-call-1',
  sessionId: SESSION_ID,
  settled: false,
  settledBy: null,
  targets: [LINEAR, { ...LINEAR, name: 'postgres' }]
}

const ARGS = {
  action: 'install',
  connectors: [
    { mcp: true, name: 'linear' },
    { mcp: true, name: 'postgres' }
  ]
}

function props(result?: ToolCallMessagePartProps['result']): ToolCallMessagePartProps {
  return {
    addResult: vi.fn(),
    args: ARGS,
    argsText: JSON.stringify(ARGS),
    isError: false,
    respondToApproval: vi.fn(),
    result,
    resume: vi.fn(),
    status: result === undefined ? { type: 'running' } : { type: 'complete' },
    toolCallId: 'mcp-call-1',
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

// The live gate (message still running) is assistant-ui state; the pending card renders below it.
function renderTool(result?: ToolCallMessagePartProps['result']) {
  const Card = result === undefined ? McpSetupPending : McpSetupTool

  return render(
    <I18nProvider configClient={null} initialLocale="en">
      <SessionViewProvider value={view(SESSION_ID)}>
        <Card {...props(result)} />
      </SessionViewProvider>
    </I18nProvider>
  )
}

/** The card with its owner already resolved, the way the transcript hands it over. */
function renderOffer(request = REQUEST, action: 'authorize' | 'enable' | 'install' = 'install') {
  return render(
    <I18nProvider configClient={null} initialLocale="en">
      <McpSetupOffer action={action} owner={PRIMARY_OWNER} request={request} />
    </I18nProvider>
  )
}

afterEach(() => {
  cleanup()
  $connectionRequests.set({})
  $gateway.set(null)
  setPrimaryGateway(null)
  vi.clearAllMocks()
})

describe('the MCP setup card', () => {
  it('shows one row per target with its verb, and Continue below', () => {
    setConnectionRequest(REQUEST)

    renderTool()

    expect(screen.getByText('Add MCP servers')).toBeTruthy()
    expect(screen.getByText('Linear', { selector: 'span' })).toBeTruthy()
    expect(screen.getByText('Postgres', { selector: 'span' })).toBeTruthy()
    expect(screen.getAllByRole('button', { name: 'Install' })).toHaveLength(2)
    expect(screen.getByRole('button', { name: 'Continue' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Not now' })).toBeNull()
  })

  it('Install is consent: it sends approved through connection.respond and calls nothing else', async () => {
    const request = vi.fn().mockResolvedValue({ status: 'ok' })
    // SAFETY: the store calls only `request`; the rest of the client is never touched in these tests.
    $gateway.set({ request } as never)
    setConnectionRequest(REQUEST)

    renderOffer()
    fireEvent.click(screen.getAllByRole('button', { name: 'Install' })[0])

    await waitFor(() => {
      expect(request).toHaveBeenCalledWith('connection.respond', {
        op_id: 'operation-1',
        result: JSON.stringify({ targets: [{ name: 'linear', status: 'approved' }] }),
        session_id: SESSION_ID
      })
    })
    expect(request.mock.calls.map(([method]) => method)).toEqual(['connection.respond'])
  })

  it('an authorize row opens the link the backend minted, with no OAuth call of its own', () => {
    const request = vi.fn()
    // SAFETY: the store calls only `request`; the rest of the client is never touched in these tests.
    $gateway.set({ request } as never)
    const openExternal = vi.fn()
    // SAFETY: the card reads only `openExternal` from the preload bridge.
    window.hermesDesktop = { openExternal } as never

    renderOffer(
      {
        ...REQUEST,
        targets: [{ ...LINEAR, action: 'authorize', connectUrl: 'https://mcp.example/auth', state: 'initiated' }]
      },
      'authorize'
    )

    fireEvent.click(screen.getByRole('button', { name: 'Authorize' }))

    expect(openExternal).toHaveBeenCalledWith('https://mcp.example/auth')
    expect(request).not.toHaveBeenCalled()
  })

  it('a row waiting on credentials shows the fields, holds Install, and sends what was typed', async () => {
    const request = vi.fn().mockResolvedValue({ status: 'ok' })
    // SAFETY: the store calls only `request`; the rest of the client is never touched in these tests.
    $gateway.set({ request } as never)
    setConnectionRequest(REQUEST)

    renderOffer({
      ...REQUEST,
      targets: [{ ...LINEAR, requiredEnv: [{ name: 'LINEAR_API_KEY', prompt: 'Linear API key', required: true }] }]
    })

    expect(screen.getByRole('button', { name: 'Install' }).hasAttribute('disabled')).toBe(true)

    fireEvent.change(screen.getByLabelText(/Linear API key/), { target: { value: 'lin_123' } })

    const install = screen.getByRole('button', { name: 'Install' })
    expect(install.hasAttribute('disabled')).toBe(false)
    fireEvent.click(install)

    await waitFor(() => {
      expect(request).toHaveBeenCalledWith('connection.respond', {
        op_id: 'operation-1',
        result: JSON.stringify({ targets: [{ env: { LINEAR_API_KEY: 'lin_123' }, name: 'linear', status: 'approved' }] }),
        session_id: SESSION_ID
      })
    })
  })

  it('Try again on a failed row re-runs the flow on the open operation', async () => {
    const request = vi.fn().mockResolvedValue({ targets: [{ name: 'linear', state: 'initiated' }] })
    // SAFETY: the card calls only `request` on the primary socket; nothing else on the client is touched.
    setPrimaryGateway({ request } as never)

    renderOffer({ ...REQUEST, targets: [{ ...LINEAR, state: 'failed' }] })
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))

    await waitFor(() => {
      expect(request).toHaveBeenCalledTimes(1)
    })

    const [method, params] = request.mock.calls[0]

    expect(method).toBe('connectors.connect')
    expect(params).toMatchObject({ connectors: ['linear'], reconnect: true, session_id: SESSION_ID })
  })


  it('paints no card for a tool call that did not open the operation', () => {
    setConnectionRequest({ ...REQUEST, toolCallId: 'mcp-call-0' })

    renderTool()

    expect(screen.queryByText('Linear', { selector: 'span' })).toBeNull()
    expect(screen.queryAllByRole('button')).toHaveLength(0)
  })

  it('holds Install from the click until the state frame moves the row', async () => {
    const request = vi.fn().mockResolvedValue({ status: 'ok' })
    // SAFETY: the store calls only `request`; the rest of the client is never touched in these tests.
    $gateway.set({ request } as never)
    setConnectionRequest(REQUEST)

    renderOffer()
    const install = screen.getAllByRole('button', { name: 'Install' })[0]
    fireEvent.click(install)

    await waitFor(() => {
      expect(request).toHaveBeenCalledTimes(1)
    })

    expect(install.hasAttribute('disabled')).toBe(true)
    fireEvent.click(install)

    expect(request).toHaveBeenCalledTimes(1)
  })

  it('offers nothing to approve on an authorize row: the backend is still minting the link', () => {
    renderOffer({ ...REQUEST, targets: [{ ...LINEAR, action: 'authorize', state: 'pending' }] }, 'authorize')

    expect(screen.queryByRole('button', { name: 'Authorize' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Continue' })).toBeTruthy()
  })

  it('drops its controls the moment the operation settles, and says how each target ended', () => {
    renderOffer({
      ...REQUEST,
      settled: true,
      settledBy: 'continue',
      targets: [
        { ...LINEAR, state: 'connected', tools: ['a', 'b'] },
        { ...LINEAR, name: 'postgres', state: 'skipped' }
      ]
    })

    expect(screen.getByText('Installed Linear · 2 tools')).toBeTruthy()
    expect(screen.getByText('Skipped')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull()
    expect(
      [...window.document.querySelectorAll('[data-connector-offer] button')].every(button =>
        button.hasAttribute('disabled')
      )
    ).toBe(true)
  })

  it('lists every target once settled, in the same three words as the connector card', () => {
    renderTool({
      settled_by: 'continue',
      status: 'settled',
      targets: [
        { action: 'install', kind: 'mcp', name: 'linear', state: 'connected', tools: ['a', 'b'] },
        { action: 'install', detail: 'catalog write failed', kind: 'mcp', name: 'postgres', state: 'not_connected' }
      ]
    })

    expect(screen.getByText('Installed Linear · 2 tools')).toBeTruthy()
    expect(screen.getByText('Not connected')).toBeTruthy()
    expect(screen.queryByText(/catalog write failed/)).toBeNull()
    expect(screen.queryAllByRole('button').filter(button => !button.hasAttribute('disabled'))).toHaveLength(0)
  })
})
