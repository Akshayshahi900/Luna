"""
Speech-to-text with Whisper (faster-whisper), running locally on the CPU.

BEGINNER MAP
------------
The browser records one utterance at a time (it detects when you start and
stop talking), sends it to POST /api/stt as a 16 kHz WAV, and gets text
back. Nothing leaves your machine, and it works in any browser.

  - Model: LUNA_STT_MODEL (default base.en, ~140 MB, downloaded once into
    data/models/whisper). small.en is more accurate and ~2× slower.
  - Measured on a laptop CPU (i5-12450H, 4 threads, int8): base.en
    transcribes ~4.5× faster than real time, so a 3 s command takes ~0.6 s.
  - The prompt "Hey Luna." makes Whisper spell the wake word as "Luna"
    instead of "Lunar" (wake phrase found 6/12 → 12/12 in our tests, with
    the browser's start-of-utterance check). Wake-word logic itself lives
    in the browser (web/src/lib/intent.ts).

LUNA_STT_ENGINE=browser turns this off; the UI then uses Chrome/Edge
speech recognition and has no wake word.
"""

from __future__ import annotations

import asyncio
import io
import logging
import threading
import wave
from pathlib import Path
from typing import Any

import numpy as np

_LOGGER = logging.getLogger(__name__)

SAMPLE_RATE = 16_000
# Longer than any spoken command; stops huge uploads.
MAX_SECONDS = 30
WAKE_PROMPT = "Hey Luna."


def wav_to_samples(data: bytes) -> np.ndarray:
    """16 kHz mono 16-bit WAV → float32 samples in -1..1. Raises ValueError."""
    try:
        with wave.open(io.BytesIO(data), "rb") as wav:
            if wav.getnchannels() != 1 or wav.getsampwidth() != 2 or wav.getframerate() != SAMPLE_RATE:
                raise ValueError("audio must be 16 kHz mono 16-bit WAV")
            if wav.getnframes() > SAMPLE_RATE * MAX_SECONDS:
                raise ValueError(f"audio longer than {MAX_SECONDS} s")
            frames = wav.readframes(wav.getnframes())
    except (wave.Error, EOFError) as exc:
        raise ValueError(f"not a WAV file ({exc})") from None
    return np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0


class WhisperSTT:
    """Lazily downloads + loads one Whisper model; transcribes utterances."""

    def __init__(self, model: str, models_dir: Path, threads: int = 4) -> None:
        self.model_name = model
        self.models_dir = models_dir
        self.threads = threads
        self._model: Any = None
        self._lock = threading.Lock()  # one transcription at a time keeps CPU use predictable

    def _ensure_loaded(self) -> Any:
        if self._model is None:
            from faster_whisper import WhisperModel

            _LOGGER.warning("Loading Whisper %s (first time downloads it)…", self.model_name)
            self._model = WhisperModel(
                self.model_name,
                device="cpu",
                compute_type="int8",
                cpu_threads=self.threads,
                download_root=str(self.models_dir),
            )
        return self._model

    def transcribe(self, samples: np.ndarray, prompt: str | None = WAKE_PROMPT) -> str:
        """Text for one utterance. Blocking and CPU-bound."""
        with self._lock:
            model = self._ensure_loaded()
            segments, _ = model.transcribe(
                samples,
                language="en" if self.model_name.endswith(".en") else None,
                beam_size=1,  # greedy: much faster, same result on short commands
                vad_filter=True,  # Silero VAD drops noise, so Whisper doesn't invent words
                condition_on_previous_text=False,
                initial_prompt=prompt,
            )
            return " ".join(s.text.strip() for s in segments).strip()

    async def atranscribe(self, samples: np.ndarray, prompt: str | None = WAKE_PROMPT) -> str:
        """``transcribe`` in a worker thread, so the event loop stays free."""
        return await asyncio.to_thread(self.transcribe, samples, prompt)

    async def warm_up(self) -> None:
        """Download/load the model in the background so the first command is quick."""
        try:
            await self.atranscribe(np.zeros(SAMPLE_RATE // 2, dtype=np.float32))
            _LOGGER.info("Whisper %s ready", self.model_name)
        except Exception as exc:  # noqa: BLE001 — the UI falls back to browser recognition
            _LOGGER.warning("Whisper unavailable (%s).", exc)


def create_stt(settings: Any) -> WhisperSTT | None:
    """The configured engine, or None for browser speech recognition."""
    if settings.stt_engine != "whisper":
        return None
    try:
        import faster_whisper  # noqa: F401
    except ImportError:
        _LOGGER.warning("faster-whisper is not installed; using browser speech recognition.")
        return None
    return WhisperSTT(settings.stt_model, settings.stt_models_dir, settings.stt_threads)


__all__ = ["MAX_SECONDS", "SAMPLE_RATE", "WAKE_PROMPT", "WhisperSTT", "create_stt", "wav_to_samples"]
