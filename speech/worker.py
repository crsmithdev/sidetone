"""What every worker under speech/ has in common: the protocol.

One JSON request a line on stdin, one JSON reply a line on stdout, in order.
A bad request answers with an error and the loop goes on, because a worker
that dies takes the conversation with it.

stdout is the protocol, and the libraries write to it uninvited: the
chatterbox watermarker announces "loaded PerthNet (Implicit) at step 250,000"
the first time a model is built, which arrived at the bridge as a line that is
not JSON. So the protocol keeps the real stdout and everything else goes to
stderr, where the bridge already shows worker output. Import this module
before any model library, so the swap happens first.

    import worker
    ...load the model, warm it...
    worker.reply(ready=True, sample_rate=rate)
    worker.serve(handle)          # handle(request) -> the reply's fields
"""
import json
import sys
import time
import wave
from typing import Callable

PROTOCOL = sys.stdout
sys.stdout = sys.stderr


def reply(**fields) -> None:
    PROTOCOL.write(json.dumps(fields) + "\n")
    PROTOCOL.flush()


def write_wav(path: str, samples, rate: int) -> None:
    """16-bit PCM, because that is all the transport's wav reader takes."""
    import numpy as np

    pcm = (np.clip(samples, -1.0, 1.0) * 32767).astype("<i2")
    with wave.open(path, "wb") as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(rate)
        out.writeframes(pcm.tobytes())


def serve(handle: Callable[[dict], dict]) -> None:
    """Answer requests until stdin closes. Each reply carries how long it took."""
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            started = time.time()
            fields = handle(json.loads(line))
            reply(**fields, seconds=round(time.time() - started, 3))
        except Exception as error:  # a bad request must not take the worker down
            reply(error=str(error))
