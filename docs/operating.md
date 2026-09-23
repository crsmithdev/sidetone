# Operating Sidetone

Sidetone drives a Claude Code session by voice, from a phone, over a bridge
that runs on your own machine. Claude Code does the reasoning; the bridge owns
every voice decision and does speech locally.

The words this project uses are in [`CONTEXT.md`](../CONTEXT.md), and the decisions
behind them are in [`docs/adr/`](adr). The full specification is
[`docs/sidetone-spec.md`](sidetone-spec.md).
Section numbers in the source refer to it. Picking this up after a break:
[`docs/next.md`](next.md) says how far it got, and which parts look
finished but are not verified.

> The manifest-to-MCP **project bridge** that used to live here is on the
> `project-bridge` branch. It still runs the story pipeline; nothing about it
> changed. `git checkout project-bridge` to get it back.

## Where it is

Build order is spec section 7. Done so far:

| | |
|---|---|
| 7.1 narration hook | removed from the spec; the bridge narrates from the stream |
| 7.2 text round trip | **here**, `bun src/main.ts chat <dir>` |
| 7.3 voice | done. The desk loop that built it is gone; the fake phone is the scripted spoken run |
| 7.4 web client | **here**, `bun src/main.ts serve <dir>` |
| 7.5 Android app | **here**, `android/`, side-loaded |

```bash
bun install
bun src/main.ts chat ~/some-project    # a spoken conversation, typed
bun src/main.ts serve ~/some-project   # a spoken conversation, for a phone, over LiveKit
bun src/main.ts config                 # every setting, and which are not default
bun src/main.ts chat ~/some-project --record-stream run.ndjson   # keep what Claude Code printed, as a fixture
```

Voice needs the local engines once. The transcriber and the piper fallback:

```bash
uv venv .venv
uv pip install --python .venv/bin/python faster-whisper piper-tts nvidia-cublas-cu12 nvidia-cudnn-cu12
.venv/bin/python -m piper.download_voices --download-dir ~/.sidetone/models en_US-lessac-medium
```

The voice that speaks by default is chatterbox, which clones a voice from a
recording. It gets its own environment, because the torch it pins has no
kernels for this card and would fail with "no kernel image is available":

```bash
uv venv --python 3.12 ~/.sidetone/chatterbox-venv
uv pip install --python ~/.sidetone/chatterbox-venv/bin/python torch==2.9.1 torchaudio==2.9.1
uv pip install --python ~/.sidetone/chatterbox-venv/bin/python "numpy<2" librosa==0.11.0 \
  s3tokenizer transformers==5.2.0 diffusers==0.29.0 resemble-perth conformer==0.3.2 \
  safetensors==0.5.3 spacy-pkuseg pykakasi==2.3.0 pyloudnorm omegaconf "setuptools<81"
uv pip install --python ~/.sidetone/chatterbox-venv/bin/python chatterbox-tts --no-deps
```

`--no-deps` is what keeps the pinned torch out, and `setuptools<81` is what
keeps `pkg_resources` in, which the watermarker still imports.

A voice is a wav under `~/.sidetone/models/chatterbox/refs`, named the way
`ttsVoice` names it. The two that ship are `som_00295` and `sof_01208`, from
the Crowdsourced UK and Ireland English Dialect data set (OpenSLR 83, CC BY-SA
4.0); `CREDITS.txt` beside them says so. Any clean fifteen seconds of speech
works as a reference, and the silence in it is copied into every sentence, so
cut the dead air out first.

A sentence costs about three seconds this way, against kokoro's fifteenth of a
second. That is the price of choosing the voice rather than picking one off a
list. `ttsEngine: "kokoro"` in the config buys the speed back.

The bridge's own lines -- "Muted.", "Tones off.", "Switched to the male voice."
-- are made once and kept under `~/.sidetone/spoken`, so a command is
answered at once instead of three seconds later. Make them all after changing
voice or either voice setting:

```bash
bun src/main.ts warm
```

Nothing has to be warmed: a line that is missing is made the slow way and then
kept. Emptying the directory costs one slow sentence each.

