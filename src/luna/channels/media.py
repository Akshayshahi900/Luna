"""
Audio, photo and text helpers for chat apps (Telegram today).

BEGINNER MAP
------------
Chat apps send and expect formats the rest of Luna doesn't use:

  voice note in   OGG/Opus (any length)  → decode_audio → 16 kHz float32 samples
                                            for WhisperSTT (luna/voice/stt.py)
  voice note out  Piper's WAV            → wav_to_ogg_opus → OGG/Opus, which
                                            Telegram shows as a voice message
  photo in        several sizes          → pick_photo picks one the model can use
  text out        one long reply         → split_text cuts it to the 4096-char limit

Audio goes through PyAV (``av``), which faster-whisper already installs; no
ffmpeg binary is needed. (faster_whisper.decode_audio itself doesn't work
with PyAV 19, so decoding is done here.)
"""

from __future__ import annotations

import io
import itertools
import re
from typing import Any

import numpy as np

from luna.voice.stt import SAMPLE_RATE

# Voice notes longer than this are refused (Whisper on CPU would take minutes).
MAX_VOICE_SECONDS = 300
# Telegram's limit for one text message.
TEXT_LIMIT = 4096
# Big enough to read text in a screenshot, small enough to keep the thread lean.
PHOTO_MAX_SIDE = 1280
# Telegram voice messages are Opus at 48 kHz.
OPUS_RATE = 48_000


def decode_audio(data: bytes, max_seconds: int = MAX_VOICE_SECONDS) -> np.ndarray:
    """Any audio file PyAV can read (OGG/Opus, MP3, M4A, WAV…) → 16 kHz mono
    float32 samples in -1..1. Raises ValueError for bad or too-long audio."""
    import av

    chunks: list[np.ndarray] = []
    count = 0
    limit = SAMPLE_RATE * max_seconds
    try:
        with av.open(io.BytesIO(data), mode="r") as container:
            if not container.streams.audio:
                raise ValueError("no audio in that file")
            resampler = av.AudioResampler(format="s16", layout="mono", rate=SAMPLE_RATE)
            # Lazily, so a huge file stops at the limit; None flushes the resampler.
            for frame in itertools.chain(container.decode(audio=0), [None]):
                for out in resampler.resample(frame):
                    chunk = out.to_ndarray().reshape(-1)
                    count += len(chunk)
                    if count > limit:
                        raise ValueError(f"voice note longer than {max_seconds // 60} minutes")
                    chunks.append(chunk)
    except av.FFmpegError as exc:
        raise ValueError(f"couldn't read that audio ({exc})") from None
    if not chunks:
        return np.zeros(0, dtype=np.float32)
    return np.concatenate(chunks).astype(np.float32) / 32768.0


def wav_to_ogg_opus(wav: bytes) -> bytes:
    """A WAV file (Piper's output) → OGG/Opus bytes for a voice message."""
    import av

    out_buf = io.BytesIO()
    with av.open(io.BytesIO(wav), mode="r", format="wav") as source:
        with av.open(out_buf, mode="w", format="ogg") as target:
            stream = target.add_stream("libopus", rate=OPUS_RATE)
            stream.layout = "mono"
            resampler = av.AudioResampler(format="s16", layout="mono", rate=OPUS_RATE)
            for frame in itertools.chain(source.decode(audio=0), [None]):
                for out in resampler.resample(frame):
                    for packet in stream.encode(out):
                        target.mux(packet)
            for packet in stream.encode(None):
                target.mux(packet)
    return out_buf.getvalue()


def pick_photo(sizes: list[dict[str, Any]], max_side: int = PHOTO_MAX_SIDE) -> dict[str, Any] | None:
    """The largest photo size that fits ``max_side`` (else the smallest one).

    Telegram sends every photo in several sizes, smallest first.
    """
    if not sizes:
        return None
    fits = [s for s in sizes if max(s.get("width", 0), s.get("height", 0)) <= max_side]
    if fits:
        return max(fits, key=lambda s: s.get("width", 0) * s.get("height", 0))
    return min(sizes, key=lambda s: s.get("width", 0) * s.get("height", 0))


def split_text(text: str, limit: int = TEXT_LIMIT) -> list[str]:
    """Cut ``text`` into messages of at most ``limit`` characters, preferring
    paragraph, then line, then word breaks."""
    text = text.strip()
    parts: list[str] = []
    while len(text) > limit:
        window = text[:limit]
        cut = max(window.rfind("\n\n"), window.rfind("\n"), window.rfind(" "))
        if cut < limit // 2:
            cut = limit  # no good break: hard cut
        parts.append(text[:cut].rstrip())
        text = text[cut:].lstrip()
    if text:
        parts.append(text)
    return parts


def safe_filename(name: str, fallback: str = "file") -> str:
    """A file name that can't leave its folder or upset a shell."""
    name = name.replace("\\", "/").rsplit("/", 1)[-1]
    name = re.sub(r"[^A-Za-z0-9._-]+", "_", name).strip("._")
    return name[:100] or fallback


__all__ = [
    "MAX_VOICE_SECONDS",
    "PHOTO_MAX_SIDE",
    "TEXT_LIMIT",
    "decode_audio",
    "pick_photo",
    "safe_filename",
    "split_text",
    "wav_to_ogg_opus",
]
