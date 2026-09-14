"""MCP targets of manage_connections (the fold that retired setup_mcp).

Contracts:
- the backend owns the work: authorize mints its own URL, install writes credentials and installs,
  enable flips the flag; the card only says approved / skipped / continue
- a card claim of any other state moves nothing
- off the desktop there is no card: the work runs at once and the result carries the link
- catalog validation: install is catalog-only, enable/authorize need a configured server
- the replay shim keeps an old ``setup_mcp`` call dispatching
- deadline ownership: fixed operation deadline + sequential-deadline exemption
"""

import json
import threading
from types import SimpleNamespace
from unittest.mock import patch

import pytest

import tools.connectors.tool  # registers the tool
from tools.connectors.contract import Actor, SettleReason, TargetState
from tools.connectors import live
from tools.connectors import operation as op
from tools.connectors.mcp import apply_answer
from tools.connectors.tool import MANAGE_CONNECTIONS_SCHEMA, manage_connections
from tools.registry import registry

CATALOG = ["figma", "linear", "notion"]
CONFIGURED = {"paper": {"command": "paper-mcp"}, "linear": {"url": "https://mcp.linear.app/mcp"}}


class FakeAttempt:
    """An OAuth flow in flight, as the watcher reads it."""

    def __init__(self, auth_url):
        self.auth_url = auth_url
        self.status = "pending"
        self.error = ""
        self.tools = []

    def poll(self):
        return {"status": self.status, "error": self.error, "tools": list(self.tools)}

    def approve(self, tools):
        self.tools, self.status = list(tools), "approved"

    def fail(self, error):
        self.error, self.status = error, "error"


class FakeBackend:
    """The one fake: the catalog, the installer and the OAuth flow runner behind ``mcp.py``."""

    def __init__(self, *, missing_env=(), tools=("read", "write"), install_error="", oauth_error=""):
        self.calls = []
        self.attempts = {}
        self.missing_env = list(missing_env)
        self.tools = list(tools)
        self.install_error = install_error
        self.oauth_error = oauth_error

    def required_env(self, name):
        self.calls.append(("required_env", name))
        return [{"name": key, "prompt": f"{key}?", "required": True} for key in self.missing_env]

    def start_oauth(self, name):
        self.calls.append(("start_oauth", name))
        if self.oauth_error:
            raise RuntimeError(self.oauth_error)
        attempt = FakeAttempt(f"https://auth.example/{name}/{len(self.attempts) + 1}")
        self.attempts[name] = attempt
        return attempt

    def install(self, name, env):
        self.calls.append(("install", name, dict(env)))
        if self.install_error:
            raise RuntimeError(self.install_error)
        return list(self.tools)

    def enable(self, name):
        self.calls.append(("enable", name))


@pytest.fixture
def backend():
    return FakeBackend()


@pytest.fixture(autouse=True)
def _clean_live():
    live.reset_for_tests()
    yield
    live.reset_for_tests()


@pytest.fixture(autouse=True)
def _catalog(backend):
    # The default backend is patched too: a call that cannot be handed one (registry dispatch, the
    # inline executor) must never reach the real catalog or installer from a test.
    with patch("tools.connectors.mcp._catalog_names", return_value=CATALOG), \
         patch("tools.connectors.mcp._configured_names", return_value=sorted(CONFIGURED)), \
         patch("tools.connectors.mcp._default_backend", return_value=backend), \
         patch("tools.connectors.mcp.session_platform", return_value="desktop"):
        yield


@pytest.fixture
def changes(monkeypatch):
    """Every transition the operation emits, through the hook the gateway installs."""
    recorded = []
    monkeypatch.setattr(op.ConnectionOperation, "on_change",
                        staticmethod(lambda operation, change: recorded.append(change)))
    return recorded


class FakeClient:
    def __init__(self):
        self.calls = []

    def list_connectors(self, **_):
        self.calls.append("list")
        return [{"connector": "gmail", "enabled": True, "connected": False}]

    def connections(self, connectors, *, reinitiate=False):
        self.calls.append(("connections", tuple(connectors), reinitiate))
        return {"results": [{"connector": c, "status": "initiated", "connect_url": f"https://x/{c}"} for c in connectors]}


