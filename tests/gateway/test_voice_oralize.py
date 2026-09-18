"""Oral rewrite truncation policy for Discord VC playback.

``max_tokens`` on the ``discord_vc_oral`` auxiliary call is a runaway/cost guard, NOT a length
policy: the shaping lives in the system prompt ("au plus 5 phrases courtes"). These tests pin
what happens when the cap is what stopped the model — the spoken script must never end
mid-word, while a complete rewrite must come back untouched.
"""

from types import SimpleNamespace

LONG_SOURCE = "## Recap\n" + ("- item path /home/mickael/foo\n" * 40)


def _stub_llm(monkeypatch, content: str, finish_reason: str) -> None:
    def fake_llm(**kwargs):
        assert kwargs["task"] == "discord_vc_oral"
        return SimpleNamespace(choices=[SimpleNamespace(
            message=SimpleNamespace(content=content), finish_reason=finish_reason)])

    monkeypatch.setattr("agent.auxiliary_client.call_llm", fake_llm)


def test_capped_rewrite_drops_the_dangling_tail(monkeypatch):
    """A cap-truncated rewrite is spoken up to its last finished sentence, never mid-word."""
    from gateway import run_voice

    _stub_llm(
        monkeypatch,
        "Deux paquets critiques sur roxabi-production. Sept advisories sur fast-uri. "
        "Le reste des dépend",
        "length")
    spoken = run_voice.oralize_for_discord_vc(LONG_SOURCE)
    assert spoken.endswith("fast-uri.")
    assert "dépend" not in spoken


def test_complete_rewrite_is_returned_untrimmed(monkeypatch):
    """finish_reason=stop is verbatim: cap handling must not become a global truncation policy."""
    from gateway import run_voice

    full = "Deux paquets critiques. Sept advisories. Rien d'autre à signaler."
    _stub_llm(monkeypatch, full, "stop")
    assert run_voice.oralize_for_discord_vc(LONG_SOURCE) == full


def test_capped_rewrite_without_a_finished_sentence_keeps_the_text(monkeypatch):
    """Floor: with no finished sentence, keep the clipped text — a three-word stub read aloud
    is worse than one clipped sentence."""
    from gateway import run_voice

    capped = "Le digest des alertes de sécurité sur les dépôts Roxabi indique que plusieurs paquets"
    _stub_llm(monkeypatch, capped, "length")
    assert run_voice.oralize_for_discord_vc(LONG_SOURCE) == capped


def test_missing_finish_reason_is_not_treated_as_capped(monkeypatch):
    """Providers that omit finish_reason must keep the old behaviour (no silent trimming)."""
    from gateway import run_voice

    text = "Cron ok. Deux tickets ouverts. Et une remarque finale sans ponctuation terminale"
    def fake_llm(**kwargs):
        return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=text))])

    monkeypatch.setattr("agent.auxiliary_client.call_llm", fake_llm)
    assert run_voice.oralize_for_discord_vc(LONG_SOURCE) == text
