"""
Text-to-speech with Piper — a small neural voice that runs on your CPU.

BEGINNER MAP
------------
The browser's built-in speech gives the page no audio, so the web UI's
core could only guess when Luna is speaking. With Piper, the server makes
a real WAV per sentence; the browser plays it through an analyser, and the
core moves with the actual sound (see web/src/lib/speech.ts `Speaker`).

  - Local and offline, fast on CPU, Windows / macOS / Linux wheels.
  - The voice model (~60 MB) downloads once into data/voices/ the first
    time it's needed (LUNA_TTS_VOICE picks which; list at
    https://huggingface.co/rhasspy/piper-voices).
  - piper-tts is GPL-3.0: fine to use, mind it if you redistribute Luna.

LUNA_TTS_ENGINE=browser turns this off and the UI uses browser speech.
"""

from __future__ import annotations

import asyncio
import io
import logging
import threading
import wave
from pathlib import Path
from typing import Any

_LOGGER = logging.getLogger(__name__)

# One sentence at a time is the norm; this only stops abuse of the endpoint.
MAX_TEXT_CHARS = 1000


class PiperTTS:
    """Lazily downloads + loads one Piper voice; synthesizes WAV bytes."""

    def __init__(self, voice: str, voices_dir: Path, length_scale: float = 1.0) -> None:
        self.voice_name = voice
        self.voices_dir = voices_dir
        self.length_scale = length_scale
        self._voice: Any = None
        # espeak-ng (phonemes) inside Piper is not thread-safe: one at a time.
        self._lock = threading.Lock()

    @property
    def model_path(self) -> Path:
        """Where the Piper voice model file is (downloaded on first use)."""
        return self.voices_dir / f"{self.voice_name}.onnx"

    def _ensure_loaded(self) -> Any:
        if self._voice is not None:
            return self._voice
        from piper import PiperVoice
        from piper.download_voices import download_voice

        self.voices_dir.mkdir(parents=True, exist_ok=True)
        if not self.model_path.exists() or not Path(f"{self.model_path}.json").exists():
            _LOGGER.warning("Downloading Piper voice %s (one time)…", self.voice_name)
            download_voice(self.voice_name, self.voices_dir)
        self._voice = PiperVoice.load(self.model_path)
        return self._voice

    def synthesize(self, text: str) -> bytes:
        """WAV (16-bit mono) for ``text``. Blocking and CPU-bound."""
        from piper import SynthesisConfig

        text = " ".join(text.split())[:MAX_TEXT_CHARS]
        if not text:
            raise ValueError("Nothing to say.")
        with self._lock:
            voice = self._ensure_loaded()
            buffer = io.BytesIO()
            with wave.open(buffer, "wb") as wav:
                voice.synthesize_wav(text, wav, syn_config=SynthesisConfig(length_scale=self.length_scale))
        return buffer.getvalue()

    async def asynthesize(self, text: str) -> bytes:
        """synthesize() off the event loop, so streaming replies keep flowing."""
        return await asyncio.to_thread(self.synthesize, text)

    async def warm_up(self) -> None:
        """Download/load the voice and run it once, so the first reply isn't slow."""
        try:
            await self.asynthesize("Ready.")
            _LOGGER.info("Piper voice %s ready", self.voice_name)
        except Exception as exc:  # noqa: BLE001 — the UI falls back to browser speech
            _LOGGER.warning("Piper voice unavailable (%s); the UI will use browser speech.", exc)


def create_tts(settings: Any) -> PiperTTS | None:
    """The configured engine, or None for browser speech."""
    if settings.tts_engine != "piper":
        return None
    try:
        import piper  # noqa: F401
    except ImportError:
        _LOGGER.warning("piper-tts is not installed; using browser speech.")
        return None
    return PiperTTS(settings.tts_voice, settings.tts_voices_dir, settings.tts_length_scale)


__all__ = ["MAX_TEXT_CHARS", "PiperTTS", "create_tts"]