def _mcp_target(name):
    return {"name": name, "mcp": True}


def _linear(**kw):
    return {"name": "linear", "mcp": True, **kw}


# ---------------------------------------------------------------------------
# the card round-trip: the backend does the work, the card answers approved / skipped
# ---------------------------------------------------------------------------


def _answering(answer, *, session_id="s1", delay=0.01):
    """A card that emits (callback returns None) and answers the live operation a moment later,
    the way ``connection.respond`` does from the renderer."""
    seen = []

    def callback(payload):
        seen.append(payload)

        def respond():
            operation = live.get(session_id, payload["op_id"])
            if operation is not None:
                apply_answer(operation, answer)

        if answer is not None:
            threading.Timer(delay, respond).start()
        return None

    callback.seen = seen
    return callback


def _mcp(args, callback, **kw):
    with patch("tools.connectors.run.WATCH_INTERVAL_SECONDS", 0.01):
        return json.loads(manage_connections(args, connection_callback=callback, session_id="s1", **kw))


def test_authorize_mints_its_own_url_into_the_card_and_connects_when_the_flow_approves(backend):
    def callback(payload):
        callback.seen.append(payload)
        # The browser hits the backend's callback route; the flow reports approval out of band.
        backend.attempts["paper"].approve(["search", "comment"])
        return None

    callback.seen = []
    out = _mcp({"action": "authorize", "connectors": [_mcp_target("paper")]}, callback, mcp_backend=backend)

    (offered,) = callback.seen[0]["targets"]
    assert offered["state"] == TargetState.initiated.value
    assert offered["connect_url"] == "https://auth.example/paper/1"
    (settled,) = out["targets"]
    assert settled["state"] == TargetState.connected.value
    assert settled["tools"] == ["search", "comment"]
    assert out["settled_by"] == SettleReason.all_resolved.value


def test_a_flow_that_fails_moves_the_row_to_failed_with_the_error_text(backend, changes):
    def callback(payload):
        backend.attempts["paper"].fail("the provider rejected the client registration")
        return None

    with patch("tools.connectors.operation.OPERATION_DEADLINE_SECONDS", 0.4):
        _mcp({"action": "authorize", "connectors": [_mcp_target("paper")]}, callback, mcp_backend=backend)

    failure = [c for c in changes if c and c["to"] == TargetState.failed.value][-1]
    assert failure["detail"] == "the provider rejected the client registration"
    assert failure["actor"] == Actor.backend_watcher.value


def test_a_flow_that_never_starts_fails_the_row_before_the_card_is_drawn():
    backend = FakeBackend(oauth_error="no OAuth callback route in this process")
    callback = _answering(json.dumps({"settled_by": "continue"}))
    out = _mcp({"action": "authorize", "connectors": [_mcp_target("paper")]}, callback, mcp_backend=backend)

    (offered,) = callback.seen[0]["targets"]
    assert offered["state"] == TargetState.failed.value
    assert offered["detail"] == "no OAuth callback route in this process"
    assert "connect_url" not in offered
    assert out["settled_by"] == SettleReason.continue_.value


def test_install_waits_for_the_credentials_it_declares_and_installs_with_them():
    backend = FakeBackend(missing_env=["FIGMA_TOKEN"], tools=["get_file"])
    answer = json.dumps({"targets": [{"name": "figma", "status": "approved", "env": {"FIGMA_TOKEN": "tok-1"}}]})
    callback = _answering(answer)
    out = _mcp({"action": "install", "connectors": [_mcp_target("figma")]}, callback, mcp_backend=backend)

    (offered,) = callback.seen[0]["targets"]
    assert offered["state"] == TargetState.pending.value
    assert offered["required_env"] == [{"name": "FIGMA_TOKEN", "prompt": "FIGMA_TOKEN?", "required": True}]
    assert ("install", "figma", {"FIGMA_TOKEN": "tok-1"}) in backend.calls
    (settled,) = out["targets"]
    assert settled["state"] == TargetState.connected.value
    assert settled["tools"] == ["get_file"]