The text loop is useful on its own, and it is where the process management gets
exercised before any audio exists. The reply streams word by word, through the
same hook that will feed the sentence collector when voice arrives.

## Layout

| | |
|---|---|
| `src/config.ts` | section 21 entire: every default in the spec, as a setting |
| `src/protocol.ts` | Claude Code's stream-json output, reduced to what the bridge acts on |
| `src/supervisor.ts` | the three fault detectors of section 8, as a clock-driven state machine |
| `src/narrator.ts` | what the bridge says while a tool runs, so a long turn is not silence |
| `src/speech.ts` | section 4: the local engines behind the interface of 4.8, one table that names each engine's worker and voices, and what is kept between runs |
| `speech/chatterbox_worker.py` | 4.9 the cloning voice: a reference wav in, a sentence out |
| `src/ear.ts` | 11.5 and 18.4: what the bridge does with sound, whichever loop brought it |
| `src/measures.ts` | section 18: every fact about a turn, told once, read two ways |
| `src/messages.ts` | 4.3 the control channel's vocabulary, which the bridge owns: every kind it may send, typed |
| `src/channel.ts` | 4.3 the control channel: what a client is told, what a returning one missed (14.8), and what a client's message does |
| `src/sentences.ts` | section 5.6: the streamed reply cut at sentence ends |
| `src/commands.ts` | section 9: the wake word, matched by sound rather than spelling |
| `src/cues.ts` | section 15: a soft tone, so a wait is never plain silence |
| `src/conversation.ts` | the turn, the commands and the checkpoint, above any transport. The agent arrives at a seam (ADR 0001) |
| `src/mouth.ts` | what the bridge says, from a sentence to the sound of it: the queues, the hold, carry on, whose voice, and the lines kept between runs. The room supplies a speaker |
| `src/transport.ts` | section 4.1: LiveKit over WebRTC, and the control channel of 4.3 |
| `src/audio.ts` | the ends of a turn, and the barge-in, found in frames rather than by sox |
| `src/latency.ts` | section 18.4: the round trip, measured rather than felt |
| `src/network.ts` | the connection, as the framework reports it, from both ends |
| `src/bridge.ts` | the bridge assembled once: the mouth, the conversation, the ear and the channel, joined (ADR 0010). The room supplies a speaker and a sink and gets the real engines; a test passes fakes in `Parts` |
| `src/serve.ts` | section 7.4 and 12: the room, and the server that hands requests to the routes |
| `src/routes.ts` | section 12: every HTTP route, and the pairing code with its growing wait (ADR 0005), tested without a server or a room |
| `client/index.html` | the phone client. Keep the screen on (2.4) |
| `client/decode.js` | 4.3 what the page and the fake phone make of each message; a test replays `test/fixtures/messages.jsonl` through it |
| `android/` | the Android app of 17: the same client, with the screen off |
| `speech/*.py` | the two engines as long-lived workers, warmed at startup |
| `src/session.ts` | one long-lived Claude Code process, text in and text out |
| `src/main.ts` | the command line, and the text loop of 7.2 |

## The tests

`bun test` is fast, needs nothing, and is the whole suite bar one file. The
exception wants the card:

```bash
SIDETONE_GPU=1 bun test speech.smoke
```

It starts both engines against the real models and asserts the one thing that
otherwise fails silently: that onnxruntime took the graph on the GPU. Without
its CUDA libraries it does not error — it returns a working session on the CPU
and every sentence costs a second instead of a tenth, which reads as "this
feels slow" rather than as a fault. Then the voice says a sentence and the
transcriber reads it back, so neither engine can rot while the other covers
for it.

`bun scripts/browser-check.ts` drives the client page in a real browser with a
wav file for a microphone. Point it at a bridge of your own, not the live one.

## Adding a command

The matcher forgives spelling, because a speech engine gives back a word that
sounded like yours rather than the one you said. So a command is not finished
when it matches what you meant to say. A command is one row in `src/commands.ts`:
its name, the words that have to be there, and the phrase the corpus is recorded
from. Add the row and what it does in `src/conversation.ts`, then:

```bash
bun scripts/heard-refresh.ts <a word from the phrase>
```

It says the phrase in two voices, buries it in brown noise at 10, 0 and -5 dB,
reads it back with the model that ships, and records every distinct spelling in
`test/fixtures/heard.json`. `bun test` then checks that each of them reaches the
right command, with no GPU and no audio. Until the corpus has the phrase, the
test that says every command is in it fails, and the test that says every fixed
line a command answers with is a kept line fails until `KEPT_LINES` has it.

Two commands have already shipped broken because this did not exist. "male
voice" comes back as *Mail Voice*; "end the turn" elides to *in the turn*, and
sometimes *and the turn*; "never mind" is one word to the engine. Each was
found in a live run, which is an expensive place to find it.

## Running it as a service

The units are in `deploy/`, copied to `~/.config/systemd/user/`. Four things
in them are there because something went wrong without them.

**The card, hourly.** `sidetone-card.timer` scores the last hour and writes one
line to the journal (`journalctl --user -u sidetone-card`). Every figure in it
was already counted and none of it was read: a coffee shop on 22 September put
70 turns nobody asked for through the agent over two hours, and the number that
said so sat in the record until somebody went looking.

**`PATH` in `~/.sidetone/env`.** A user manager boots with nothing from the
home directory on its path. Without this the bridge cannot find `claude`, and
the agent it starts cannot find anything either.

**A start limit.** `Restart=always` with a three second delay makes a service
that has never once succeeded look exactly like one that works. Ten failures in
ten minutes now ends in `failed`, where it can be seen.

**A health check.** `/health` says whether the bridge is *working*: the room is
joined and the agent is alive. A timer asks every two minutes and restarts the
bridge if it stops answering — but only while the unit is still active, so a
bridge that has given up stays given up rather than being quietly papered over.

**A renewal that only interrupts when it has to.** `scripts/renew-cert.ts`
fetches the certificate weekly and restarts the terminator and the bridge only
when the fingerprint changed. The certificate lasts three months; the other
fifty-one restarts a year would cut off whatever was being said for nothing.

```bash
loginctl enable-linger $USER
cp deploy/*.service deploy/*.timer ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now sidetone.service sidetone-cert.timer sidetone-health.timer sidetone-card.timer
```

## What another repository depends on

The caller project runs this repository's speech workers out of this checkout.
It spawns `speech/stt_worker.py` and `speech/tts_worker.py` with
`.venv/bin/python3`, puts the CUDA wheels under
`.venv/lib/python*/site-packages/nvidia/*/lib` on the library path the same way
`src/speech.ts` does, and reads models from `~/.sidetone/models`. It
overrides the first two with `SIDETONE_HOME` and `SIDETONE_MODELS`.

So these are load-bearing outside this repository, and moving them breaks a
project that nothing here mentions:

| what | why it matters |
|---|---|
| `speech/stt_worker.py`, `speech/tts_worker.py` | spawned by path, and their one-JSON-per-line protocol is the interface |
| `.venv/bin/python3` and its nvidia wheels | caller has no Python environment of its own |
| `~/.sidetone/models` | the piper voices and the whisper cache are shared |

This nearly went wrong on 13 September 2026. Kokoro wants the CUDA 13 wheels
and ctranslate2, which carries whisper, wants the CUDA 12 ones, and both unpack
into `nvidia/cudnn/lib`. Installing Kokoro into `.venv` would have taken out
transcription in both projects. It has its own environment for that reason, and
that reason is worth keeping written down.

## Process management

A warm agent process is the thing most likely to break, so section 8 gives it
three detectors that fail in different ways:

- **Silence** (8.4). No output on any channel for a minute and the process is
  dead. A tool call that is still running counts as activity, because a command
  that takes minutes emits nothing while it runs and would otherwise look
  exactly like a corpse.
- **Compaction loop** (8.5). More than three compactions in five minutes is a
  process that is busy but stuck, and the silence timer would never fire on it.
