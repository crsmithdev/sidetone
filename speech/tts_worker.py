#!/usr/bin/env python3
"""Text to speech, local only (spec 4.5, 4.9).

One long-lived process: loading the voice costs about 1.3 seconds and
synthesis costs about a tenth of a second a sentence, so the bridge loads
once and then speaks at twenty times real time. One voice per model file, so
the voice in a request is ignored.

{"text": str, "wav": path} -> {"wav": path, "seconds": float}
"""
import sys
import wave

import worker

from piper import PiperVoice  # noqa: E402


def main() -> None:
    voice = PiperVoice.load(sys.argv[1])
    worker.reply(ready=True, sample_rate=voice.config.sample_rate)

    def handle(request: dict) -> dict:
        with wave.open(request["wav"], "wb") as out:
            voice.synthesize_wav(request["text"], out)
        return {"wav": request["wav"]}

    worker.serve(handle)


main()
