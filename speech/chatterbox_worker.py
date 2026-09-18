#!/usr/bin/env python3
"""Text to speech that clones a voice from a recording (spec 4.5, 4.9).

Kokoro and piper each hand you a fixed list of voices. This one takes a
reference clip instead, so the voice is whoever is in the wav, and changing it
means pointing at a different file.

The cost is time. Kokoro makes a sentence in about 0.15 seconds on this card;
this makes one in about 2.5. That is the whole trade, and it is why kokoro is
still the default.

A reference is embedded once and kept, because embedding it is most of the
cost of the first sentence in that voice. Switching back to a voice already
used costs nothing.

Protocol: one JSON request per line on stdin, one JSON reply per line on
stdout. {"text": str, "wav": path, "voice": name} -> {"wav": path,
"seconds": float}.
"""
import json
import sys
import time
import wave
from pathlib import Path

# stdout is the protocol, and this stack writes to it uninvited: the
# watermarker announces "loaded PerthNet (Implicit) at step 250,000" the first
# time a model is built, which arrives at the bridge as a line that is not
# JSON. So the protocol keeps the real stdout and everything else gets stderr,
# where the bridge already shows worker output.
PROTOCOL = sys.stdout
sys.stdout = sys.stderr

import numpy as np  # noqa: E402
import torch  # noqa: E402

from chatterbox.tts import ChatterboxTTS  # noqa: E402


def reply(**fields) -> None:
    PROTOCOL.write(json.dumps(fields) + "\n")
    PROTOCOL.flush()


def write_wav(path: str, samples, rate: int) -> None:
    """16-bit PCM, because that is all the transport's wav reader takes."""
    pcm = (np.clip(samples, -1.0, 1.0) * 32767).astype("<i2")
    with wave.open(path, "wb") as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(rate)
        out.writeframes(pcm.tobytes())


def main() -> None:
    refs_dir = Path(sys.argv[1])
    default_voice = sys.argv[2]
    exaggeration = float(sys.argv[3])
    cfg_weight = float(sys.argv[4])

    device = "cuda" if torch.cuda.is_available() else "cpu"
    model = ChatterboxTTS.from_pretrained(device=device)

    embedded: dict[str, object] = {}

    def use(voice: str) -> None:
        """Point the model at a voice, embedding the clip the first time only."""
        if voice not in embedded:
            path = refs_dir / f"{voice}.wav"
            if not path.exists():
                raise FileNotFoundError(f"no reference clip for the voice {voice!r} at {path}")
            model.prepare_conditionals(str(path), exaggeration=exaggeration)
            embedded[voice] = model.conds
        model.conds = embedded[voice]

    # The warmup embeds the default voice and builds the graph, so the first
    # sentence of the first answer costs what every later one costs.
    started = time.time()
    use(default_voice)
    model.generate("Ready.", exaggeration=exaggeration, cfg_weight=cfg_weight)
    reply(ready=True, sample_rate=model.sr, device=device,
          warmup_seconds=round(time.time() - started, 3))

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
            started = time.time()
            use(request.get("voice") or default_voice)
            with torch.inference_mode():
                wav = model.generate(request["text"], exaggeration=exaggeration,
                                     cfg_weight=cfg_weight)
            write_wav(request["wav"], wav.squeeze().cpu().numpy(), model.sr)
            reply(wav=request["wav"], seconds=round(time.time() - started, 3))
        except Exception as error:  # a bad request must not take the worker down
            reply(error=str(error))


main()