- **Ceiling** (8.6). Ten minutes into one turn the bridge speaks, says how long
  it has run and asks for the agreement word. Without one it interrupts the
  turn and keeps the process, its context and the conversation. It restarts
  only if the process does not come back within the grace time — the failed
  interrupt is the evidence that a restart is warranted.

Silence is checked before the ceiling: a dead process cannot answer a
checkpoint, so asking one would only delay its restart by the window and the
grace.

A fourth guard is not a fault detector. The **memory recycle** (8.7) samples the
resident size of the process on the same tick and recycles it past four
gigabytes, always between turns, never mid-answer. A healthy claude sits near
290 MB.

## Voice

Everything in the voice path is local, and 4.5 makes that a constraint rather
than a default: there is no cloud engine behind the interface of 4.8 and no
fallback to one. Speech to text is faster-whisper with `small.en` on the GPU,
about 657 MiB and 27 times real time. Text to speech is Kokoro on the GPU: 82M
parameters behind one ONNX graph, about a tenth of a second for the first
sentence of an answer, 800 MB of video memory while loaded. Both run as
long-lived workers, because both cost seconds to load and the bridge pays that
at startup instead of on the first thing you say.

The reply is cut at sentence ends and spoken sentence by sentence while the
model still writes the rest, so the time to first audio is the time to the
first sentence — 2.3 to 2.7 seconds measured at the desk.

The voice is `bf_emma` and `ttsVoice` is the setting. All 54 Kokoro voices sit
in one pack, so "sidetone, male voice" and "sidetone, female voice" swap
between the two named in `voiceChoices` without a restart — mid-sentence if you
like. `ttsEngine: "piper"` puts the old CPU engine back; it has one voice, and
says so when you ask it to switch.

Kokoro runs in its own virtual environment at `~/.sidetone/kokoro-venv`.
This is not tidiness: onnxruntime wants the CUDA 13 wheels and ctranslate2,
which carries whisper, wants the CUDA 12 ones, and both unpack into
`nvidia/cudnn/lib`. Two environments cost nothing, because each engine is
already its own process.

```bash
uv venv ~/.sidetone/kokoro-venv --python 3.12
VIRTUAL_ENV=~/.sidetone/kokoro-venv uv pip install kokoro-onnx "onnxruntime-gpu[cuda,cudnn]"
mkdir -p ~/.sidetone/models/kokoro   # then put kokoro-v1.0.onnx and voices-v1.0.bin in it
```

Without those CUDA wheels onnxruntime takes the graph on the CPU, nothing
errors, and a sentence goes from a tenth of a second to a whole one. The worker
reports which provider it got and the bridge prints a warning, because that
failure is otherwise invisible.

Say "sidetone" and then a command, **two words at most**. The extra words are
the ones that get mangled: "where are we" and "say that again" only ever worked
because the matcher forgave the middle of them, and on a real run "stats"
arrived as "that's" and "Steph" while the wake word came through every time.
The wake word itself is matched by sound rather than spelling, because an
engine writes the same sound several ways — including running it into the
command, which is why "Sidetonemute." is split on an exact prefix.

A command spoken over an answer stops the speech at once, and what it does to
the rest of that answer depends on the command. Only two commands touch the
agent, and both say so in their name.

| say | it does | the rest of the answer | the turn | works muted |
|---|---|---|---|---|
| mute | stops acting on speech | resumes | — | yes |
| unmute | acts on speech again | resumes | — | yes |
| tones, tones off, tones on | the cues on or off | resumes | — | yes |
| music off, music on | the hold music on or off | resumes | — | no |
| report the usage | cost, rate limit, context | resumes | — | no |
| stats | the round trip, measured | resumes | — | no |
| say again | the last sentence, or the last answer | resumes | — | no |
| summarize | a one-sentence summary | dropped; refused mid-turn | a new turn | no |
| recap | the last three exchanges | dropped | — | no |
| end turn | stops the agent | dropped | interrupted | no |
| female voice, male voice | swaps the voice mid-sentence | resumes | — | no |
| clear the context | a fresh process, after "continue" | dropped | dies with it | no |

