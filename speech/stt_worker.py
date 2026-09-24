#!/usr/bin/env python3
"""Speech to text, local only (spec 4.5, 4.6).

One long-lived process, because the first transcription on CUDA costs about
seven seconds of kernel warmup and every one after it costs a fifth of a
second. The bridge pays that once at startup, never in the middle of a
conversation.

{"wav": path} -> {"text": str, "seconds": float}
{"wav": path, "words": true} -> the same, with "words": [{"word", "start", "end"}]
    the time of each word in seconds (spec 11.6.3), from the model's alignment
"""
import sys
import time

import worker

import numpy as np  # noqa: E402
from faster_whisper import WhisperModel  # noqa: E402


def main() -> None:
    model_name = sys.argv[1]
    root = sys.argv[2]
    model = WhisperModel(model_name, device="cuda", compute_type="float16", download_root=root)

    # the warmup transcription, on a second of silence, so the first real one is fast
    started = time.time()
    list(model.transcribe(np.zeros(16_000, dtype=np.float32), beam_size=1, vad_filter=True)[0])
    worker.reply(ready=True, model=model_name, warmup_seconds=round(time.time() - started, 2))

    def handle(request: dict) -> dict:
        # vad_filter drops the parts with no voice in them. Without it whisper
        # writes something for silence anyway -- "you", "Thank you." -- and the
        # bridge sends that phantom to the agent and pays for a turn.
        timed = bool(request.get("words"))
        segments, _ = model.transcribe(request["wav"], beam_size=1, vad_filter=True, word_timestamps=timed)
        segments = list(segments)
        result = {"text": "".join(segment.text for segment in segments).strip()}
        if timed:
            result["words"] = [
                {"word": word.word.strip(), "start": round(word.start, 3), "end": round(word.end, 3)}
                for segment in segments for word in (segment.words or [])
            ]
        return result

    worker.serve(handle)


main()
