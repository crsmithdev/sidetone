# Sidetone

A spoken conversation with a Claude Code session: Chris talks to his phone, a
bridge on his desktop machine does the hearing and the speaking, and the agent
does the reasoning. These are the words this project uses. The feature
specification is [`docs/voice-bridge-spec.md`](docs/voice-bridge-spec.md); the
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

**The control channel**:
The words between the bridge and a client, apart from the audio: what was heard, each sentence as it is known, a turn, a note, and what a returning client missed. One module owns its vocabulary in both directions.
_Avoid_: the data channel, the transcript feed, the messages.

### The conversation

**A turn**:
One thing Chris asked and the answer to it.
_Avoid_: an exchange, a request, a query.

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
A tone rather than speech, which says what the bridge is doing while it does it.
_Avoid_: a beep, a sound effect, a notification.

**The narration**:
What the bridge says about a tool the agent is running, so a long turn does not sound like a dropped call.
_Avoid_: a progress update, a status message.

**A round trip**:
From the end of Chris's speech to the first sound of the answer. The one number that says whether this feels like a conversation.
_Avoid_: the latency, the response time.

### What Chris says

**The wake word**:
"hey bridge". It separates a command from ordinary speech, and it is matched by sound rather than by spelling.
_Avoid_: the hotword, the trigger, the activation phrase.

**A command**:
Something Chris says to the bridge itself, after the wake word. Everything else he says is for the agent.
_Avoid_: an instruction, a directive (those are for the agent).

**A gated action**:
An action the bridge does only after Chris speaks the agreement word. It fails closed.
_Avoid_: a confirmation, an approval, a prompt.

**The agreement word**:
"continue". Deliberately not "yes", because a reflex or a mis-transcription must not carry a gate.
_Avoid_: the confirmation word, the safe word.

**Muted**:
The bridge keeps listening and keeps transcribing, but acts on nothing except unmute.
_Avoid_: paused, deafened, off.

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