The wake word alone, and road noise that carried no words, both leave the
answer alone: it carries on where it stopped, and a sentence a barge-in cut is
said again from the start rather than resumed from the middle of a word.

The tones mark three things and nothing else: one click says your turn ended
and the recording was taken, two clicks, bright then dark, say the turn is
running and has said nothing yet, and three clicks, dark to bright, say the
Claude Code process is coming back up. "Sidetone, tones off" silences all
three, because they are mostly a debugging aid.

Each click is 40 ms of noise cut to a band between 500 and 2000 Hz. Noise has
no pitch, so a click cannot sound like a musical note, and the band that
decides audibility against the road holds all of it. The count tells the cues
apart first, because a count survives road noise better than a colour. Against
a road-noise bed filtered to that band, the clicks stand about 6 to 8 dB above
it, where the notes they replace stood about 12. That is the cost of quieter.
`cueVolume` is the setting that buys the margin back.

The client shows what the connection is doing, and "sidetone, stats" says it
out loud along with the round trip. Both ends are kept: this end's reading says
whether the machine is reaching the room, the phone's says whether the car is,
and in a car it is the phone's uplink that goes first. Nothing acts on the
reading yet — what to do about a bad connection wants a drive behind it, and
this is what makes that drive worth taking.

"Sidetone, stats" reads the round trip out loud: the last one, the median and
worst of the last twenty, and how many barge-ins turned out to be nothing. The
clock starts when you stop talking, not when the bridge notices, so the
end-of-turn pause is inside the total — it is real time you wait. It gets its
own line rather than hiding inside the transcription figure, because
`endOfTurnPauseMs` is a setting and not a cost the engines can be blamed for.

At the desk there is no barge-in: without echo cancellation the bridge would
transcribe its own voice, so every sound it makes stops the microphone. Over
LiveKit the client cancels the echo and barge-in works.

Muting also stops the noise. While muted the bridge keeps transcribing, so
"sidetone, unmute" is still heard, but sound is no longer a reason to stop
talking — which is the whole point of muting in a loud car.

Two detectors read the same frames, and they are not the same question. A
recording opens on `speechLevel` held for `speechOnsetMs` — quiet and quick, so
the first syllable of a word is never lost. The playback only stops on
`bargeInLevel` held for `bargeInMs`, allowing dips of up to `bargeInGapMs`
between syllables — louder and longer, so a lorry going past does not cut the
bridge off mid-sentence. The gap matters: without it a five second question
barges in and "sidetone, stats" never does, because a short phrase has no
400 ms without a dip. Once a barge-in is declared it holds until that utterance
ends. The bridge then stops about six milliseconds later
and abandons the rest of what it was going to say.

## The phone

```bash
docker run -d --network host livekit/livekit-server --dev --bind 0.0.0.0
bun src/main.ts serve ~/some-project
```

The bridge prints a three-word pairing code. The phone opens the page, gives the
code once, and keeps a long-lived token from then on. The api secret never
leaves the machine.

The page keeps a light transcript, which is also the audit trail (14.7), and a
client that drops in a tunnel is given the turns it missed when it comes back
(14.8). Keep the screen on: a web page cannot hold the microphone open behind a
lock screen, which is the whole reason for the Android app at 7.5.

`bun test` cannot reach the page, so two scripts do what a unit test cannot.

`scripts/browser-check.ts` drives the real page in a real browser, with a wav
file for a microphone. `PHONE=1` runs it at phone width, and `INSECURE=1` is the
only way to get past a certificate the browser does not trust.

`scripts/fake-phone.ts` is a phone without the phone: it pairs, joins, speaks
with the same local engine the bridge uses — in the other voice, so a recording
has two voices in it — and transcribes what the bridge says back, so a spoken
conversation can be scripted and read. It ignores the cues when it decides the
bridge has finished: a cue is a burst of about 90 ms, and treating one as
speech ended a check before the agent had answered.

```bash
bun scripts/fake-phone.ts "what is two plus two" "say the word done"
bun scripts/fake-phone.ts --dir ~/some-project "summarise the readme"
bun scripts/fake-phone.ts --barge 6000 "list twenty primes" "stop, different question"
bun scripts/fake-phone.ts "run something slow" "+30s:continue"
```

