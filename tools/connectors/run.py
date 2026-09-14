"""The one lifecycle every ``manage_connections`` operation follows, whatever the target kind.

``run_operation`` mints the op, registers it in ``live``, lets the kind prepare its targets (a
managed mint, an MCP catalog check), emits the card through the session callback, then loops:
sleep on ``op.wake`` for at most one tick, run the kind's ``observe`` hook, settle when every
target is resolved or the deadline passes. ``connection.respond`` and ``session.interrupt`` reach
the loop only by transitioning the op through ``live`` and setting ``wake``."""

from __future__ import annotations

import json
import time
from dataclasses import dataclass
from typing import Any, Callable, Dict, List, Optional

from tools.connectors import live
from tools.connectors.contract import SettleReason
from tools.connectors.operation import ConnectionOperation, Target

WATCH_INTERVAL_SECONDS = 5.0

Callback = Callable[[Dict[str, Any]], Optional[str]]


@dataclass
class Kind:
    """Per-kind hooks. ``prepare`` runs once before the card; ``observe`` runs every tick and may
    transition targets; ``note`` is the model-facing guidance appended to the settled result."""

    prepare: Callable[[ConnectionOperation], None]
    observe: Callable[[ConnectionOperation], None]
    note: str


def run_operation(
    targets: List[Target],
    kind: Kind,
    *,
    session_key: str,
    reason: str,
    connection_callback: Optional[Callback],
    tick_seconds: Optional[float] = None,
    with_urls_in_result: bool,
) -> str:
    """Block the tool thread until the operation settles; return the tool's JSON string."""
    operation = ConnectionOperation(targets, session_key=session_key)
    try:
        live.open(operation)
    except live.OperationAlreadyOpen as exc:
        from tools.registry import tool_error

        return tool_error(
            f"a connection operation is already open in this session ({exc.existing.op_id}); it settles "
            "when the user finishes with the card, on Continue, or at its deadline. Do not start another."
        )
    try:
        kind.prepare(operation)
        if connection_callback is not None and not operation.settled:
            connection_callback(operation.request_payload(reason))
        _watch(operation, kind, tick_seconds)
    finally:
        live.close(operation)
    payload = operation.result(with_urls=with_urls_in_result)
    payload["status"] = "settled"
    payload["note"] = kind.note
    return json.dumps(payload, ensure_ascii=False)


def _watch(operation: ConnectionOperation, kind: Kind, tick_seconds: Optional[float]) -> None:
    from tools.interrupt import is_interrupted

    tick = WATCH_INTERVAL_SECONDS if tick_seconds is None else tick_seconds
    if is_interrupted():
        operation.settle(SettleReason.interrupt)
        return
    kind.observe(operation)
    operation.settle_if_all_resolved()
    while not operation.settled:
        remaining = operation.remaining_seconds()
        if remaining <= 0:
            operation.settle(SettleReason.deadline)
            break
        operation.wake.wait(min(tick, remaining))
        operation.wake.clear()
        if is_interrupted():
            operation.settle(SettleReason.interrupt)
            break
        kind.observe(operation)
        operation.settle_if_all_resolved()
        if time.time() >= operation.deadline_at:
            operation.settle(SettleReason.deadline)
