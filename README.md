<img src="docs/icon.svg" alt="The Sidetone icon: a flat line with one sine cycle" width="96" height="96">

# Sidetone

Talk to Claude Code from your phone.

Sidetone is a voice bridge that runs on your own machine. It keeps one Claude
Code session alive in a project directory. You hold a spoken conversation with
that session from a phone. You get the full Claude Code loop: your `CLAUDE.md`,
your skills, your subagents and your tools. You do not get a stripped-down chat
model with a few tools.

It is built for the car. The phone stays in the cradle, you talk, and the
answer comes back as speech while the agent works.

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
the bridge prints, and keeps a token for 30 days (`tokenDays`). Claude Code
reads and writes text only. The bridge makes every decision about voice.

## Requirements

- Linux or WSL2, with an NVIDIA GPU and CUDA
- [Bun](https://bun.sh) 1.4.2 or later (the tests use its fake timers) and [uv](https://docs.astral.sh/uv/)
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code), signed in
- Docker, to run the LiveKit server
- HTTPS that the phone trusts. A phone browser gives no microphone to a page
  that is not HTTPS. [Tailscale](https://tailscale.com) gives the certificate,
  and it also works away from home.

## Quick start

1. Install:

   ```bash
   git clone https://github.com/crsmithdev/sidetone
   cd sidetone
   bun install
   ```

2. Install the transcriber, and Piper as a first voice:

   ```bash
   uv venv .venv
   uv pip install --python .venv/bin/python faster-whisper piper-tts \
     nvidia-cublas-cu12 nvidia-cudnn-cu12
   .venv/bin/python -m piper.download_voices \
     --download-dir ~/.sidetone/models en_US-lessac-medium
   mkdir -p ~/.sidetone && echo '{ "ttsEngine": "piper" }' > ~/.sidetone/config.json
   ```

3. Check the agent side with a typed conversation:

   ```bash
   bun src/main.ts chat ~/some-project
   ```

4. Start the LiveKit server. `livekit` writes `~/.sidetone/livekit.yaml` with
   the bridge's own keys and prints this `docker` command:

   ```bash
   bun src/main.ts livekit
   docker run -d --name livekit --network host \
     -v ~/.sidetone/livekit.yaml:/livekit.yaml \
     livekit/livekit-server --config /livekit.yaml
   ```

5. Set up HTTPS, then start the bridge. On Tailscale, `cert` gets a
   certificate into `~/.sidetone`. The
   [operating guide](docs/operating.md#reaching-it-from-the-phone) gives the
   settings and the TLS terminator in front of LiveKit.

   ```bash
   bun src/main.ts cert
   bun src/main.ts serve ~/some-project
   ```

   `serve` prints a pairing code and a QR code. Open the page on the phone and
   give it the code.

Piper is quick to set up and has one voice. The default engine is Chatterbox,
which clones a voice from a short recording and needs an environment of its
own. The [operating guide](docs/operating.md) gives its setup, and the setup
for Kokoro, HTTPS, Tailscale, the Android app and the systemd units.

## What it does

- **Speech stays local.** Transcription (faster-whisper), Chatterbox and Kokoro
  run on your GPU. Piper runs on the CPU. No audio goes to a cloud speech
  service.
- **It speaks while the agent writes.** The reply is cut at sentence ends, and
  each sentence is spoken while the next one is still being written.
- **You can talk over it (a barge-in).** Start to talk and the speech stops at
  once. By default (`interruptOnSpeech` is false), the bridge refuses a
  question while an answer runs, and the rest of the answer resumes. Say
  "sidetone, end turn" to stop the answer.
- **It does not go silent.** While a tool runs, the bridge says what the agent is
  doing. Short clicks (cues) say that it heard you, that it is working, or that
  it is restarting.
- **You can command the bridge itself.** Say the wake word "sidetone" and a
  command: `mute`, `say again`, `recap`, `stats`, `end turn`,
  `male voice`. The wake word is matched by sound, not by spelling, so
  mis-transcriptions still land.
- **Risky commands wait for a spoken "continue".** Clearing the context, or
  letting a long turn run on, happens only after the agreement word. "Yes" is
  not enough, because a reflex or a bad transcription must not approve anything.
- **A supervisor restarts the agent.** It restarts a Claude Code process that
  dies, loops on compaction or leaks memory. A turn that runs for
  ten minutes asks before it continues.
- **Any project works.** Point it at a directory. The project's own
  instructions file tells the agent what to do there.

## Configuration

No file is needed. To change a setting, put only that setting in
`~/.sidetone/config.json`:

```json
{ "model": "opus", "ttsEngine": "kokoro" }
```

## Usage

| Command | Does |
|---|---|
| `bun src/main.ts chat <dir>` | a typed conversation with the agent in `<dir>` |
| `bun src/main.ts serve <dir>` | the bridge: a spoken conversation with the agent in `<dir>` |
| `bun src/main.ts warm` | makes every kept line that is missing |
| `bun src/main.ts livekit` | writes the LiveKit server config and prints the `docker` command |
| `bun src/main.ts cert` | gets a certificate from the tailnet into `~/.sidetone` |
| `bun src/main.ts config` | prints every setting and marks each one that differs from the default |

## When not to use it

- You have no NVIDIA GPU on the machine. Both speech engines run locally, and
  there is no cloud fallback.
- You want an app to install. Sidetone is not packaged: it is a checkout, a
  Python environment and a side-loaded Android app.
- You want to watch a diff while it works. The bridge is voice only; the phone
  shows a transcript, not the code.
- You want several people, or several projects at once. One bridge keeps one
  session in one directory.
- You want it hosted. It runs on your machine, and reaching it from outside the
  house is your own HTTPS or Tailscale problem.

## Layout

| Path | Holds |
|---|---|
| `src/` | the bridge: the agent loop, the sentence cutter, the wake word, the supervisor |
| `speech/` | the Python workers for transcription and the voices |
| `client/` | the web client the phone opens |
| `android/` | the side-loaded Android app |
| `deploy/`, `scripts/` | the systemd units and the operating scripts |
| `test/` | the suite; no GPU and no audio, except `speech.smoke` with `SIDETONE_GPU=1` |
| `~/.sidetone/` | config, models, the LiveKit keys, the record and the files the phone sends |

## Development

```bash
bun test                            # the whole suite; no GPU, no audio
bun run typecheck
SIDETONE_GPU=1 bun test speech.smoke   # the real engines, on the GPU
```

## Documentation

| Doc | Holds |
|---|---|
| [`docs/operating.md`](docs/operating.md) | setup, the phone, the service, every command |
| [`docs/spec.md`](docs/spec.md) | the full specification. Section numbers in the source refer to it |
| [`docs/design.md`](docs/design.md) | the design work not built yet: latency and the dashboard |
| [`docs/testing.md`](docs/testing.md) | the test suite, the score of a drive, and the drive card |
| [`docs/todo.md`](docs/todo.md) | what is left to build |
| [`CONTEXT.md`](CONTEXT.md) | the words this project uses |
| [`docs/adr/`](docs/adr) | the decisions and the reasons for them |

## License

[MIT](LICENSE)