A line may say when it is spoken. Some things only happen on a clock — the
checkpoint of 8.6.3 is one — and a script that waits for the bridge to finish
arrives before them and is answered as ordinary speech.

It starts a bridge of its own, on a free port and in a room of its own, and
stops it at the end. That is not tidiness: there is one long-lived room in
normal use, and a test client that joins it turns up in the real conversation,
on the real phone.

### Playing a file

The bridge plays any audio file that ffmpeg reads to the room, on request. It is
the first step of hold music. The route answers this machine only:

```bash
curl -X POST localhost:3100/play -d '{"file":"/home/me/hold-samples/Bossa Antigua.mp3"}'
```

It answers 202 when the track is queued, 409 while the audio is off, and 400
for a path that is not absolute or does not exist. The mouth plays it when
nothing is being said (15.12). A sentence fades it out, and Chris talking or
the audio going off stops it.

### Hold music

While a long turn runs and the voice is silent, the bridge plays a track to the
room (spec 15.7 to 15.11). The agent decides ahead of time. When it expects a
slow turn, it starts its reply with `[long]`. The bridge removes the marker
before the voice, the app and the transcript see the text. A turn with no
marker gets no music. A reply that starts with a tool call has no marker, so
that turn gets no music either (spec 15.7.5).

In a long turn, the music starts after `holdMusicAfterMs` of silence, 8000 by
default. The silence runs from the later of the hand-over to the agent and the
end of the last sentence. The value 0 turns the music off.

"Sidetone, music off" and "Sidetone, music on" switch the music by voice (spec
15.7.3). The bridge answers "Music off." or "Music on." The choice is the
`holdMusic` setting in the config file, so a restart keeps it. A track that
plays when Chris says "music off" stops at once. `/diagnostics` and the record
show `holdMusic` with the other settings.

The tracks are every audio file in `holdMusicFolder`, `~/.sidetone/hold/` by
default. To add a track, copy the file into the folder and restart the bridge.
The repository does not hold them. If the folder is missing or has no tracks,
the bridge logs one line, `[no hold music: ...]`, and does not try again until
the next restart. The bridge decodes each track once, on its first play, at
`holdMusicGain` (0.4). That first play waits for the decode, about a second.

The music stops when Chris talks, when the bridge has a sentence, and when the
turn ends. These are the stop conditions of `POST /play`, and the turn end. A
sentence fades the music out over `holdMusicFadeMs`, 300 by default, and the
sentence starts when the fade ends. The value 0 cuts the music at once. Chris
talking, "music off", the audio off and the end of the turn cut it at once
(spec 15.10.2). It plays one track for each silent stretch and does not loop.
Each stretch plays the next track in file-name order, and the first track
follows the last. A stopped track starts again two seconds before where it
stopped (spec 15.10.1). A restart starts every track from the start. The log
shows each play:

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

The "Audio" button in the app sends the `voice` message (spec 11.12).
The bridge then makes no sound: no voice, no tone and no hold music. The
sentence in flight and the track stop at once. The words still reach the
transcript, and the journal shows `[the audio is off; the words carry on in the
transcript]`. `POST /play` refuses with 409 while the audio is off. A new bridge
process starts with the audio on, and the app sends the cut again when it joins.
The app also sets the gain of its audio track to zero on the tap, so the sound
stops without waiting for the bridge (spec 17.10).

The "Music" button in the app sends the `music` message (spec 17.10.3). It
sets the same setting as "music off" and "music on", with no spoken answer. The
journal shows `[the hold music is off]` or `[the hold music is on]`.

