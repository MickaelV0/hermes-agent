'use client'

import { type ToolCallMessagePartProps, useAuiState } from '@assistant-ui/react'
import { useStore } from '@nanostores/react'
import { useEffect, useMemo, useState } from 'react'

import { useSessionView } from '@/app/chat/session-view'
import {
  CONNECTOR_CARD_PHASES,
  type ConnectorOwner,
  MARK_LABEL,
  reissueConnectionTarget,
  useConnectionOwner
} from '@/components/assistant-ui/connector-tool'
import { ToolFallback } from '@/components/assistant-ui/tool/fallback'
import { WIDGET_SHELL_CLASS } from '@/components/chat/widget-shell'
import { Button } from '@/components/ui/button'
import { ConnectorCard, ConnectorRow, type ConnectorRowAction, ConnectorSummary } from '@/components/ui/connector-card'
import { useI18n } from '@/i18n'
import { connectorText, type McpTarget, mcpTargets } from '@/lib/connector-tools'
import { Loader2 } from '@/lib/icons'
import { prettyName } from '@/lib/text'
import { cn } from '@/lib/utils'
import {
  type ConnectionRequest,
  type ConnectionTarget,
  type ConnectionTargetState,
  continueConnectionRequest,
  respondToConnectionRequest,
  sessionConnectionRequest
} from '@/store/connection-request'
import { notifyError } from '@/store/notifications'
import { invalidateMcpSuggestionIndex } from '@/store/suggestion-providers/mcp'

import { selectMessageRunning } from './tool/fallback-model'
import { parseMaybeObject } from './tool/fallback-model/format'

type SetupAction = McpTarget['action']
type SetupCopy = ReturnType<typeof useI18n>['t']['assistant']['mcpSetup']

const SHELL_CLASS = `${WIDGET_SHELL_CLASS} text-[length:var(--conversation-text-font-size)] text-(--ui-text-primary)`

const TITLE = {
  authorize: (copy: SetupCopy) => copy.authorizeTitle,
  enable: (copy: SetupCopy) => copy.enableTitle,
  install: (copy: SetupCopy) => copy.installTitle
} satisfies Record<SetupAction, (copy: SetupCopy) => string>

const VERB = {
  authorize: (copy: SetupCopy) => copy.authorizeAction,
  enable: (copy: SetupCopy) => copy.enableAction,
  install: (copy: SetupCopy) => copy.installAction
} satisfies Record<SetupAction, (copy: SetupCopy) => string>

const DONE = {
  authorize: (copy: SetupCopy, server: string) => copy.authorized(server),
  enable: (copy: SetupCopy, server: string) => copy.enabled(server),
  install: (copy: SetupCopy, server: string) => copy.installed(server)
} satisfies Record<SetupAction, (copy: SetupCopy, server: string) => string>

/** The row's one verb. `approve` is the user's consent, `working` is the backend acting on it, `open`
 *  is a sign-in link the backend already minted, `reissue` asks for a fresh attempt. */
type McpVerb = 'approve' | 'none' | 'open' | 'reissue' | 'working'

const MCP_VERBS = {
  connected: 'none',
  expired: 'reissue',
  failed: 'reissue',
  initiated: 'open',
  not_connected: 'none',
  pending: 'approve',
  skipped: 'none',
  unavailable: 'none'
} satisfies Record<ConnectionTargetState, McpVerb>

// Only `initiated` depends on the action: authorize hands the user a link, install and enable run on
// the backend with nothing for the user to do.
const rowVerb = (target: ConnectionTarget, action: SetupAction): McpVerb =>
  target.state === 'initiated' && action !== 'authorize' ? 'working' : MCP_VERBS[target.state]

function readSetupAction(args: unknown): SetupAction {
  const [target] = mcpTargets('manage_connections', parseMaybeObject(args))

  return target?.action ?? 'install'
}

interface SettledTarget {
  name: string
  state: string
  tools: number
}

function readSetupResult(result: unknown): SettledTarget[] {
  const row = parseMaybeObject(result)
  const targets = Array.isArray(row.targets) ? row.targets.map(parseMaybeObject) : []

  return targets.flatMap(target => {
    const name = connectorText(target.name)

    return name
      ? [{ name, state: connectorText(target.state) ?? '', tools: Array.isArray(target.tools) ? target.tools.length : 0 }]
      : []
  })
}

export const McpSetupTool = (props: ToolCallMessagePartProps) => {
  if (props.result !== undefined) {
    return <McpSetupSettled {...props} />
  }

  return <McpSetupLive {...props} />
}

const McpSetupLive = (props: ToolCallMessagePartProps) => {
  const messageRunning = useAuiState(selectMessageRunning)

  if (!messageRunning) {
    return <ToolFallback {...props} />
  }

  return <McpSetupPending {...props} />
}

function McpSetupSettled({ args, result }: ToolCallMessagePartProps) {
  const { t } = useI18n()
  const copy = t.assistant.mcpSetup
  const action = useMemo(() => readSetupAction(args), [args])
  const targets = useMemo(() => readSetupResult(result), [result])

  return (
    <div className="my-2 grid min-w-0 max-w-lg gap-1">
      {targets.map(target => {
        const title = prettyName(target.name)
        const connected = target.state === 'connected'

        const line = connected
          ? DONE[action](copy, title)
          : target.state === 'skipped'
            ? t.connectors.skipped
            : t.connectors.notConnected

        return (
          <ConnectorSummary
            connector={{ name: target.name, title }}
            key={target.name}
            meta={connected && target.tools > 0 ? `${line} · ${copy.toolCount(target.tools)}` : line}
            tone={connected ? 'ok' : undefined}
          />
        )
      })}
    </div>
  )
}

