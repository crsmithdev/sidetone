#!/usr/bin/env python3
"""The turn detector, on the CPU only (spec 18.16).

Pipecat Smart Turn v3 reads the end of an utterance and gives the chance that
the turn is complete. The model is a Whisper Tiny encoder with a classifier,
8 MB of int8 ONNX, and it never touches the GPU: the GPU is full.

The model takes 8 seconds of 16 kHz mono audio. Shorter audio gets zeroes in
front, so the speech sits at the end. The features are the log-mel of
Whisper's feature extractor with `do_normalize`, written here in numpy so the
worker needs no transformers package. They match it to 1e-6.

The bridge sends the room's audio as it is, and the downsampling happens
here: done in the bridge, it held the event loop for up to 23 ms.

{"pcm": base64 of 16-bit little-endian mono, "rate": a multiple of 16000}
    -> {"probability": float, "inference_ms": float, "seconds": float}
    `inference_ms` is the downsampling, the features and the model together
"""
import base64
import sys
import time

import worker

import numpy as np  # noqa: E402
import onnxruntime as ort  # noqa: E402

RATE = 16_000
SECONDS = 8
# a Blackman-windowed sinc cut at 7 kHz, so sound above 8 kHz does not fold
# down into the band the model reads
TAPS = 63
CUTOFF_HZ = 7_000
N_FFT = 400
HOP = 160
MELS = 80


def mel_filters() -> np.ndarray:
    """Slaney mel filters from 0 to 8 kHz, as Whisper's feature extractor builds them."""
    def hz_to_mel(hz):
        hz = np.asarray(hz, dtype=np.float64)
        mel = 3.0 * hz / 200.0
        log = hz >= 1000.0
        return np.where(log, 15.0 + np.log(np.maximum(hz, 1e-10) / 1000.0) * (27.0 / np.log(6.4)), mel)

    def mel_to_hz(mel):
        mel = np.asarray(mel, dtype=np.float64)
        hz = 200.0 * mel / 3.0
        log = mel >= 15.0
        return np.where(log, 1000.0 * np.exp(np.log(6.4) / 27.0 * (mel - 15.0)), hz)

    bins = np.linspace(0, RATE // 2, 1 + N_FFT // 2)
    points = mel_to_hz(np.linspace(hz_to_mel(0.0), hz_to_mel(RATE / 2), MELS + 2))
    widths = np.diff(points)
    slopes = points[None, :] - bins[:, None]
    down = -slopes[:, :-2] / widths[:-1]
    up = slopes[:, 2:] / widths[1:]
    filters = np.maximum(0, np.minimum(down, up))
    filters *= (2.0 / (points[2:MELS + 2] - points[:MELS]))[None, :]
    return filters  # (bins, mels)


FILTERS = mel_filters()
WINDOW = 0.5 - 0.5 * np.cos(2 * np.pi * np.arange(N_FFT) / N_FFT)  # periodic Hann


def downsample(audio: np.ndarray, rate: int) -> np.ndarray:
    """The audio at 16 kHz. The rate is the room's, a whole multiple of 16 kHz."""
    if rate % RATE:
        raise ValueError(f"the rate must be a multiple of {RATE}, not {rate}")
    step = rate // RATE
    if step == 1:
        return audio
    at = np.arange(TAPS) - (TAPS - 1) / 2
    kernel = np.sinc(2 * CUTOFF_HZ / rate * at) * np.blackman(TAPS)
    kernel /= kernel.sum()
    return np.convolve(audio, kernel, mode="same")[::step]


def features(audio: np.ndarray) -> np.ndarray:
    """The last 8 s, zeroes in front, as (1, 80, 800) float32."""
    size = SECONDS * RATE
    audio = audio[-size:]
    audio = np.pad(audio, (size - len(audio), 0))
    audio = (audio - audio.mean()) / np.sqrt(audio.var() + 1e-7)
    padded = np.pad(audio, N_FFT // 2, mode="reflect")
    frames = 1 + (len(padded) - N_FFT) // HOP
    strided = np.lib.stride_tricks.as_strided(padded, (frames, N_FFT), (padded.strides[0] * HOP, padded.strides[0]))
    power = np.abs(np.fft.rfft(strided * WINDOW, axis=1)) ** 2
    mel = np.log10(np.maximum(power @ FILTERS, 1e-10)).T[:, :-1]
    mel = np.maximum(mel, mel.max() - 8.0)
    return ((mel + 4.0) / 4.0)[None].astype(np.float32)


def main() -> None:
    started = time.time()
    options = ort.SessionOptions()
    options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
    options.inter_op_num_threads = 1
    options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    # four threads: the default of one a core was slower on a busy machine, and
    # takes every core from the rest of the bridge
    options.intra_op_num_threads = 4
    session = ort.InferenceSession(sys.argv[1], sess_options=options, providers=["CPUExecutionProvider"])

    def score(audio: np.ndarray, rate: int) -> dict:
        began = time.perf_counter()
        audio = downsample(audio, rate)[-SECONDS * RATE:]
        probability = float(session.run(None, {"input_features": features(audio)})[0].reshape(-1)[0])
        return {"probability": round(probability, 4), "inference_ms": round((time.perf_counter() - began) * 1000, 1)}

    # the first run builds the kernels, so the first real one is fast
    score(np.zeros(3 * RATE, dtype=np.float32), 3 * RATE)
    worker.reply(ready=True, load_seconds=round(time.time() - started, 2))

    def handle(request: dict) -> dict:
        pcm = np.frombuffer(base64.b64decode(request["pcm"]), dtype="<i2")
        return score(pcm.astype(np.float32) / 32768.0, int(request["rate"]))

    worker.serve(handle)


if __name__ == "__main__":
    main()
