#!/usr/bin/env python3
"""Text to speech on the GPU (spec 4.5, 4.9).

Piper runs on the CPU and sounds like it. Kokoro is 82M parameters behind one
ONNX graph, and the card was idle anyway: on this machine it makes the first
sentence of an answer in about a tenth of a second, the same as piper, and
holds about 800 MB of video memory to do it.

It runs in its own virtual environment on purpose. onnxruntime wants the CUDA
13 wheels and ctranslate2, which carries whisper, wants the CUDA 12 ones, and
both unpack into nvidia/cudnn/lib. Two environments cost nothing here, because
each engine is already its own process.

All 54 voices live in one 27 MB pack, so a voice is chosen per request and
switching costs nothing.

Protocol: one JSON request per line on stdin, one JSON reply per line on
stdout. {"text": str, "wav": path, "voice": str} -> {"wav": path,
"seconds": float}.
"""
import json
import sys
import time
import wave

import numpy as np
import onnxruntime as ort
from kokoro_onnx import Kokoro


def reply(**fields) -> None:
    sys.stdout.write(json.dumps(fields) + "\n")
    sys.stdout.flush()


def write_wav(path: str, samples, rate: int) -> None:
    """16-bit PCM, because that is all the transport's wav reader takes."""
    pcm = (np.clip(samples, -1.0, 1.0) * 32767).astype("<i2")
    with wave.open(path, "wb") as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(rate)
        out.writeframes(pcm.tobytes())


def main() -> None:
    model, voices, default_voice = sys.argv[1], sys.argv[2], sys.argv[3]
    session = ort.InferenceSession(model, providers=["CUDAExecutionProvider", "CPUExecutionProvider"])
    kokoro = Kokoro.from_session(session, voices)

    # The warmup is also the check that matters. When the CUDA libraries are
    # missing, onnxruntime falls back to the CPU without failing, and the only
    # sign is that everything is ten times slower. So the provider in use is
    # reported, and the bridge says so out loud.
    started = time.time()
    samples, rate = kokoro.create("Ready.", voice=default_voice, lang="en-us")
    reply(ready=True, sample_rate=rate, provider=session.get_providers()[0],
          warmup_seconds=round(time.time() - started, 3))

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
            started = time.time()
            samples, rate = kokoro.create(request["text"], voice=request.get("voice") or default_voice, lang="en-us")
            write_wav(request["wav"], samples, rate)
            reply(wav=request["wav"], seconds=round(time.time() - started, 3))
        except Exception as error:
            reply(error=str(error))


main()
