# Sidetone

A spoken conversation with a Claude Code session: Chris talks to his phone, a
bridge on his desktop machine does the hearing and the speaking, and the agent
does the reasoning. These are the words this project uses. The feature
specification is [`docs/sidetone-spec.md`](docs/sidetone-spec.md); the
decisions behind them are in [`docs/adr/`](docs/adr).

## Language

### The parts

**Sidetone**:
The name of the project and of the program. Sidetone is the tone a telephone feeds back into the earpiece so the line never sounds dead, which is what this program does for a long turn. The code calls the program the bridge.

**The bridge**:
This program. It owns every voice decision: what is heard, what is said, and when.
_Avoid_: the server, the backend.

**The agent**:
The Claude Code process the bridge keeps alive in a project. It reads and writes text only.
_Avoid_: the model, the assistant, claude, the LLM.

**The client**:
The page or the app on the phone. It opens the microphone and plays what comes back.
_Avoid_: the frontend, the UI, the app (the app is one client of two).

**The project**:
The directory the agent runs in. Its own instructions file gives the agent its rules; the bridge is told nothing about it.
_Avoid_: the workspace, the repo.

**The room**:
Where the bridge and the client meet, and what carries audio between them.
_Avoid_: the call, the session, the channel, the connection.

**The mouth**:
The part of the bridge between a sentence and the sound of it: the queues, the hold, and what carry on says. It is the same at the desk and in the room.
_Avoid_: the output, the player, the speech queue.

**The speaker**:
What plays one sentence once the mouth has made it. The room's plays over LiveKit; a test's writes the sentence down.
_Avoid_: the sink, the audio output.

**The client's conversation**:
What a client knows about the conversation and what one message does to it: the lines, the log of them, the words of the Stop button, whether the history has been shown, and the working sign. It needs no room, and a message either changes it or asks the room for something. In the app it is one module of that name, beside the transcript.
_Avoid_: the view model, the state, the store.

**The client's joining**:
What the app does about the room: the status word it shows, whether it waits and asks again after a room ends, and whether the bridge asked for a new microphone track. It gives up on one end only, a refused pairing; every other end it tries again. It holds no room, so it is read by a test. In the app it is one module of that name, beside the conversation.
_Avoid_: the connection, the socket, the retry loop.

**The control channel**:
The words between the bridge and a client, apart from the audio: what was heard, the words of an answer as the agent writes them, each sentence as it is known, a turn, a note, whether the agent works, the screen log, a screenshot, a crash report, and what a returning client missed. One module owns its vocabulary in both directions.
_Avoid_: the data channel, the transcript feed, the messages.

### The conversation

**A turn**:
One thing Chris asked and the answer to it.
_Avoid_: an exchange, a request, a query.

**A block**:
One unbroken part of an answer. A tool call ends a block, so the text before a tool call and the text after it are two blocks. The app shows each block as one bubble.
_Avoid_: a section, a paragraph, a message (a message is one item on the control channel).

**An utterance**:
A stretch of sound the bridge treats as one thing Chris said. A pause ends it.
_Avoid_: a recording, a clip, a sample.

**A barge-in**:
Chris speaking while the bridge is speaking. It stops the speech at once.
_Avoid_: an interruption, talk-over.

**The hold**:
The rest of an answer, kept back after a barge-in, until what Chris said next decides whether it resumes or is dropped.
_Avoid_: the buffer, the queue, the pause.

**A cue**:
A click rather than speech, which says what the bridge is doing while it does it.
_Avoid_: a beep, a tone, a sound effect, a notification.

**The narration**:
What the bridge says about a tool the agent is running, so a long turn does not sound like a dropped call.
_Avoid_: a progress update, a status message.

**Hold music**:
A track the bridge plays while a long turn runs and the voice has been silent for a while. It stops for Chris, for a sentence, and for the end of the turn. It fades out for a sentence and stops at once for the rest. "music off" and the app's "Music" button turn it off.
_Avoid_: elevator music, a background track, a cue (a cue is a click that says what the bridge is doing).

**A long turn**:
A turn whose reply starts with the marker `[long]`. The agent writes the marker when it expects to run tools or think hard. The bridge removes it from the text. Only a long turn gets hold music.
_Avoid_: a slow turn, a long-running turn.

**A round trip**:
From the end of Chris's speech to the first sound of the answer. The one number that says whether this feels like a conversation.
_Avoid_: the latency, the response time.