def test_enable_connects_on_the_card_s_approval(backend):
    answer = json.dumps({"targets": [{"name": "paper", "status": "approved"}]})
    out = _mcp({"action": "enable", "connectors": [_mcp_target("paper")]}, _answering(answer), mcp_backend=backend)

    assert ("enable", "paper") in backend.calls
    (settled,) = out["targets"]
    assert settled["state"] == TargetState.connected.value


def test_a_card_claim_other_than_approved_or_skipped_moves_nothing(backend):
    answer = json.dumps({"targets": [{"name": "paper", "status": "connected", "tools": ["x"]}],
                         "settled_by": "continue"})
    out = _mcp({"action": "enable", "connectors": [_mcp_target("paper")]}, _answering(answer), mcp_backend=backend)

    assert backend.calls == []
    (settled,) = out["targets"]
    assert settled["state"] == TargetState.not_connected.value
    assert out["settled_by"] == SettleReason.continue_.value


def test_a_skip_resolves_the_row_and_the_operation(backend):
    answer = json.dumps({"targets": [{"name": "paper", "status": "skipped"}]})
    out = _mcp({"action": "enable", "connectors": [_mcp_target("paper")]}, _answering(answer), mcp_backend=backend)

    assert out["targets"][0]["state"] == TargetState.skipped.value
    assert out["settled_by"] == SettleReason.all_resolved.value


def test_no_answer_settles_by_deadline_and_marks_targets_not_connected(backend):
    with patch("tools.connectors.operation.OPERATION_DEADLINE_SECONDS", 0.05):
        out = _mcp({"action": "install", "connectors": [_linear()]}, _answering(None), mcp_backend=backend)
    assert out["settled_by"] == SettleReason.deadline.value
    assert out["targets"][0]["state"] == TargetState.not_connected.value
    assert "error" not in out


def test_mcp_secrets_never_reach_the_model():
    backend = FakeBackend(missing_env=["LINEAR_API_KEY"])
    answer = json.dumps({"targets": [{"name": "linear", "status": "approved",
                                      "env": {"LINEAR_API_KEY": "sk-secret"}}]})
    out = _mcp({"action": "install", "connectors": [_linear()]}, _answering(answer), mcp_backend=backend)
    assert "sk-secret" not in json.dumps(out)


# ---------------------------------------------------------------------------
# off the desktop: no card, so the work runs at once
# ---------------------------------------------------------------------------


def _off_desktop(args, **kw):
    with patch("tools.connectors.mcp.session_platform", return_value="tui"):
        return json.loads(manage_connections(args, session_id="s1", **kw))


def test_off_desktop_authorize_returns_the_link_at_once_and_opens_no_operation(backend):
    out = _off_desktop({"action": "authorize", "connectors": [_mcp_target("paper")]}, mcp_backend=backend)

    (target,) = out["targets"]
    assert target["state"] == TargetState.initiated.value
    assert target["connect_url"] == "https://auth.example/paper/1"
    assert out["status"] == "initiated"
    assert live.current("s1") is None


def test_off_desktop_install_without_its_credentials_fails_and_names_them():
    backend = FakeBackend(missing_env=["FIGMA_TOKEN"])
    out = _off_desktop({"action": "install", "connectors": [_mcp_target("figma")]}, mcp_backend=backend)

    (target,) = out["targets"]
    assert target["state"] == TargetState.failed.value
    assert "FIGMA_TOKEN" in target["detail"]
    assert not [c for c in backend.calls if c[0] == "install"]


def test_registry_dispatch_never_blocks_and_never_reaches_a_card(backend):
    # registry.dispatch forwards no callback; the call must return, not block.
    with patch("tools.connectors.mcp.session_platform", return_value="tui"):
        out = json.loads(registry.dispatch("manage_connections", {"action": "enable", "connectors": [_linear()]}))
    assert out["targets"][0]["state"] == TargetState.connected.value


