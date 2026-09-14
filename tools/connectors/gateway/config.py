"""Configuration and availability gate for connector tools.

Availability fails closed; the gateway remains authoritative for entitlement and route availability.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any, Callable, Optional

logger = logging.getLogger(__name__)

__all__ = [
    "MAX_CALLS_PER_DISPATCH",
    "ConnectorConfig",
    "connectors_available",
    "load_config",
]

# Context cap, not a wire limit; the gateway batch cap is deliberately unreachable.
MAX_CALLS_PER_DISPATCH = 10

_FALSE_STRINGS = frozenset({"false", "0", "no", "off", ""})


@dataclass(frozen=True)
class ConnectorConfig:

    enabled: bool = True

    @classmethod
    def from_raw(cls, raw: Any) -> "ConnectorConfig":
        """Malformed configuration falls back to the enabled default."""
        if isinstance(raw, bool):
            return cls(enabled=raw)
        if isinstance(raw, dict):
            return cls(enabled=_coerce_bool(raw.get("enabled"), True))
        return cls()


def _coerce_bool(value: Any, fallback: bool) -> bool:
    if isinstance(value, bool):
        return value
    if value is None:
        return fallback
    if isinstance(value, (int, float)):
        return bool(value)
    if isinstance(value, str):
        return value.strip().lower() not in _FALSE_STRINGS
    return fallback


def load_config() -> ConnectorConfig:
    try:
        from hermes_cli.config import load_config_readonly as _load

        cfg = _load() or {}
        tools_cfg = cfg.get("tools") if isinstance(cfg.get("tools"), dict) else {}
        if not isinstance(tools_cfg, dict):
            tools_cfg = {}
        return ConnectorConfig.from_raw(tools_cfg.get("connectors"))
    except Exception as e:
        logger.debug("Failed to load connector config: %s", e)
        return ConnectorConfig.from_raw(None)


def connectors_available(
    config_loader: Optional[Callable[[], ConnectorConfig]] = None,
    entitlement_check: Optional[Callable[[], bool]] = None,
) -> bool:
    """Fail closed so availability failures do not become model-visible errors."""
    try:
        resolved_loader = config_loader or load_config
        if not resolved_loader().enabled:
            return False
        if entitlement_check is None:
            from hermes_cli.anon_auth import is_guest_state
            from tools.managed_tool_gateway import _read_nous_provider_state
            from tools.tool_backend_helpers import managed_nous_tools_enabled

            # Availability must not mint or refresh an identity.
            if is_guest_state(_read_nous_provider_state()):
                return True

            entitlement_check = managed_nous_tools_enabled
        return bool(entitlement_check())
    except Exception as e:
        logger.debug("Connector availability check failed: %s", e)
        return False