### What Chris says

**The wake word**:
"sidetone". It separates a command from ordinary speech, and it is matched by sound rather than by spelling.
_Avoid_: the hotword, the trigger, the activation phrase.

**A command**:
Something Chris says to the bridge itself, after the wake word. Everything else he says is for the agent.
_Avoid_: an instruction, a directive (those are for the agent).

**The verbosity**:
How much the agent says in a reply: brief, normal or full. The bridge names it in one line at the head of each turn's prompt (spec 9.4.10).
_Avoid_: the length, the detail level.

**A gated action**:
An action the bridge does only after Chris speaks the agreement word. It fails closed.
_Avoid_: a confirmation, an approval, a prompt.

**The agreement word**:
"continue". Deliberately not "yes", because a reflex or a mis-transcription must not carry a gate.
_Avoid_: the confirmation word, the safe word.

**Muted**:
The bridge keeps listening and keeps transcribing, but acts on nothing except unmute.
_Avoid_: paused, deafened, off.

**Audio off**:
The bridge makes no sound: no voice, no cue and no hold music. The words carry on in the transcript. The app's "Audio" button turns it on and off. The phone mutes its audio track on the tap and does not wait for the bridge. The control channel still names the message `voice`.
_Avoid_: voice off, mute (mute is the bridge that listens and acts on nothing), silence.

**The working sign**:
A small sign in the app's status row that the agent works: a turn runs, or a detached job runs. It follows a message from the bridge, so it shows with the audio off. It says "stalled" when the bridge stops sending that message. It shows only while the room is live.
_Avoid_: the spinner, the busy light, the status.

**The reading**:
What the app's status row says about the room: the dot, the status word, the connection quality and the working sign. One function gives it from the status, the quality and the sign, so no two parts can disagree. The quality and the sign show only while the room is live.
_Avoid_: the status (the status is one input), the indicator.

**The screen log**:
What the app showed, one entry for each change of a line on the screen, with the time and the exact text. A button in the app sends it to the bridge, which writes it to `~/.sidetone/screen/` for the agent to read.
_Avoid_: the transcript (the transcript is the lines themselves), the log file, the record (the record is the bridge's own).

**A screenshot**:
The image Chris takes with the phone's own screenshot keys while the app is on the screen. The app sends it to the bridge, which writes it to `~/.sidetone/screenshots/`, with `latest.jpg` for the newest, for the agent to read.
_Avoid_: a screen capture, a picture, the screen log (the screen log is text).

**A pending screenshot**:
A screenshot that the bridge wrote and that no turn has taken. The next turn that Chris's words start takes every pending screenshot, and one line for the agent names each file. It expires after 2 minutes, and Chris can drop it with a tap on its thumbnail.
_Avoid_: an attachment, a queued image.

**A crash report**:
What the app writes when an error that nothing catches ends it: the time, the thread, the stack trace and the app state. The app sends it to the bridge in the next room, and the bridge writes it to `~/.sidetone/crashes/` for the agent to read.
_Avoid_: a crash log, a tombstone (a tombstone is Android's record of a native crash), the screen log (the screen log is what the app showed).

**The microphone cut**:
The client releases the recording device, so the phone's own indicator goes out. It is not a mute.
_Avoid_: mute the mic, disable audio.

### Joining, and what is kept

**Pairing**:
The one time a client proves it may join, with a three-word code the bridge prints. Afterwards the client keeps a token and does not ask again.
_Avoid_: login, authentication, onboarding.

**The token**:
What a paired client keeps, and the only thing that lets it into the room.
_Avoid_: the credential, the key, the password.

**The transcript**:
What was said and what was answered, in words. It is what a client shows and what an audit reads.
_Avoid_: the log, the chat history.

**The history**:
The turns a client missed while it was away, given to it when it comes back.
_Avoid_: the backlog, the replay buffer.

**The record**:
Every event of a session, written to disk as it happens, so a session can be read after the process that ran it is gone.
_Avoid_: the log file, telemetry.

**A drive**:
The bridge tested in a moving car, which is the setting it is built for and the only place road noise is real.
_Avoid_: a field test, a trial.

**The card**:
The script of commands read aloud on a drive, in order, so two drives can be compared.
_Avoid_: the test plan, the checklist.

**The scorecard**:
What a drive's record is reduced to: the handful of figures that say whether a build is better than the one before it.
_Avoid_: the metrics, the report.
