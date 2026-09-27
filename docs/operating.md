# Operating Sidetone

Sidetone drives a Claude Code session by voice, from a phone, over a bridge
that runs on your own machine. The agent does the reasoning. The bridge owns
every voice decision and does speech locally.

The words this project uses are in [`CONTEXT.md`](../CONTEXT.md), and the
decisions behind them are in [`docs/adr/`](adr). The full specification is
[`docs/sidetone-spec.md`](sidetone-spec.md), and section numbers in the source
refer to it. [`docs/todo.md`](todo.md) says what is left to build, and
[`docs/drive.md`](drive.md) says which parts still wait for a test in the car.

> The manifest-to-MCP **project bridge** is on the `project-bridge` branch.
> `git checkout project-bridge` gets it back.

This guide has three parts. [Set it up](#set-it-up) is the steps, in order.
[Reference](#reference) is what each part does. [Why it is this way](#why-it-is-this-way)
is the reasons that are not obvious from the code.

## Set it up

### Install

```bash
bun install
bun src/main.ts chat ~/some-project    # a spoken conversation, typed
bun src/main.ts serve ~/some-project   # a spoken conversation, for a phone, over LiveKit
bun src/main.ts config                 # every setting, and which are not default
bun src/main.ts chat ~/some-project --record-stream run.ndjson   # keep what Claude Code printed, as a fixture
```

The typed conversation (`chat`) needs no audio. Use it to check the agent side
first.

Voice needs the local engines once. Install the transcriber and the piper
fallback:

```bash
uv venv .venv
uv pip install --python .venv/bin/python faster-whisper piper-tts nvidia-cublas-cu12 nvidia-cudnn-cu12
.venv/bin/python -m piper.download_voices --download-dir ~/.sidetone/models en_US-lessac-medium
```

### Install the default voice

The default engine is chatterbox. It clones a voice from a reference wav. It
has its own environment, because the torch it pins has no kernels for this
card and fails with "no kernel image is available":

```bash
uv venv --python 3.12 ~/.sidetone/chatterbox-venv
uv pip install --python ~/.sidetone/chatterbox-venv/bin/python torch==2.9.1 torchaudio==2.9.1
uv pip install --python ~/.sidetone/chatterbox-venv/bin/python "numpy<2" librosa==0.11.0 \
  s3tokenizer transformers==5.2.0 diffusers==0.29.0 resemble-perth conformer==0.3.2 \
  safetensors==0.5.3 spacy-pkuseg pykakasi==2.3.0 pyloudnorm omegaconf "setuptools<81"
uv pip install --python ~/.sidetone/chatterbox-venv/bin/python chatterbox-tts --no-deps
```

`--no-deps` keeps the pinned torch out. `setuptools<81` keeps `pkg_resources`
in, because the watermarker still imports it.

A voice is a wav in `~/.sidetone/models/chatterbox/refs`, with the name that
`ttsVoice` gives it. The repository does not hold the wavs. The two default
voices are speakers `som_00295` (male) and `sof_01208` (female). They come
from the Crowdsourced UK and Ireland English Dialect data set,
[OpenSLR 83](https://www.openslr.org/83/), licensed CC BY-SA 4.0. Get them
from `southern_english_male.zip` and `southern_english_female.zip` on that
page. Each clip is the first utterances of that speaker, joined, with the
silence cut out, about 12 to 14 seconds:

```bash
unzip southern_english_male.zip 'som_00295_*'
sox $(ls som_00295_*.wav | head -4) ~/.sidetone/models/chatterbox/refs/som_00295.wav \
  silence 1 0.1 1% -1 0.1 1%
```

Do the same for `sof_01208`, and put a `CREDITS.txt` beside the wavs that
names the source and the licence. Share-alike applies to anything made from
them. Any clean fifteen seconds of speech works as a reference. Cut the
silence out first, because chatterbox copies the silence into every sentence.

### Install kokoro (optional)

Kokoro is the fast engine. A sentence costs 120 to 165 ms, against about
3 seconds with chatterbox. `ttsEngine: "kokoro"` in the config selects it. It has its own
environment, for the reason in [CUDA 12 and CUDA 13](#cuda-12-and-cuda-13):

```bash
uv venv ~/.sidetone/kokoro-venv --python 3.12
VIRTUAL_ENV=~/.sidetone/kokoro-venv uv pip install kokoro-onnx "onnxruntime-gpu[cuda,cudnn]"
mkdir -p ~/.sidetone/models/kokoro   # then put kokoro-v1.0.onnx and voices-v1.0.bin in it
```

### Make the kept lines

The bridge's own lines ("Muted.", "Tones off.", "Switched to the male voice.")
are made once and kept in `~/.sidetone/spoken`. Thus a command gets its answer
at once, not three seconds later. Make them all again after you change the
engine or a voice setting:

```bash
bun src/main.ts warm
```

This step is optional. The bridge makes a missing line the slow way and then
keeps it.

The speech worker checks each line before the bridge keeps it. `warm` makes a
line again, up to `warmTries` times, until the check accepts it. When no take
says a line cleanly, `warm` cuts it from a carrier sentence that ends with its
words. For "Stopped.", the carrier is "The answer has stopped." The check applies
to the cut too. `warm` says `carried` for such a line.

### Connect a phone

The phone needs a LiveKit server, a bridge, and a page it can reach over
https. Start with the server and the bridge:

```bash
bun src/main.ts livekit          # writes ~/.sidetone/livekit.yaml and prints the docker command
docker run -d --name livekit --network host \
  -v ~/.sidetone/livekit.yaml:/livekit.yaml \
  livekit/livekit-server --config /livekit.yaml
bun src/main.ts serve ~/some-project
```

`livekit` writes a server config with keys of its own, not the `devkey` pair
of `--dev`. The bridge uses the same keys, so the two agree.

The bridge prints a three-word pairing code. The phone opens the page, gives
the code once, and keeps a long-lived token after that. The api secret never
leaves the machine.

The page keeps a light transcript, which is also the audit trail (14.7). A
client that drops in a tunnel gets the turns it missed when it comes back
(14.8). Keep the screen on: a web page cannot keep the microphone open behind
a lock screen. The Android app (7.5) exists for that reason.

#### Reaching it from the phone

Three things must be true. Each one fails with no error.

**The page must be https.** A browser gives no microphone to a page that is
not a secure context, and only loopback is exempt. Over plain http from any
other address, `navigator.mediaDevices` is not there. The page loads and the
room connects, but the client publishes no audio.

**The socket must be wss.** An https page may not open a `ws://` socket.
LiveKit speaks plain ws, so a TLS terminator must be in front of it.

**LiveKit must advertise an address that the phone can route to.** It
advertises the address it believes it has, which is a WSL address inside
WSL2. Signalling then connects and the media never arrives. The config that
`livekit` writes settles this.

##### Over Tailscale

Tailscale settles all three. It is the only option that also works away from
the house, which is what 14.1 is about. It carries UDP, so the media path
stays direct, and `advertiseHost` finds the tailnet address by itself.

Turn on HTTPS certificates for the tailnet at
<https://login.tailscale.com/admin/dns>. Then:

```bash
bun src/main.ts cert       # a real certificate, into ~/.sidetone
bun src/main.ts livekit    # the server config, advertising the tailnet address
docker run -d --name livekit --network host \
  -v ~/.sidetone/livekit.yaml:/livekit.yaml \
  livekit/livekit-server --config /livekit.yaml
```

Put Caddy in front of LiveKit on 8443, with the same certificate. The
container must have the name `lk-tls`, because `scripts/renew-cert.ts`
restarts the container with that name. Write `~/.sidetone/Caddyfile`:

```text
{
	auto_https off
	admin off
}
:8443 {
	tls /certs/tls-cert.pem /certs/tls-key.pem
	reverse_proxy 127.0.0.1:7880
}
```

```bash
docker run -d --name lk-tls --restart unless-stopped --network host \
  -v ~/.sidetone/Caddyfile:/etc/caddy/Caddyfile:ro \
  -v ~/.sidetone:/certs:ro \
  caddy:2-alpine
```

Then write `~/.sidetone/config.json`:

```json
{
  "publicOrigin": "https://<machine>.<tailnet>.ts.net:3100",
  "livekitPublicUrl": "wss://<machine>.<tailnet>.ts.net:8443",
  "tlsCert": "/home/you/.sidetone/tls-cert.pem",
  "tlsKey": "/home/you/.sidetone/tls-key.pem"
}
```

Keep the pairing code. A tailnet is a good boundary, but 12.1 says that the
endpoint is the boundary.

##### Without Tailscale

Use the same three settings, with a certificate that the phone trusts. A
self-signed pair proves the shape, but a phone refuses the microphone over a
certificate it does not trust.

#### Install the Android app

The app is the web client with one addition: it keeps the conversation when
the screen is off (17.2). A foreground service of type microphone holds the
process and the microphone. The bridge does not change for it (4.4).

The bridge prints a QR code under the pairing code. The code holds
`<publicOrigin>/#pair=<code>`, so one scan gives the app the address and the
code. The app scans it with the Play services scanner, which needs no camera
permission.

The build needs JDK 21 and the Android SDK, with `sdk.dir` in
`android/local.properties`.

```bash
cd android
./gradlew testDebugUnitTest assembleDebug
adb pair <phone-ip>:<pairing-port>        # once: Wireless debugging, pair with code
adb connect <phone-ip>:<port>
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

After the first install, the app updates itself (17.15). When the bridge
serves a build that is not the installed one, the app shows "Update the app".
Rebuild in the main checkout and open the app again.

`test/pairing.test.ts` and `PairingTest.kt` pin the link from each side.
Change both or neither.

The mic cut unpublishes the track and disposes it. `setMicrophoneEnabled(false)`
only mutes the track, and a muted track keeps the device recording. To check
it, run `adb shell dumpsys audio`. After a cut, the RecordActivityMonitor
shows no record for the app.

A test bridge for the emulator uses a config of its own: `servePort` 3102, a
`room` of its own, `publicOrigin` `http://10.0.2.2:3102` and
`livekitPublicUrl` `ws://10.0.2.2:7880`. Only debug builds allow cleartext,
and only to `10.0.2.2`. The emulator camera cannot scan a QR code from an
image, so check the scan on the phone.

### Run it as a service

The units are in `deploy/`. Each unit reads `~/.sidetone/env`. Write it with
these four variables:

```bash
# the project the bridge starts Claude Code in (spec 6.1)
SIDETONE_DIR=/home/you/some-project
# a login shell's PATH, so the bridge finds claude and the agent finds its tools
PATH=/home/you/.local/bin:/home/you/.bun/bin:/usr/local/bin:/usr/bin:/bin
# where the health timer asks; host:port for curl --resolve, and the full URL
SIDETONE_HEALTH_HOST=<machine>.<tailnet>.ts.net:3100
SIDETONE_HEALTH_URL=https://<machine>.<tailnet>.ts.net:3100/health
```

The units assume two paths. Edit the units if yours are different:

| assumption | units |
|---|---|
| the checkout is at `~/sidetone` (`WorkingDirectory=%h/sidetone`) | `sidetone`, `sidetone-cert`, `sidetone-card` |
| bun is at `/home/crsmi/.bun/bin/bun` | `sidetone`, `sidetone-cert` |
| bun is at `~/.bun/bin/bun` (`%h/.bun/bin/bun`) | `sidetone-card` |

```bash
loginctl enable-linger $USER
cp deploy/*.service deploy/*.timer ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now sidetone.service sidetone-cert.timer sidetone-health.timer sidetone-card.timer
```

| unit | what it does |
|---|---|
| `sidetone.service` | the bridge. Ten failures in ten minutes put it in `failed` |
| `sidetone-health.timer` | asks `/health` every two minutes, and restarts the bridge if it does not answer. It does not restart a unit in `failed` |
| `sidetone-cert.timer` | runs `scripts/renew-cert.ts` weekly. It restarts `lk-tls` and the bridge only when the certificate changed |
| `sidetone-card.timer` | scores the last hour and writes one line to the journal: `journalctl --user -u sidetone-card` |

`/health` says whether the bridge works: the room is joined and the agent is
alive.

### Score a drive

A drive is a script that you read aloud in the car, and a score of the result:

```bash
bun scripts/session-check.ts card     # what to say, in order
bun scripts/session-check.ts score    # how it went
```

Read the card with the phone connected, then score it. The score is the same
set of figures each time, so you compare two builds by figures, not by
memory. The figures are the commands that fired, the part of the passage that
came back word for word, the median round trip, and the settings.

The bridge appends the record to `~/.sidetone/record.jsonl` (`recordPath`).
Each event is one line of JSON, and a header line opens each session. `score`
reads the last session that heard anything. Thus it ignores the empty session
that a restart leaves.

### Run the tests

```bash
bun test              # the whole suite; it needs no GPU and no audio
bun run typecheck
```

The supervisor takes a clock, so the tests run the whole escalation with no
process. A clock cannot show that the interrupt shape is right, that a
restarted process answers, or that the ladder ends a real turn. These were
checked by hand against claude 2.1.267.

One file needs the card:

```bash
SIDETONE_GPU=1 bun test speech.smoke
```

It starts kokoro and whisper against the real models. It asserts that
onnxruntime took the graph on the GPU, because without its CUDA libraries it
gives no error. It uses the CPU, and a sentence costs a second instead of
120 to 165 ms. Then kokoro says a sentence and whisper reads it back. When the
chatterbox environment and the default reference wav are present, it also
checks chatterbox on the GPU.

The test skips without `SIDETONE_GPU=1`. It also skips when the kokoro model or
its environment is absent, and the chatterbox part skips when its reference
wav or environment is absent. A skip prints the path it did not find.

`bun test` cannot reach the page, so two scripts do what a unit test cannot.
Run both against a bridge of your own, never the live bridge on 3100. The
fake phone starts its own bridge. For `browser-check`, start one on another
port with a config of its own:

```bash
echo '{ "servePort": 3102, "room": "check" }' > /tmp/check.json
SIDETONE_CONFIG=/tmp/check.json bun src/main.ts serve /tmp   # prints the pairing code
sox question.wav mic.wav pad 1 25                              # silence, so the question does not repeat
bun scripts/browser-check.ts http://127.0.0.1:3102 <code> mic.wav
```

`browser-check` drives the real page in Chromium, with the wav as the
microphone. It refuses a URL with `3100` in it unless you set `LIVE=1`.
`PHONE=1` runs it at phone width. `INSECURE=1` accepts a self-signed
certificate.

`scripts/fake-phone.ts` is a phone with no phone. It pairs, joins, and speaks
with the same local engine the bridge uses, in the other voice. It
transcribes what the bridge says back, so you can script and read a spoken
conversation. It ignores the cues when it decides that the bridge has
finished. A cue is about 90 ms of sound, and a check that took one as speech
ended before the agent answered.

```bash
bun scripts/fake-phone.ts "what is two plus two" "say the word done"
bun scripts/fake-phone.ts --dir ~/some-project "summarise the readme"
bun scripts/fake-phone.ts --barge 6000 "list twenty primes" "stop, different question"
bun scripts/fake-phone.ts "run something slow" "+30s:continue"
```

A line may say when it is spoken. Some things happen only on a clock, for
example the checkpoint of 8.6.3. A script that waits for the bridge to finish
arrives before them, and the bridge takes it as ordinary speech.

After each Claude Code upgrade, measure the stream facts again (spec 16.2):

```bash
bun scripts/protocol-check.ts --runs 3            # Haiku; --model sonnet for the bridge's model
```

It drives the real `claude` with the bridge's flags, text in. It prints one
line for each fact: the runs that held, the runs in all, and the claude
version. It costs money and needs the network, so it is not in `bun test`.

### Add a command

A command is one row in `src/commands.ts`: its name, the words that must be
there, and the phrase that the corpus records. Add the row, and what it does
in `src/conversation.ts`. Then:

```bash
bun scripts/heard-refresh.ts <a word from the phrase>
```

It says the phrase in two voices, buries it in brown noise at 10, 0 and
-5 dB, and reads it back with the model that ships. It records each distinct
spelling in `test/fixtures/heard.json`. `bun test` then checks that each
spelling reaches the right command, with no GPU and no audio. Until the corpus
has the phrase, the test that says every command is in it fails. The test
that says every fixed line of a command is a kept line fails until
`KEPT_LINES` has it.

The matcher forgives spelling, because a speech engine gives back a word that
sounded like yours. Thus a command that matches what you meant to say is not
finished. Commands shipped broken before this check existed, and each was
found in a live run. "Male voice" comes back as *Mail Voice*. "End the turn"
becomes *in the turn* or *and the turn*. "Never mind" is one word to the
engine.

## Reference

### Layout

The table lists the main modules only.

| | |
|---|---|
| `src/config.ts` | section 21 entire: every default in the spec, as a setting |
| `src/protocol.ts` | Claude Code's stream-json output, reduced to what the bridge acts on |
| `src/supervisor.ts` | the three fault detectors of section 8, as a clock-driven state machine |
| `src/narrator.ts` | what the bridge says while a tool runs, so a long turn is not silence |
| `src/speech.ts` | section 4: the local engines behind the interface of 4.8, one table that names each engine's worker and voices, and what is kept between runs |
| `src/ear.ts` | 11.5 and 18.4: what the bridge does with sound, whichever loop brought it |
| `src/measures.ts` | section 18: every fact about a turn, told once, read two ways |
| `src/messages.ts` | 4.3 the control channel's vocabulary, which the bridge owns: every kind it may send, typed |
| `src/channel.ts` | 4.3 the control channel: what a client is told, what a returning one missed (14.8), and what a client's message does |
| `src/sentences.ts` | section 5.6: the streamed reply cut at sentence ends |
| `src/commands.ts` | section 9: the wake word, matched by sound rather than spelling |
| `src/cues.ts` | section 15: a soft click, so a wait is never plain silence |
| `src/conversation.ts` | the turn, the commands and the checkpoint, above any transport. The agent arrives at a seam (ADR 0001) |
| `src/mouth.ts` | what the bridge says, from a sentence to the sound of it: the queues, the hold, carry on, whose voice, and the lines kept between runs. The room supplies a speaker |
| `src/transport.ts` | section 4.1: LiveKit over WebRTC, and the control channel of 4.3 |
| `src/audio.ts` | the ends of a turn, and the barge-in, found in frames rather than by sox |
| `src/latency.ts` | section 18.4: the round trip, measured |
| `src/network.ts` | the connection, as the framework reports it, from both ends |
| `src/bridge.ts` | the bridge assembled once: the mouth, the conversation, the ear and the channel, joined (ADR 0010). The room supplies a speaker and a sink and gets the real engines; a test passes fakes in `Parts` |
| `src/serve.ts` | section 7.4 and 12: the room, and the server that hands requests to the routes |
| `src/routes.ts` | section 12: every HTTP route, and the pairing code with its growing wait (ADR 0005), tested without a server or a room |
| `src/session.ts` | one long-lived Claude Code process, text in and text out |
| `src/main.ts` | the command line, and the typed conversation of 7.2 |
| `client/index.html` | the phone client. Keep the screen on (2.4) |
| `client/decode.js` | 4.3 what the page and the fake phone make of each message; a test replays `test/fixtures/messages.jsonl` through it |
| `android/` | the Android app of 17: the same client, with the screen off |
| `speech/worker.py` | the protocol every worker shares: one JSON request a line in, one JSON reply a line out |
| `speech/stt_worker.py` | 4.6 speech to text, faster-whisper |
| `speech/chatterbox_worker.py`, `speech/kokoro_worker.py`, `speech/tts_worker.py` | 4.9 text to speech: chatterbox, kokoro and piper |
| `speech/turn_worker.py` | 18.16 the turn detector, on the CPU |

### Commands

Say "sidetone" and then a command, **two words at most**. The engine mangles
the extra words. The bridge matches the wake word by sound, not by spelling,
because an engine writes the same sound in several ways. It can also join the
wake word to the command, so the bridge splits "Sidetonemute." on an exact
prefix.

A command spoken over an answer stops the speech at once. What happens to the
rest of that answer depends on the command. Only "end turn" and "clear the
context" touch the agent.

| say | it does | the rest of the answer | the turn | works muted |
|---|---|---|---|---|
| mute, stop listening | stops acting on speech | resumes | — | yes |
| unmute | acts on speech again | resumes | — | yes |
| tones off, tones on | the cues off or on | resumes | — | yes |
| music off, music on | the hold music off or on | resumes | — | no |
| audio off, audio on | all sound from the bridge off or on; the words stay in the transcript | resumes | — | no |
| interrupt off, interrupt on | whether a question mid-answer goes into the turn (11.9) | resumes | — | no |
| verbosity brief, verbosity normal, verbosity full | how much the agent says, from the next turn | resumes | — | no |
| shorter, longer | the verbosity one level down or up | resumes | — | no |
| report the usage | cost, rate limit, context | resumes | — | no |
| stats | the round trip and the connection | resumes | — | no |
| say again | the last sentence, or the last answer | resumes | — | no |
| recap | the last three exchanges | dropped | — | no |
| carry on | says the rest that a barge-in held back | said | — | no |
| end turn | stops the agent | dropped | interrupted | no |
| female voice, male voice | swaps the voice mid-sentence | resumes | — | no |
| clear the context | a fresh process, after "continue" | dropped | ends with the process | no |

The wake word alone, and road noise with no words, leave the answer as it
was. It continues from where it stopped. The bridge says a sentence that a
barge-in cut again from the start.

"Sidetone, stats" reads the round trip: the last one, the median and worst of
the last twenty, and how many barge-ins were nothing. The clock starts when
you stop talking, so the end-of-turn pause is in the total. The pause has its
own line, because `endOfTurnPauseMs` is a setting and not an engine cost.

"Stats" also reads the connection from both ends, and the client shows it.
This end says whether the machine reaches the room. The phone says whether
the car does, and in a car the phone's uplink fails first. Nothing acts on
the reading yet.

While muted, the bridge keeps transcribing, so it still hears "sidetone,
unmute". But sound no longer stops the voice.

### Settings

No file is necessary. To change a setting, write `~/.sidetone/config.json`
(`$SIDETONE_CONFIG` overrides the path) with only the fields you want:

```json
{ "model": "opus", "ceilingMs": 900000 }
```

`bun src/main.ts config` prints the values in effect and marks the ones you
set. The bridge refuses a bad value and does not replace it. The checks
include:

- `silenceMs`, `ceilingMs`, `checkpointWindowMs`, `graceMs`,
  `compactionWindowMs` and `narrationDelayMs` must be positive.
- `agreementWord` must not be "yes", so that a reflex or a bad transcription
  cannot agree to something (10.3).
- `bargeInLevel` must be louder than `speechLevel`, and `bargeInMs` longer
  than `speechOnsetMs`.
- `holdMusicFadeInMs` may be 0. `holdMusicAfterMs` and `holdMusicFadeMs` are
  not checked, and 0 is valid for them.

### Voice

Everything in the voice path is local. 4.5 makes that a constraint: there is
no cloud engine behind the interface of 4.8, and no fallback to one. Speech to
text is faster-whisper with `small.en` on the GPU, about 657 MiB and 27 times
real time. Each engine runs as a long-lived worker, because each costs
seconds to load. The bridge loads them at startup.

The bridge cuts the reply at sentence ends. It speaks each sentence while the
agent still writes the rest. Thus the time to first audio is the time to the
first sentence.

| `ttsEngine` | voices (`voiceChoices`) | default `ttsVoice` | a sentence |
|---|---|---|---|
| `chatterbox` (default) | `som_00295` male, `sof_01208` female | `som_00295` | about 3 s |
| `kokoro` | `bm_george` male, `bf_emma` female | `bf_emma` | 120 to 165 ms |
| `piper` | one voice, on the CPU | `en_US-lessac-medium` | |

"Sidetone, male voice" and "sidetone, female voice" swap between the two
voices without a restart. Piper has one voice, and says so. When a config
names an engine but no voice, the bridge uses that engine's own voices.

The worker reports the device it got, and the bridge prints a warning when it
is not the GPU. Kokoro on the CPU costs about a second a sentence.
Chatterbox on the CPU costs minutes.

### Cues

The cues mark three things only:

| cue | means |
|---|---|
| one click | your turn ended and the bridge took the utterance |
| two clicks, bright then dark | the turn runs and has said nothing yet |
| three clicks, dark to bright | the Claude Code process starts again |

"Sidetone, tones off" silences all three.

Each click is 40 ms of noise, cut to a band from 500 to 2000 Hz. Noise has no
pitch, so a click does not sound like a musical note. The count tells the
cues apart, because a count is easier to hear than a pitch in road noise.
Against road noise filtered to that band, the clicks are about 6 to 8 dB above
it. `cueVolume` sets the level.

### Barge-in

Two detectors read the same frames:

| detector | fires on | purpose |
|---|---|---|
| utterance start | `speechLevel` held for `speechOnsetMs` | quiet and quick, so the first syllable is never lost |
| barge-in | `bargeInLevel` held for `bargeInMs`, with dips of up to `bargeInGapMs` | louder and longer, so a passing lorry does not stop the voice |

Without the gap, a short phrase such as "sidetone, stats" has no 400 ms with
no dip, and never barges in. A barge-in holds until that utterance ends. The
bridge stops about six milliseconds later and holds the rest of what it was
going to say.

### Playing a file

The bridge plays any audio file that ffmpeg reads to the room. The route
answers this machine only. When `tlsCert` is set, the bridge serves https,
so give curl the certificate's name and send it to loopback:

```bash
curl -X POST https://<machine>.<tailnet>.ts.net:3100/play \
  --resolve <machine>.<tailnet>.ts.net:3100:127.0.0.1 \
  -d '{"file":"/home/you/hold-samples/Bossa Antigua.mp3"}'
```

Without TLS, use `http://localhost:3100/play`.

It answers 202 when the track is queued, 409 while the audio is off, and 400
for a path that is not absolute or does not exist. The mouth plays it when
nothing is being said (15.12). A sentence fades it out. Chris talking or the
audio going off stops it.

### Hold music

While a long turn runs and the voice is silent, the bridge plays a track to
the room (spec 15.7 to 15.11). A turn is long from the moment it calls a tool
(spec 15.7.5). A turn with no tool call gets no music.

In a long turn, the music starts after `holdMusicAfterMs` of silence, 8000 by
default. The silence runs from the later of two times: the hand-over to the
agent, or the end of the last sentence. The value 0 turns the music off.

"Sidetone, music off" and "Sidetone, music on" switch the music (spec
15.7.3). The bridge answers "Music off." or "Music on." The choice is the
`holdMusic` setting in the config file, so a restart keeps it. A track that
plays when Chris says "music off" stops at once. `/diagnostics` and the record
show `holdMusic` with the other settings.

The tracks are the audio files in `holdMusicFolder`, `~/.sidetone/hold/` by
default. To add a track, copy the file into the folder and restart the
bridge. The repository does not hold them. If the folder is missing or has no
tracks, the bridge logs `[no hold music: ...]` once and does not try again
until the next restart. The bridge decodes each track once, on its first play,
at `holdMusicGain` (0.4). That first play waits about a second for the decode.

The music stops when Chris talks, when the bridge has a sentence, and when the
turn ends. A sentence fades the music out over `holdMusicFadeMs`, 300 by
default, and the sentence starts when the fade ends. The value 0 cuts the
music at once. Chris talking, "music off", the audio off and the end of the
turn cut it at once (spec 15.10.2).

The bridge plays one track for each silent stretch and does not loop. Each
stretch plays the next track in file-name order, and the first track follows
the last. A stopped track starts again two seconds before where it stopped
(spec 15.10.1). A restart starts every track from the start. The log shows
each play:

```bash
journalctl --user -u sidetone -f | grep "hold music"
```

```text
[hold music]
[hold music stopped]
```

`[hold music ended]` means the track ran to its end. A fade out and a cut both
log `[hold music stopped]`.

### The audio cut

The "Audio" button in the app sends the `voice` message (spec 11.12). The
bridge then makes no sound: no voice, no cue and no hold music. The sentence
in flight and the track stop at once. The words still reach the transcript,
and the journal shows `[the audio is off; the words carry on in the
transcript]`. `POST /play` refuses with 409 while the audio is off. A new
bridge process starts with the audio on, and the app sends the cut again when
it joins. The app also sets the gain of its audio track to zero on the tap,
so the sound stops before the bridge acts (spec 17.10).

The "Music" button in the app sends the `music` message (spec 17.10.3). It
sets the same setting as "music off" and "music on", with no spoken answer.
The journal shows `[the hold music is off]` or `[the hold music is on]`.

### The working sign

The app shows that the agent works, whatever the audio does (spec 14.10 and
17.11). The bridge sends `working` with `on` set to true when a turn or a
detached job starts. It sends it again every 5 seconds while the work
continues. It
sends `on` false when the work ends. The app shows a slow pulse and the word
"working". If the heartbeat stops for 15 seconds, the sign turns red and says
"stalled". This means that the bridge stopped sending. It is the one sign that
the bridge is stuck.

A detached job is an aleph run: `aleph job`, `aleph run` or `aleph land`.
aleph writes `pid` in the run directory, and `exit` when the run ends. The
bridge counts a directory with a `pid`, no `exit`, and a process at that pid
that has the directory in its command line:

```bash
aleph jobs
ls ~/.aleph/jobs/*/pid
```

A background tool call of the agent is not an aleph run. The bridge does not
see it, so the sign does not show it. When a run ends, aleph POSTs one line to
`/tell`, and the bridge gives it to the agent as a `[job news]` turn at idle.

### The screen log

The app keeps a log of what it showed. It sends each new entry to the bridge
once a second, over the control channel. The bridge appends it to
`~/.sidetone/screen/<id>.jsonl`, one file for each conversation, and
`latest.jsonl` links to the newest. The journal says when a file starts:

```text
[screen log at /home/you/.sidetone/screen/1790036106725.jsonl]
```

The file has one JSON entry on each line, oldest first (spec 17.12). Read the
newest entries, and read the last entry of a bubble to see what the screen
held:

```bash
jq -c '{time, kind, answer, block, bubble, text}' ~/.sidetone/screen/latest.jsonl | tail -20
jq -s 'group_by(.bubble) | map(last | {bubble, text})' ~/.sidetone/screen/latest.jsonl
```

`kind` says what arrived. A change to the transcript is `heard`, `sentence`,
`turn`, `block`, `delta`, `note`, `history`, `screenshot` or `unknown`. An
event that the screen does not show as a line is `working`, `microphone`,
`audio`, `music`, `rejoin`, `bridge`, `setup`, `leave` or `screenshot` (spec
4.3.1). `bubble` is the place of the line in the transcript, and null means
that no line changed. `text` is the text of that line after the change, and
`got` is what the message carried. The log holds the last 500 entries. It
lives in the app process, so it is gone when Chris taps Leave or the phone
ends the app.

### The screenshot

Take a screenshot with the power and volume-down keys while the app is on the
screen. The app sends the image to the bridge over the control channel, and
the bridge writes it to `~/.sidetone/screenshots/<id>.jpg`. `latest.jpg`
links to the newest. The journal says where each image goes:

```text
[screenshot at /home/you/.sidetone/screenshots/1790036106725.jpg]
```

The app needs the photos permission (spec 17.18). Without it, the app sends
nothing and says nothing. Give it in the system settings of the app, under
Permissions, Photos and videos, "Allow all".

### What another repository depends on

The caller project runs the speech workers of this repository from this
checkout. It starts `speech/stt_worker.py` and `speech/tts_worker.py` with
`.venv/bin/python3`. It puts the CUDA wheels under
`.venv/lib/python*/site-packages/nvidia/*/lib` on the library path, as
`src/speech.ts` does, and reads models from `~/.sidetone/models`. It
overrides the first two with `SIDETONE_HOME` and `SIDETONE_MODELS`.

If you move one of these, that project breaks, and nothing here mentions it:

| what | why it matters |
|---|---|
| `speech/stt_worker.py`, `speech/tts_worker.py` | started by path, and their one-JSON-per-line protocol is the interface |
| `.venv/bin/python3` and its nvidia wheels | caller has no Python environment of its own |
| `~/.sidetone/models` | the piper voices and the whisper cache are shared |

## Why it is this way

### CUDA 12 and CUDA 13

onnxruntime, which runs kokoro, wants the CUDA 13 wheels. ctranslate2, which
runs whisper, wants the CUDA 12 wheels. Both unpack into `nvidia/cudnn/lib`.
Kokoro in `.venv` would stop transcription in this project and in the caller
project. Thus kokoro has its own environment. Two environments cost nothing,
because each engine is already its own process.

### The service units

| unit setting | the fault it prevents |
|---|---|
| `PATH` in `~/.sidetone/env` | A user manager starts with nothing from the home directory on its path. On 13 September 2026 the bridge could not find `claude` and restarted for an hour after a reboot |
| the start limit | `Restart=always` with a three-second delay makes a service that never starts look like one that works. `failed` shows the fault |
| the health check | a running process is not a working bridge. The check restarts only an active unit, so a unit in `failed` stays there and the fault stays visible |
| the renewal compares fingerprints | the certificate lasts three months. A weekly restart would stop the voice mid-sentence 51 times a year for nothing |
| the hourly card | on 22 September a coffee shop sent 70 unwanted turns to the agent in two hours. The record had the count, and nobody read it |
| the record is on disk | on 14 September the service restarted twenty seconds after a drive, and the score was zeros |

### Process management

The warm agent process is the part most likely to break. Section 8 gives it
three detectors that catch different faults:

- **Silence** (8.4). No output on any channel for a minute means that the
  process is dead. A tool call that still runs counts as activity. A command
  that takes minutes prints nothing while it runs, and without this rule it
  would look like a dead process.
- **Compaction loop** (8.5). More than three compactions in five minutes means
  that the process is busy but stuck. The silence timer never fires on it.
- **Ceiling** (8.6). Ten minutes into one turn, the bridge says how long the
  turn has run and asks for the agreement word. With no agreement, it
  interrupts the turn and keeps the process, its context and the
  conversation. It restarts the process only if the process does not come
  back within the grace time.

The supervisor checks silence before the ceiling. A dead process cannot answer
a checkpoint, so the checkpoint would only delay its restart.

A fourth guard is not a fault detector. The **memory recycle** (8.7) samples
the resident size of the process on the same tick. Past four gigabytes, it
recycles the process, always between turns. A healthy agent process uses
about 290 MB.