export function McpSetupPending({ args }: ToolCallMessagePartProps) {
  const { t } = useI18n()
  const copy = t.assistant.mcpSetup
  const view = useSessionView()
  // Use the rendering transcript's session, not the globally active one.
  const sessionId = useStore(view.$runtimeId)
  // Owner routes and hints are keyed by the stored id, not the runtime id the events carry.
  const storedId = useStore(view.$storedId)
  const $request = useMemo(() => sessionConnectionRequest(sessionId), [sessionId])
  const request = useStore($request)
  const action = useMemo(() => readSetupAction(args), [args])
  const owner = useConnectionOwner(storedId, request !== null)

  // `tool.start` arrives before `connection.request`.
  if (!request) {
    return (
      <div className={cn(SHELL_CLASS, 'my-1.5 flex items-center gap-2')} data-slot="connector-card">
        <Loader2 aria-hidden className="size-4 animate-spin text-(--ui-text-tertiary)" />
        <span className="text-(--ui-text-tertiary)">{TITLE[action](copy)}</span>
      </div>
    )
  }

  return <McpSetupOffer action={action} owner={owner} request={request} />
}

interface McpSetupOfferProps {
  action: SetupAction
  /** Null until the session's owner resolves; only Try again needs it, so the rest of the card works. */
  owner: ConnectorOwner | null
  request: ConnectionRequest
}

/** The card is a projection of the operation: one row per target, one verb per row, Continue below. */
export function McpSetupOffer({ action, owner, request }: McpSetupOfferProps) {
  const { t } = useI18n()
  const copy = t.assistant.mcpSetup
  const [reissuing, setReissuing] = useState<ReadonlySet<string>>(new Set())
  const unresolved = request.targets.some(target => !CONNECTOR_CARD_PHASES[target.state].resolved)

  // Try again is one RPC on the open operation. An authorize target comes back with a fresh link,
  // which opens at once; install and enable simply run again and report through connection.update.
  const reissue = async (name: string): Promise<void> => {
    if (!owner) {
      return
    }

    setReissuing(current => new Set(current).add(name))

    try {
      const url = await reissueConnectionTarget(owner, request, name)

      if (url) {
        void window.hermesDesktop?.openExternal?.(url)
      }
    } catch (error) {
      notifyError(error, copy.failed(prettyName(name)))
    } finally {
      setReissuing(current => {
        const next = new Set(current)
        next.delete(name)

        return next
      })
    }
  }

  return (
    <div className="my-2 grid min-w-0 max-w-lg gap-1" data-connector-offer>
      <ConnectorCard title={TITLE[action](copy)}>
        {request.targets.map(target => (
          <McpSetupRow
            action={action}
            key={target.name}
            onReissue={() => void reissue(target.name)}
            reissueBlocked={!owner || reissuing.size > 0}
            reissuing={reissuing.has(target.name)}
            request={request}
            target={target}
          />
        ))}
      </ConnectorCard>
      {unresolved ? (
        <div className="px-3.5">
          <Button onClick={() => void continueConnectionRequest(request)} size="xs" variant="textStrong">
            {t.common.continue}
          </Button>
        </div>
      ) : null}
    </div>
  )
}

interface McpSetupRowProps {
  action: SetupAction
  onReissue: () => void
  /** The owner has not resolved, or another row's Try again is in flight. */
  reissueBlocked: boolean
  reissuing: boolean
  request: ConnectionRequest
  target: ConnectionTarget
}

function McpSetupRow({ action, onReissue, reissueBlocked, reissuing, request, target }: McpSetupRowProps) {
  const { t } = useI18n()
  const copy = t.assistant.mcpSetup
  const [envDraft, setEnvDraft] = useState<Record<string, string>>({})
  const [sending, setSending] = useState(false)
  const server = target.name
  const phase = CONNECTOR_CARD_PHASES[target.state]
  const verb = rowVerb(target, action)
  const fields = target.requiredEnv
  const missing = fields.some(field => field.required && !envDraft[field.name]?.trim())

  // The composer's MCP suggestion index caches the configured servers; this row just changed them.
  useEffect(() => {
    if (target.state === 'connected') {
      invalidateMcpSuggestionIndex()
    }
  }, [target.state])

  const approve = async () => {
    setSending(true)

    try {
      await respondToConnectionRequest(request, {
        targets: [{ env: fields.length > 0 ? envDraft : undefined, name: server, status: 'approved' }]
      })
    } catch (error) {
      notifyError(error, copy.sendFailed)
    } finally {
      setSending(false)
    }
  }

  const label = VERB[action](copy)

  const ACTIONS = {
    approve: { busy: sending, disabled: missing, label, onClick: () => void approve() },
    open: {
      disabled: target.connectUrl === null,
      label,
      onClick: () => {
        if (target.connectUrl) {
          void window.hermesDesktop?.openExternal?.(target.connectUrl)
        }
      }
    },
    reissue: { busy: reissuing, disabled: reissueBlocked && !reissuing, label: t.connectors.retry, onClick: onReissue },
    working: { busy: true, label, onClick: () => {} }
  } satisfies Record<Exclude<McpVerb, 'none'>, ConnectorRowAction>

  return (
    <ConnectorRow
      action={verb === 'none' ? undefined : ACTIONS[verb]}
      connector={{ name: server, title: prettyName(server) }}
      // The one cue belongs to the row whose link is open in the user's browser.
      cue={verb === 'open' ? t.connectors.waiting : undefined}
      envDraft={envDraft}
      envFields={fields}
      envOpen={verb === 'approve' && fields.length > 0}
      envRequired={copy.envRequired}
      mark={phase.mark}
      markLabel={MARK_LABEL[phase.mark](t.connectors)}
      onEnvChange={(key, value) => setEnvDraft(prev => ({ ...prev, [key]: value }))}
    />
  )
}
