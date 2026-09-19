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

{"text": str, "wav": path, "voice": str} -> {"wav": path, "seconds": float}
"""
import sys
import time

import worker

import onnxruntime as ort  # noqa: E402
from kokoro_onnx import Kokoro  # noqa: E402


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
    worker.reply(ready=True, sample_rate=rate, provider=session.get_providers()[0],
                 warmup_seconds=round(time.time() - started, 3))

    def handle(request: dict) -> dict:
        samples, rate = kokoro.create(request["text"], voice=request["voice"], lang="en-us")
        worker.write_wav(request["wav"], samples, rate)
        return {"wav": request["wav"]}

    worker.serve(handle)


main()