The track is "Local Forecast - Elevator" by Kevin MacLeod (incompetech.com),
licensed under Creative Commons Attribution 4.0
(<https://creativecommons.org/licenses/by/4.0/>).

### The working sign

The app shows that the agent works, whatever the audio does (spec 14.10 and
17.11). The bridge sends `working` with `on` set to true when a turn starts or
a detached job starts, and again every 5 seconds while the work lasts. It sends
`on` false when the work ends. The app shows a slow pulse and the word
"working". If the heartbeat stops for 15 seconds, the sign turns red and says
"stalled". That means the bridge stopped sending, and it is the one sign that
the bridge is stuck.

A detached job is a `scripts/job` job. The script writes `pid` in the job
directory, and `exit` when the job ends. The bridge counts a directory with a
`pid`, no `exit`, and a process at that pid that has the directory in its
command line:

```bash
ls ~/.sidetone/jobs/*/pid
```

A background tool call of the agent is not a `scripts/job` job. The bridge does
not see it, so the sign does not show it. A job that an older `scripts/job`
started has no `pid` file and does not show.

### The screen log

The app keeps a log of what it showed, and sends each new entry to the bridge
once a second, over the same LiveKit data channel as the rest. The bridge
appends it to `~/.sidetone/screen/<id>.jsonl`, one file for each conversation,
and `latest.jsonl` links to the newest. The journal says when a file starts:

```text
[screen log at /home/you/.sidetone/screen/1790036106725.jsonl]
```

The log also holds events that the screen does not show as notes, such as a
microphone cut, an audio cut and a rejoin (spec 4.3.1).

The file has one JSON entry on each line, oldest first (spec 17.12). Read the
newest one, and read the last entry of a bubble to see what the screen held:

```bash
jq -c '{time, kind, answer, block, bubble, text}' ~/.sidetone/screen/latest.jsonl | tail -20
jq -s 'group_by(.bubble) | map(last | {bubble, text})' "$f"
```

`kind` says what arrived: `heard`, `sentence`, `turn`, `block`, `delta`,
`note`, `history`, `unknown` or `working`. `bubble` is the place of the line in
the transcript, and null means no line changed. `text` is the text of that line
after the change, and `got` is what the message carried. The log holds the last
500 entries. It lives in the app process, so it is gone when Chris taps Leave
or the phone ends the app.

### The screenshot

Take a screenshot with the power and volume-down keys while the app is on the
screen. The app sends the image to the bridge over the same data channel, and
the bridge writes it to `~/.sidetone/screenshots/<id>.jpg`. `latest.jpg` links
to the newest. The journal says where each image goes:

```text
[screenshot at /home/you/.sidetone/screenshots/1790036106725.jpg]
```

The app needs the photos permission (spec 17.18). Without it, the app sends
nothing and says nothing. Give it in the system settings of the app, under
Permissions, Photos and videos, "Allow all".

### Reaching it from the phone

Three things have to be true, and each one fails quietly on its own.

**The page must be https.** A browser gives no microphone to a page that is not
a secure context, and only loopback is exempt. Over plain http from any other
address `navigator.mediaDevices` is simply not there: the page loads, the room
connects, and no audio is ever published. Everything that works on the desktop
works because `127.0.0.1` is special-cased.

**The socket must be wss.** An https page may not open a `ws://` socket, and
LiveKit speaks plain ws, so something has to terminate TLS in front of it.

**LiveKit must advertise an address the phone can route to.** It advertises the
one it believes it has, which inside WSL2 is a WSL address. Signalling then
connects and the media silently never arrives.

`bun src/main.ts livekit` writes a server config that settles the third, with
keys of its own rather than the `devkey` pair every example uses:

```bash
bun src/main.ts livekit          # writes ~/.sidetone/livekit.yaml
docker run -d --name livekit --network host \
  -v ~/.sidetone/livekit.yaml:/livekit.yaml \
  livekit/livekit-server --config /livekit.yaml
```

#### Over Tailscale

Tailscale settles all three, and it is the only option that also works away from
the house, which is what 14.1 is about. It carries UDP, so the media path stays
direct rather than falling back to TCP, and `advertiseHost` finds the tailnet
address by itself.

The tailnet has to have HTTPS certificates turned on, at
<https://login.tailscale.com/admin/dns>. Then:

```bash
bun src/main.ts cert       # a real certificate, into ~/.sidetone
bun src/main.ts livekit    # the server config, advertising the tailnet address
docker run -d --name livekit --network host \
  -v ~/.sidetone/livekit.yaml:/livekit.yaml \
  livekit/livekit-server --config /livekit.yaml
```

LiveKit speaks plain ws, so put a terminator in front of it on 8443 with the
same certificate — any reverse proxy does; `caddy` is two lines. Then
`~/.sidetone/config.json`:

```json
{
  "publicOrigin": "https://<machine>.<tailnet>.ts.net:3100",
  "livekitPublicUrl": "wss://<machine>.<tailnet>.ts.net:8443",
  "tlsCert": "/home/you/.sidetone/tls-cert.pem",
  "tlsKey": "/home/you/.sidetone/tls-key.pem"
}
```

Keep the pairing code. A tailnet is a good boundary, and 12.1 still says the
endpoint is the boundary.

#### Without Tailscale

The same three settings, with a certificate from anywhere the phone trusts. A
self-signed pair proves the shape — it is how the https path above was first
tested — but a phone refuses the microphone over a certificate it does not
trust, so it is not a place to stop.

### The Android app

The app is the web client with one addition: it keeps the conversation when the
screen is off (17.2). A foreground service of type microphone holds the process
and the microphone. The bridge does not change for it (4.4).

The bridge prints a QR code under the pairing code. The code holds
`<publicOrigin>/#pair=<code>`, so one scan gives the app the address and the
code. The app scans it with the Play services scanner, which needs no camera
permission.

It needs JDK 21 and the Android SDK, with `sdk.dir` in `android/local.properties`.

```bash
cd android
./gradlew testDebugUnitTest assembleDebug
adb pair <phone-ip>:<pairing-port>        # once: Wireless debugging, pair with code
adb connect <phone-ip>:<port>
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

After the first install, the app updates itself (17.15). When the bridge serves a build that is not the installed one, the app shows "Update the app". Rebuild in the main checkout and open the app again.

`test/pairing.test.ts` and `PairingTest.kt` pin the link from each side. Change
both or neither.

The mic cut unpublishes the track and disposes it. `setMicrophoneEnabled(false)`
only mutes the track, and a muted track keeps the device recording. Check it
with `adb shell dumpsys audio`: the RecordActivityMonitor shows no record for
the app after a cut.

A test bridge for the emulator uses a config of its own, with `servePort`
3102, a `room` of its own, `publicOrigin` `http://10.0.2.2:3102` and
`livekitPublicUrl` `ws://10.0.2.2:7880`. Only debug builds allow cleartext,
and only to `10.0.2.2`. The emulator camera cannot scan a QR code from an
image, so check the scan on the phone.

## A drive, and reading it back

```bash
bun scripts/session-check.ts card     # what to say, in order
bun scripts/session-check.ts score    # how it went
```

Read the card with the phone connected, then score it. The score is the same
handful of figures every time, so two builds differ by figures rather than by
memory: which commands fired, how much of the passage came back word for word,
the median round trip, and the settings that produced all of it.

The record is appended to `~/.sidetone/record.jsonl` (`recordPath`), one
line of JSON for each event, with a header line opening each session. It is on
disk because it used to be in memory: on 14 September the service restarted
twenty seconds after a drive and the score was zeros. `score` reads the last
session that heard anything, so the empty session a restart leaves behind is
not mistaken for a drive.

## Settings

No file is needed. To change one, write `~/.sidetone/config.json`
(`$SIDETONE_CONFIG` overrides) with just the fields you want:

```json
{ "model": "opus", "ceilingMs": 900000 }
```

`bun src/main.ts config` prints the effective values and marks the ones you
have set. A timer that is not a positive number, or an agreement word of
"yes", is refused rather than quietly replaced — 10.3 exists so a reflex or a
bad transcription cannot agree to something.

## Tests

```bash
bun test        # the parser against captured claude output, and the ladder against a fake clock
bun run typecheck
```

The supervisor takes a clock, so the whole escalation is tested without
spawning anything. What a clock cannot show — that the interrupt shape is
right, that a restarted process answers, that the ladder ends a real turn — was
checked by hand against claude 2.1.267. `docs/next.md` says what was seen.
