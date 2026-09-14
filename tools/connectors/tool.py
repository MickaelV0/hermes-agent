#!/usr/bin/env python3
"""Connection lifecycle tool for managed gateway accounts and local MCP servers.

Disconnecting accounts remains a portal-only user decision.
"""

from typing import Any, Callable, Dict, Optional

from tools.connectors.gateway import config as gateway_config
from tools.connectors.managed import (
    _WAIT_DEFAULT_SECONDS,
    _WAIT_MAX_SECONDS,
    _WAIT_MIN_SECONDS,
    run_managed_action,
)
from tools.connectors.mcp import run_mcp_operation
from tools.connectors.targets import ALL_ACTIONS, MCP_ACTIONS, normalize_targets, validate_action
from tools.registry import registry, tool_error



def manage_connections(
    args: Dict[str, Any],
    *,
    client_factory: Optional[Callable[[], Any]] = None,
    seen_instructions: Optional[set] = None,
    rendered_links: Optional[Dict[str, Dict[str, float]]] = None,
    session_id: Optional[str] = None,
    connection_callback: Optional[Callable[[Dict[str, Any]], Optional[str]]] = None,
    connectors_available: Optional[Callable[[], bool]] = None,
    wait_seconds: Optional[float] = None,
) -> str:
    action = str(args.get("action") or "status").strip().lower()
    managed, mcp_targets, target_error = normalize_targets(args.get("connectors"))
    if target_error:
        return tool_error(target_error)
    action_error = validate_action(action, managed, mcp_targets)
    if action_error:
        return tool_error(action_error)

    if action in MCP_ACTIONS:
        return run_mcp_operation(
            mcp_targets, action, str(args.get("reason") or "").strip(),
            connection_callback=connection_callback, session_id=session_id, wait_seconds=wait_seconds,
        )

    return run_managed_action(
        action, managed, args,
        client_factory=client_factory, seen_instructions=seen_instructions,
        rendered_links=rendered_links, session_id=session_id,
        connectors_available=connectors_available,
    )

MANAGE_CONNECTIONS_SCHEMA = {
    "name": "manage_connections",
    "description": (
        "Connect the user to apps: managed connector accounts (Gmail, Notion, ...) served "
        "through the tool gateway, and local MCP servers from the catalog. Targets go in "
        "'connectors': a bare slug or {\"name\": \"gmail\"} is a managed connector; "
        "{\"name\": \"linear\", \"mcp\": true} is a local MCP server. "
        "Managed actions: 'status' lists connectors and whether each is connected; 'connect' "
        "starts an authorization for the given connectors and returns a link "
        "for the USER to open in a browser (never open it yourself); "
        "'reconnect' restarts a broken authorization; "
        "'wait' blocks until the given connectors report connected. Pass "
        "SEVERAL slugs in one call to get all authorization links at once. "
        "When a connector tool "
        "call returns CONNECTION_REQUIRED, use 'connect' and show the link. "
        "Send the message that shows the user the links FIRST; on your NEXT "
        "turn call 'wait' with those same slugs instead of guessing when the "
        "user is done — it polls for you (a wait in the same turn as the "
        "connect is bounced, because the user cannot have seen the links "
        "yet). 'wait' requires 'connectors', and only accepts connectors this "
        "session already addressed with 'connect' (already-connected apps "
        "count). A 'timeout' or 'interrupted' result is NOT an "
        "error: the user has not finished connecting, so ask them whether to "
        "keep waiting, continue without those apps, or get fresh links. "
        "MCP actions (targets must carry \"mcp\": true): 'install' adds a catalog entry, "
        "'enable' re-enables a disabled configured server, 'authorize' runs its OAuth. "
        "They show the user an approval card and block until it settles; the result lists "
        "each target as connected / skipped / not_connected. Never hand-edit mcp_servers "
        "config — always use this tool. Never re-ask after a skip or timeout: continue "
        "without the server or ask in chat. A newly installed or authorized server's tools "
        "arrive on your next turn. Off the desktop app the MCP targets come back "
        "'unavailable' with the terminal commands to give the user. "
        "This tool can NOT disconnect, delete, or revoke an account — that is "
        "deliberately user-only. When asked, say so and direct the user to "
        "the Nous Portal (their org's Connectors page) or the desktop app."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "action": {
                "type": "string",
                "enum": list(ALL_ACTIONS),
                "description": "Defaults to status. install/enable/authorize need mcp:true targets.",
            },
            "connectors": {
                "type": "array",
                "items": {
                    "anyOf": [
                        {"type": "string"},
                        {
                            "type": "object",
                            "properties": {
                                "name": {"type": "string"},
                                "mcp": {"type": "boolean", "description": "true = local MCP server."},
                            },
                            "required": ["name"],
                            "additionalProperties": False,
                        },
                    ]
                },
                "description": (
                    "Targets. REQUIRED for every action but status "
                    "(e.g. [\"gmail\", {\"name\": \"linear\", \"mcp\": true}]); optional filter for status."
                ),
            },
            "reason": {
                "type": "string",
                "description": "MCP actions: one sentence on the approval card — why this helps right now.",
            },
            "timeout_seconds": {
                "type": "integer",
                "description": (
                    "For action 'wait' only: how long to hold the call open. "
                    f"Defaults to {int(_WAIT_DEFAULT_SECONDS)}, clamped to "
                    f"{int(_WAIT_MIN_SECONDS)}-{int(_WAIT_MAX_SECONDS)}. Ask for "
                    "more and the result carries a 'timeout_note' saying the cap "
                    "was applied; call wait again to keep waiting."
                ),
            },
        },
        "required": [],
    },
}


registry.register(
    name="manage_connections",
    toolset="connections",
    schema=MANAGE_CONNECTIONS_SCHEMA,
    # Keep the portal gate in the handler so signed-out sessions retain MCP approvals.
    # Read the module attribute so tests patch ``gateway.config.connectors_available`` at one seam.
    handler=lambda args, **kw: manage_connections(
        args, session_id=kw.get("session_id"), connectors_available=gateway_config.connectors_available,
    ),
    emoji="🔗",
)
