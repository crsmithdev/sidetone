<img src="docs/icon.svg" alt="The Sidetone icon: a flat line with one sine cycle" width="96" height="96">

# Sidetone

Talk to Claude Code from your phone.

Sidetone is a voice bridge. It runs on your own machine, keeps one Claude Code
session alive in a project directory, and lets you hold a spoken conversation
with it from a phone. You get the full Claude Code loop: your `CLAUDE.md`, your
skills, your subagents and your tools. You do not get a stripped-down chat
model with a few tools.

It is built for the car. The phone stays in the cradle, you talk, and the
answer comes back as speech while the agent works.

## What it does

- **Speech stays local.** Transcription (faster-whisper) and speech synthesis
  (Chatterbox, Kokoro or Piper) run on your GPU. No audio goes to a cloud
  speech service.
- **It speaks while the agent writes.** The reply is cut at sentence ends, and
  each sentence is spoken while the next one is still being written.
- **You can interrupt it.** Start to talk and the speech stops at once. What you
  say next decides whether the rest of the answer resumes or is dropped.
- **It does not go silent.** While a tool runs, the bridge says what the agent is
  doing. Short tones say that it heard you, that it is working, or that it is
  restarting.
- **You can command the bridge itself.** Say the wake word "sidetone" and a
  command: `mute`, `say again`, `summarize`, `recap`, `stats`, `end turn`,
  `male voice`. The wake word is matched by sound, not by spelling, so
  mis-transcriptions still land.
- **Risky commands wait for a spoken "continue".** Clearing the context, or
  letting a long turn run on, happens only after the agreement word. "Yes" is
  not enough, because a reflex or a bad transcription must not approve anything.
- **It looks after the agent process.** A supervisor restarts a Claude Code
  process that dies, loops on compaction or leaks memory. A turn that runs for
  ten minutes asks before it continues.
- **Any project works.** Point it at a directory. The project's own
  instructions file tells the agent what to do there.

## How it works

```
 phone ── WebRTC (LiveKit) ──▶ bridge ── stream-json ──▶ claude
 mic, speaker, transcript      speech to text             one warm process
                               sentence cutter            in your project
                               text to speech
                               wake-word commands
                               supervisor
```

The phone is a thin client: a web page, or an Android app that keeps the
microphone open with the screen off. It pairs once with a three-word code that
the bridge prints, and keeps a token after that. Claude Code reads and writes
text only. The bridge makes every decision about voice.

## Requirements

- Linux or WSL2, with an NVIDIA GPU and CUDA
- [Bun](https://bun.sh) and [uv](https://docs.astral.sh/uv/)
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code), signed in
- Docker, to run the LiveKit server
- For use away from home: [Tailscale](https://tailscale.com), or some other way
  to serve HTTPS that the phone trusts

## Quick start

```bash
git clone https://github.com/crsmithdev/sidetone
cd sidetone
bun install

# the transcriber, and Piper as a first voice
uv venv .venv
uv pip install --python .venv/bin/python faster-whisper piper-tts \
  nvidia-cublas-cu12 nvidia-cudnn-cu12
.venv/bin/python -m piper.download_voices \
  --download-dir ~/.sidetone/models en_US-lessac-medium
mkdir -p ~/.sidetone && echo '{ "ttsEngine": "piper" }' > ~/.sidetone/config.json

# a typed conversation, to check the agent side
bun src/main.ts chat ~/some-project

# a spoken conversation, for a phone
docker run -d --network host livekit/livekit-server --dev --bind 0.0.0.0
bun src/main.ts serve ~/some-project
```

`serve` prints a pairing code and a QR code. Open the page on the phone and give
it the code once.

Piper is quick to set up and has one voice. The default engine is Chatterbox, which clones a
voice from a short recording and needs an environment of its own. The
[operating guide](docs/operating.md) gives its setup, and the setup for Kokoro,
HTTPS, Tailscale, the Android app and the systemd units.

## Configuration

No file is needed. To change a setting, put only that setting in
`~/.sidetone/config.json`:

```json
{ "model": "opus", "ttsEngine": "kokoro" }
```

`bun src/main.ts config` prints every setting and marks the ones you changed.

## Status

Sidetone is a personal project for one user and one machine. The text loop,
the voice path, the web client and a side-loaded Android app all work. It is not packaged. Expect to read the operating guide.

## Documentation

| | |
|---|---|
| [`docs/operating.md`](docs/operating.md) | setup, the phone, the service, tests, every command |
| [`docs/sidetone-spec.md`](docs/sidetone-spec.md) | the full specification. Section numbers in the source refer to it |
| [`CONTEXT.md`](CONTEXT.md) | the words this project uses |
| [`docs/adr/`](docs/adr) | the decisions and the reasons for them |
| [`docs/next.md`](docs/next.md) | what is done, and what is not verified yet |

## Development

```bash
bun test                            # the whole suite; no GPU, no audio
bun run typecheck
SIDETONE_GPU=1 bun test speech.smoke   # the real engines, on the GPU
```

## License

[MIT](LICENSE)