def test_a_managed_action_never_accepts_mcp_targets_and_vice_versa():
    client = FakeClient()
    out = json.loads(manage_connections(
        {"action": "connect", "connectors": ["gmail", _linear()]}, client_factory=lambda: client))
    assert "managed-connector action" in out["error"]
    assert client.calls == []  # rejected before any gateway call

    out = json.loads(manage_connections({"action": "install", "connectors": ["gmail", _linear()]}))
    assert "must carry" in out["error"]


def test_a_managed_call_off_desktop_returns_a_link_per_target():
    client = FakeClient()
    out = json.loads(manage_connections(
        {"action": "connect", "connectors": ["gmail"]}, client_factory=lambda: client))
    assert client.calls == [("connections", ("gmail",), False)]
    assert out["targets"][0]["connect_url"] == "https://x/gmail"
    assert out["status"] == "initiated"


def test_unknown_target_fields_are_rejected():
    out = json.loads(manage_connections({"action": "install", "connectors": [_linear(url="https://evil")]}))
    assert "unknown target field" in out["error"] and "url" in out["error"]


# ---------------------------------------------------------------------------
# catalog validation
# ---------------------------------------------------------------------------


def test_install_is_catalog_only_and_lists_the_catalog_on_a_miss():
    out = json.loads(manage_connections({"action": "install", "connectors": [{"name": "github", "mcp": True}]}))
    assert "github" in out["error"]
    assert "figma, linear, notion" in out["error"]


def test_enable_and_authorize_need_a_configured_server():
    out = json.loads(manage_connections({"action": "enable", "connectors": [{"name": "figma", "mcp": True}]}))
    assert "figma" in out["error"] and "paper" in out["error"]


# ---------------------------------------------------------------------------
# the inline executor + replay shim
# ---------------------------------------------------------------------------


def _agent(callback):
    return SimpleNamespace(session_id="s1", connection_callback=callback)


def test_inline_executor_hands_the_agent_callback_to_the_tool(backend):
    from agent.inline_tool_executors import INLINE_TOOL_EXECUTORS, InlineToolContext

    callback = _answering(json.dumps({"targets": [{"name": "paper", "status": "approved"}]}))
    with patch("tools.connectors.run.WATCH_INTERVAL_SECONDS", 0.01):
        out = json.loads(INLINE_TOOL_EXECUTORS["manage_connections"](
            _agent(callback), {"action": "enable", "connectors": [_mcp_target("paper")]}, InlineToolContext("task")))
    assert len(callback.seen) == 1
    assert out["targets"][0]["state"] == TargetState.connected.value


def test_setup_mcp_replay_shim_translates_to_an_mcp_target(backend):
    from agent.inline_tool_executors import INLINE_TOOL_EXECUTORS, InlineToolContext

    callback = _answering(json.dumps({"targets": [{"name": "linear", "status": "skipped"}]}))
    with patch("tools.connectors.run.WATCH_INTERVAL_SECONDS", 0.01):
        out = json.loads(INLINE_TOOL_EXECUTORS["setup_mcp"](
            _agent(callback), {"server": "linear", "action": "install", "reason": "old convo"}, InlineToolContext("task", tool_call_id="call-9")))
    (target,) = callback.seen[0]["targets"]
    assert (target["name"], target["kind"], target["action"], target["state"]) == ("linear", "mcp", "install", "pending")
    assert callback.seen[0]["tool_call_id"] == "call-9"
    assert out["targets"][0]["state"] == TargetState.skipped.value


def test_setup_mcp_is_gone_from_every_advertised_toolset():
    from toolsets import TOOLSETS, resolve_toolset

    assert all("setup_mcp" not in resolve_toolset(name) for name in TOOLSETS)
    assert "manage_connections" in resolve_toolset("connections")
    assert "hand-edit" in MANAGE_CONNECTIONS_SCHEMA["description"]
    assert "mcp_servers" in MANAGE_CONNECTIONS_SCHEMA["description"]


# ---------------------------------------------------------------------------
# deadline ownership
# ---------------------------------------------------------------------------


def test_the_bounded_wait_owns_the_deadline_not_the_sequential_guard():
    from agent import tool_executor as te

    assert "manage_connections" in te._SEQUENTIAL_DEADLINE_EXEMPT_TOOLS
