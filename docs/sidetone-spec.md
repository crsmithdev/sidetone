# Sidetone — Product Specification

Written in ASD-STE100 Simplified Technical English.
Feature level only. No code.

Date: 9 September 2026. Open points resolved. The narration hook of 7.1 is removed.
Blocks, bubbles and times (14.9, 17.8, 17.9) added 21 September 2026.
The working sign and the screen log (14.10, 14.11, 17.11 to 17.13) added 21 September 2026.
Text selection in the transcript (17.14) added 21 September 2026.
The screenshot (14.12, 17.18) added 22 September 2026.
Formatted text in the bubbles (17.19) added 22 September 2026.
The status row shows one state (17.11.6) from 22 September 2026.
The status row is one dot (17.11.6) from 23 September 2026.
The status word in every state, the legend of the light (17.11.7, 17.11.9) and the gear (17.22) from 23 September 2026.
The pending screenshot (14.12.5 to 14.12.7, 17.18.5) added 23 September 2026.
The crash report (14.14, 17.20) added 23 September 2026.
The spoken sentence in the bubbles (17.21) added 23 September 2026.

This document is the complete specification for Sidetone. It
includes the background, the settled design decisions, the reasoning behind
them, the full feature set, the technology choices, the build order, the
lessons from prior art, the risks, and the configuration. The document is
complete on its own. A builder can start from this document.

Sidetone is a new product. Sidetone is not this repository.
The bridge in this repository is the project bridge of Section 2.7. The
project bridge stays in place.

## 1. PURPOSE

1.1 Sidetone lets Chris drive a Claude Code session by voice from his phone.

1.2 The bridge runs on Chris's desktop machine.

1.3 The phone sends speech to the bridge. The bridge sends speech back to the phone.

1.4 The goal is a spoken conversation that feels like the Claude app voice mode, but with the desktop Claude Code as the reasoning engine.

1.5 The product is not tied to one project. The product works with any project on the machine.

## 2. BACKGROUND AND REASONING

2.1 The first question was whether Sidetone and the cross-session memory belong inside aleph. The answer is that the memory is already aleph, and Sidetone is mostly not aleph.

2.2 The vault is already the memory. Aleph writes the vault. A hook adds the map and the standing context at the start of each session. This covers memory across sessions on the machine. The gap is memory across surfaces. A plain chat on the phone cannot read the vault. A Cowork session in the cloud cannot read the vault.

2.3 Sidetone splits into parts. The part that captures speech and holds a warm Claude Code process cannot live in aleph, because this part starts Claude Code. A plugin runs inside Claude Code, not around it. This part belongs in its own repository. One small part does belong in aleph. That part is the tracing, which already works. The narration is not an aleph part. Claude Code puts each tool call on the stream that the bridge reads. A terminal session also shows its tool calls on the screen. Only a spoken session has silence to fill. The narration is therefore a bridge part. See 3.4 and 6.5.

2.4 Decision one: this product does not need a telephone call. The earlier plan used telephony because Apple does not let a web page keep the microphone open when the screen is locked. If the screen stays on, this limit does not apply, and the call gives no benefit. Voice mode with the screen on is the target. A later native app removes the screen-on limit by a different method (see Section 17).

2.5 Decision two: the app is not the brain. The Claude app can reach the machine through a connector. Chris has used this since 6 September 2026. But if the app does the reasoning and the machine holds only the tools, the product loses the Claude Code loop, the instructions file, the skills, and the subagents. This loss is acceptable when the logic of a project is already in its own command-line tool. This loss is not acceptable when the reasoning is the actual work.

2.6 Decision three: the product is not tied to one project. The project bridge is generic in its mechanism, but it needs a hand-written verb list for each project, and it cannot help a project that has no command-line tool. One bridge that starts Claude Code in any directory is the better answer. This bridge needs nothing for each project, because the instructions file of each project already holds its rules.

2.7 The general bridge takes the repository of the project bridge. Chris decided this on 9 September 2026, against the earlier rule in this paragraph. The project bridge is not deleted: it stays on the `project-bridge` branch and continues to work for the story pipeline.

2.8 The story pipeline moves to the general bridge later. The pipeline has a command-line tool, and 6.1 says the bridge starts Claude Code in the project directory, so the pipeline needs no verb list. Three points need an answer first, and 2.8.1 is the only one that needs code.

2.8.1 A pipeline step takes minutes. A tool call that runs for minutes emits nothing on any channel, so the silence detector of 8.4 would restart the process in the middle of one. See 8.4.5.

2.8.2 The pipeline reads a candidate aloud in full and does not summarize it. This looked like a missing seam and was a phrasing fault. 6.1 already gives a project a voice, in its own instructions file; what blocked it was that the brevity rule of 6.6 was written as an absolute, so nothing could yield to it. 6.6.1 now separates the rule that bends from the rule that does not. ANSWERED.

2.8.3 Work in flight must survive a restart. The agent asks the command-line tool what is in flight; the agent does not hold this in its context.

## 3. SYSTEM PARTS

3.1 The client is a page or an app on the phone. The client opens the microphone. The client sends audio to the bridge. The client plays audio from the bridge.

3.2 The bridge runs on the desktop machine. The bridge changes speech to text. The bridge sends text to Claude Code. The bridge changes reply text to speech.

3.3 Claude Code is one process on the desktop machine. Claude Code stays alive for the full conversation. Claude Code reads text only. Claude Code does not read or make audio.

3.4 The voice engine is a function of the bridge. The voice engine is not a function of the app. The voice engine is not a function of Claude Code.

3.5 Two results follow. First, Claude Code needs no change to work by voice. Second, each voice decision lives in the bridge, where it can change without a change to the agent.

## 4. TECHNOLOGY CHOICES

4.1 Transport and real-time audio use LiveKit over WebRTC. Do not build the transport by hand. Do not use plain websockets. WebRTC is made for an open microphone during playback, for barge-in, and for a connection that drops and hands off between towers in a car. LiveKit is the proven framework over WebRTC for real-time voice agents.

4.2 LiveKit gives the echo cancellation at the framework level, across the browser and the native app. The bridge does not build its own echo cancellation.

4.2.2 The app sets up the phone's audio in one place: the audio mode, how the bridge's audio plays, the audio focus, the microphone's capture source and the echo canceller. The echo canceller depends on each of these. A change to any of them is a change to barge-in, and 18.13 decides whether it ships. The bridge can push a setup for a test without a build (18.15); the one place maps its names to the constants, and says which setup runs (14.15.1).

4.2.2.1 A setup that asks for no audio focus routes the audio itself. LiveKit's handler selects the output device in the same call that asks for focus, so a setup with no focus leaves the phone to choose, and on 24 September the phone chose the earpiece in the car: the voice left the car, and Chris heard nothing. Once the room is up, the app picks from the phone's communication devices in this order: Bluetooth SCO, a Bluetooth LE headset, a wired or USB headset, then the loudspeaker. Never the earpiece: the app is used in a car and on a desk, never against an ear. When nothing in that list is present, the app sets no device and the route stays where the phone put it. The app clears its choice when it leaves the room, so the phone is left as it was found. A setup that asks for focus, which is what ships, is not touched by this rule.

4.3 LiveKit separates the control channel from the audio channel. Control events do not compete with audio frames.

4.3.1 A note in the transcript is for something Chris must know and cannot see elsewhere. A change that a control or the status light already shows gets no note. The bridge writes it to the journal, and the app writes it to the screen log (17.12) as an event with no bubble. These are events: the audio cut and resumed (11.12), the microphone cut and opened by the button, the words that an interrupt left unspoken (11.10), a silent microphone and the rejoin (18.9), and where the screen log goes (14.11).

4.4 LiveKit has a native Android SDK. The same transport, the same framework, and the same echo cancellation carry over from the web client to the Android app. The bridge does not change when the client changes.

4.5 The speech engine is fully local on the desktop machine. This is not a default. This is a constraint. No part of the voice path goes to a cloud service, in any mode, at any time. Speech-to-text is local. Text-to-speech is local. Wake-word matching is local. This removes the per-use cost, keeps the audio private, and removes a network hop that a car connection would make slow.

4.6 Speech-to-text uses a small Whisper-family model. This uses about two gigabytes of video memory and transcribes faster than real time.

4.7 Text-to-speech uses a quality local neural voice. The machine has an eight-gigabyte GPU. The speech-to-text and the text-to-speech both fit on this GPU and leave headroom. The machine is idle when Chris is out, so the GPU is free.

4.8 The speech-to-text engine and the text-to-speech engine are both replaceable parts. Each engine sits behind an interface. The interface accepts local engines only. Do not add a cloud engine, and do not add a cloud fallback for a local engine that fails or gives a bad result.

4.9 The builder selects the first working local voice and does not wait for a decision. Chris changes the voice later with a setting.

4.10 The GPU budget for the voice path is eight gigabytes. This is the whole GPU. The speech-to-text model and the text-to-speech model must fit together in this budget and leave headroom. Select each model against this budget.

4.11 The machine does no other GPU work while the bridge runs. The GPU is therefore not shared, and contention is not a risk of this design.

4.12 The local-only constraint of 4.5 makes the GPU a hard dependency, and 4.11 is the condition that makes this safe. If the machine later does other GPU work, there is no cloud path to fall back on, and the models of 4.6 and 4.9 must get smaller instead.

## 5. SIGNAL CHAIN

5.1 The client opens the microphone.

5.2 The client sends the audio to the bridge over LiveKit.

5.3 The bridge changes the speech to text with the local model.

5.4 The bridge sends the text to the Claude Code process.

5.5 The Claude Code process sends back the reply as text, word by word.

5.6 The bridge collects the words to the end of a sentence.

5.7 The bridge changes the sentence to speech with the local voice.

5.7.1 The bridge gives the voice a path as words: `src/sentences.ts` is said as "S R C slash sentences dot T S", and a part of a path with no vowel is spelled. The screen, the record and the sent clip's sentence keep the written form. The cloning voice loops on ".ts": on 24 September a sentence that named `src/sentences.ts` looped in 9 takes of 15, and the spoken form in 0 of 20.

5.8 The bridge sends the speech to the client over LiveKit.

5.9 The client plays the speech.

## 6. SETTLED DESIGN DECISIONS

6.1 A project declares nothing. The bridge starts Claude Code in the project directory. The instructions file of the project gives the agent its rules. Do not keep verb lists.

6.2 The agent works in a separate work tree. The agent does not work on the main checkout.

6.3 The agent is permissive by default. A small set of actions are gated. A gated action needs spoken agreement.

6.4 The system uses two memory stores. Claude memory holds pointers and current state. The vault holds the full notes. A test confirmed that Claude memory works across surfaces.

6.5 The voice instruction lives in the bridge. The voice instruction does not live in the aleph identity file. This keeps behavioral modes out of aleph.

6.6 The voice instruction tells the agent that it is in a spoken conversation. The agent does not read a diff aloud. The agent does not read code aloud. The agent does not read secrets aloud. The agent gives a summary instead. This rule does not bend.

6.6.2 The agent names a file by its path from the project root, for example src/audio.ts. The agent does not speak an absolute path unless Chris asks for one. This is a default and not an absolute, because the agent answers a direct question either way and a rule that is routinely broken weakens the rules beside it. This is measured, not a preference: spoken and transcribed back, the relative path takes three seconds and is understood, and the absolute path it came from takes six and a half and arrives as a run of the word "slash".

6.6.1 The voice instruction also tells the agent to be brief. This is a separate rule and it is a default, not an absolute. If the instructions file of the project asks for something to be read aloud in full, or if Chris asks, the agent reads it in full. 6.6 still holds while it does.

6.7 Every value that this document gives as a default is a setting. Section 21 lists the settings. A builder does not write a value of this kind into the code as a constant.

## 7. BUILD ORDER

7.1 The narration hook is removed. Earlier revisions made it the first step. The step numbers do not change, because other sections point to them. Claude Code puts each tool call on the stream that the bridge reads, subagent calls included. The bridge therefore needs no hook to say which tool runs. See 2.3.

7.2 Build the text round trip first. Test the full loop in text. The text loop is useful even if voice does not come.

7.3 Build voice second. Add voice on top of the text loop.

7.4 Build the screen-on web client as the first phone client. Accept that the screen must stay on.

7.5 Build a private native Android app last. The app supports screen-off voice with a foreground service. Do not publish the app.

7.6 The build starts now. The measurements of Section 18 do not block the build. Make each measurement during the build.

## 8. PROCESS MANAGEMENT

8.1 The bridge keeps the Claude Code process stable. Stability is a top priority.

8.2 The bridge monitors the health of the process. The bridge does extra self-management because of the JSON API.

8.3 The bridge uses three independent fault detectors. Each detector finds a different kind of fault. The silence detector finds a process that stopped. The compaction-loop detector finds a process that is busy but stuck. The hard ceiling catches any fault that gets past the first two.

8.4 The silence detector.

8.4.1 The silence detector watches all output from the process, not only the spoken reply. It watches the text output, the tool calls, and the movement of tokens. Output of any kind on any channel is activity.

8.4.2 The detector starts its timer only when all output stops at the same time. A process that is busy on a hard task still sends output, so the timer does not start. Activity resets the timer.

8.4.3 The default silence time is one minute. If the process sends nothing on any channel for one minute, the bridge restarts the process.

8.4.4 The silence time is a setting.

8.4.5 A tool call that is in flight is activity, for the whole time it runs. A command that takes minutes sends nothing on any channel while it runs, so without this rule it cannot be told from a process that stopped. The bridge holds the silence timer from the start of a tool call to its end.

8.4.6 The silence detector is checked before the ceiling of 8.6. A process can be silent and past the ceiling at the same time. Silence means the process is dead, and a dead process cannot answer a checkpoint, so the ladder of 8.6 would only delay the restart by the checkpoint window and the grace time.

8.5 The compaction-loop detector.

8.5.1 Claude Code prints a message when it compacts the conversation. In a healthy session this happens rarely. In a fault it happens again and again in a short time.

8.5.2 The detector counts the compaction messages. If the count is more than the limit within the window, the bridge treats this as a definite fault. The default limit is three messages in five minutes.

8.5.3 The bridge acts on this fault at once. The bridge does not wait for the silence timer, because the process is still busy and the silence timer would never start.

8.6 The hard ceiling.

8.6.1 The hard ceiling is a last-resort limit on the length of one turn. It covers the fault that the first two detectors cannot see: a process that gives activity without end and is wrong at the same time. Such a process resets the silence timer forever and can do this without a compaction message.

8.6.2 The ceiling acts in three stages. Each stage does more than the stage before it. The bridge does not go to a later stage if an earlier stage works. The reason for the stages is that the ceiling, unlike the other two detectors, can fire on a process that is fully healthy and only slow.

8.6.3 Stage one is the checkpoint. At the ceiling time the bridge speaks. The bridge says how long the turn has run. The bridge asks for the agreement word of 10.2.

8.6.4 If Chris says the agreement word within the checkpoint window, the turn continues for one more ceiling time. This can repeat without a limit. Each extension spends more tokens, so the bridge reports the usage with each checkpoint.

8.6.5 Stage two is the interrupt. If the bridge does not hear the agreement word within the checkpoint window, the bridge interrupts the turn. The bridge does not stop the process. The conversation, the context and the session stay.

8.6.6 The interrupt fails closed, as 10.5 requires. Fail closed is correct here because the cost of a wrong interrupt is low: the session stays, and Chris asks again in the next turn.

8.6.7 Stage three is the restart. After the interrupt the bridge waits for the process to be ready for a new turn. If the process is not ready within the grace time, the interrupt did not work and the process is wedged. The bridge then restarts the process.

8.6.8 A restart at the ceiling is safe because actions are atomic and the bridge commits before a risky step.

8.6.9 The default ceiling time is ten minutes. The default checkpoint window is fifteen seconds. The default grace time is thirty seconds. Each of the three is a setting.

8.6.10 The ceiling timer measures one turn. A new turn starts the timer again.

8.6.11 The ceiling is the unattended backstop. Chris ends a turn himself at any time with the command of 9.4.8. The ceiling exists for the case where Chris is not listening.

8.7 The process-memory recycle.

8.7.1 Some versions of Claude Code have a memory leak that grows without limit. The bridge watches the process memory size.

8.7.2 The bridge recycles the process when it passes the limit. The default limit is four gigabytes. On a sixty-four-gigabyte machine this is about eight to ten times a healthy footprint, so it is a clear sign of a leak and not normal work.

8.7.3 This is process memory, not context. The two are separate. A recycle is a planned restart, not only a restart after a crash.

8.8 The bridge lets Chris clear the context with a spoken command.

8.9 The bridge reads the context from Claude Code. This replaces the estimate of the earlier revisions, which 16.2 no longer supports. Claude Code sends an `autocompact_state` event with the window size and the compaction threshold, and the result of each turn carries the token counts. The bridge divides the counts by the threshold. The bridge gives a soft warning when the number gets high and a definite warning when it sees a compaction.

8.10 The bridge lets Chris select the model with a spoken command.

8.11 The default model is Sonnet. This default is final. The model is a setting.

## 9. VOICE COMMANDS

9.1 A voice command starts with a wake word. The wake word separates a command from normal speech.

9.2 The wake word is "sidetone". The wake word is a setting.

9.3 The bridge matches the sound of the wake word, not the exact spelling. A speech-to-text engine can split or spell the wake word in more than one way. The bridge accepts these forms.

9.3.1 The same tolerance applies to the command after the wake word. Each word of the command takes one spoken word of its own. One spoken word does not stand for two words of the command: "one more" is not "tones on".

9.4 The bridge does the commands that follow:

9.4.1 Mute. The bridge stops acting on speech. The bridge continues to listen for wake commands.

9.4.2 Unmute. The bridge acts on speech again.

9.4.3 Clear the context. The command needs the two words "clear context". The word "clear" alone does not clear the session.

9.4.4 Report the usage.

9.4.5 Restate the last answer.

9.4.6 The summarize command is removed. It overlaps with 9.4.7, and 9.4.10 gives short replies. The step numbers do not change, because other sections point to them.

9.4.7 Report where we are. The bridge gives a short summary of the last three request and reply pairs. Chris uses this to reorient if something feels wrong. The command is "where are we", "recap" or "catch up". The word "where" alone does not reach it, because "there" and "here" sound the same to the engine, and this command drops a held answer.

9.4.8 End the turn. Chris uses this command if the automatic detection is wrong.

9.4.9 A client can read the settings in force and change one. The bridge sends a settings message when a client joins and again whenever a setting changes, however it changed. A client changes a setting by sending one, and the bridge does exactly what the spoken command does, the voice's answer included: a switch on a screen and the words spoken aloud cannot end anywhere different. The bridge acts only on the settings it has a spoken command for — the tones, the hold music, interrupting, which of the two voices speaks, and the verbosity — and on the hold music volume (17.22.3) and the three thresholds of the ear (17.22.5, 17.22.6). It ignores any other name. Before this a client could change a setting only by sending the words of the command, and had no way at all to read one back, so a settings screen would have shown values it could not verify.

9.4.10 Set the verbosity: how much the agent says. The levels are brief, normal and full. Brief is one or two sentences and only the result. Normal is the behaviour from before the setting. Full gives the reasoning and more detail. The commands are "verbosity brief", "verbosity normal" and "verbosity full", and "shorter" and "longer" move one level. At either end, the level stays where it is. The bridge adds one line that names the level to the prompt of each turn. The level is kept in the settings file, so it survives a restart and a new session.

9.4.11 A setting that goes on and off has two commands, one for on and one for off. There is no bare command that flips it. The bare "tones" and the bare "interrupt" are removed, because a flip said blind leaves the setting in a state that Chris does not know. The bridge reads the on and off commands before the end turn command, so "turn the audio on" turns the audio on and does not end the turn.

9.4.12 "Continue" is the agreement word of 10.2 and nothing else. The command that says the rest of an answer (11.10) is "carry on", "go on" or "the rest".

9.5 Two commands work when the bridge is muted. The two commands are mute and unmute. All other commands do not work when the bridge is muted.

9.5.1 The app has a hold to talk button. A press and a release each play a cue (15.14). The button sits beside the button that cuts the microphone. The microphone is open only while Chris holds the hold to talk button. The hold to talk button is disabled while the microphone is open and Chris does not hold it. While Chris holds it, the button that cuts the microphone is disabled. The mute and unmute commands stay.

9.5.2 Chris lets go of the hold to talk button. The app then cuts the microphone. The app sends the `mic` message with `release` set. The bridge ends the utterance at once, and it does not wait for the end-of-turn pause (11.5). While Chris holds the button, a pause does not end the utterance, however long it is. Only the release ends it. An ordinary cut still drops a half-recorded utterance (ADR 0008). While the microphone is cut, the bridge hears nothing, so a barge-in cannot happen.

9.6 The set of commands that work when muted is a setting. The set is a list of command names. Chris adds a command to the list later without a change to the code.

9.7 If the bridge hears only a part of a command, the bridge asks Chris to say the command again.

## 10. GATED ACTIONS

10.1 A gated action needs a spoken agreement before the bridge does it.

10.2 The agreement word is "continue". The agreement word is a setting. The agreement word is not "yes".

10.3 The reason is safety. A specific word cannot come from a reflex or a wrong transcription. This is like the callout that a pilot must say to override a limit.

10.4 Before a gated action, the bridge reads back what it is about to do.

10.5 The gate fails closed. If the bridge does not hear a clear agreement, the bridge does not do the action.

10.6 A gated action is atomic. An interruption does not leave the action half done.

## 11. INTERRUPTION AND TURN-TAKING

11.1 The bridge supports live barge-in. Chris can talk while the bridge speaks.

11.2 The bridge keeps the microphone open while it speaks.

11.3 The bridge stops its playback the moment Chris starts to talk.

11.4 The echo cancellation comes from LiveKit (see 4.2). The bridge does not hear its own audio as speech. The hard case is double-talk, the moment when Chris and the bridge speak together, which is the barge-in moment. A proven framework handles this moment. A hand-built canceller does not.

11.5 The bridge uses automatic end-of-turn detection as the main method. A small pause is acceptable. The pause length is a setting.

11.6 The target feel is the Claude app voice mode. The bridge waits a short time. The bridge does not cut in. The bridge does not feel slow.

11.6.1 The bridge keeps its own fixed replies, such as "Muted.", on disk after it makes them once, so a reply to a command plays at once. The speech worker transcribes each reply before the bridge keeps it. A reply whose words do not match its text (18.14.2) plays that one time and is not kept. The warm command also checks each reply that is already kept, and makes a refused reply again, up to a set number of times (21.2), 100 by default. A take of a short reply costs about a second of the GPU, once, offline. The cloning voice garbles a reply of one word most of the time: on 23 September "Muted." came out clean in 2 takes of 12, and on 24 September in 1 of 5. Before this check the bridge kept the first take, and a garbled "Muted." and "Listening." played on every mute from 18 September.

11.6.3 A reply that no take says cleanly alone is cut out of a carrier. A carrier is a sentence the voice says cleanly that ends with the reply's own words in the reply's own sense, so the words close a statement in the falling tone of an acknowledgement: "The answer has stopped." carries "Stopped.". The warm command makes a take of the carrier, the speech worker gives the time of each word it heard, and the bridge cuts the reply's words out by those times. The cut passes the same check as any take (11.6.1), or it is not kept. The carrier gets the same number of takes as the reply alone. Every reply of one or two words has a carrier; a reply of three words or more came out clean in every take measured on 24 September. The wording of a reply does not change for the voice: on 24 September "Stopped." came out clean in no take of 5 alone, and it is the answer to a barge-in, so it is the reply least able to wait for a synthesis.

11.7 A cue marks the end of the bridge's speaking (15.15). Until 24 September it was an option for later.

11.8 The product is for one user. The product does not need to separate the voices of more than one person.

11.9 A question that arrives while the bridge is still speaking has one of two treatments, and which one is a setting. Holding keeps the answer and refuses the question. Interrupting stops the voice at once and asks the question, which is the feel of 11.6. Chris changes the setting out loud, because the car is where the answer is found.

11.9.1 Interrupting stops the voice. It stops the turn only when the turn will not end by itself within a set time. An interrupt reaches a subagent and stops it, and the voice is silent either way, so the bridge waits before it insists.

11.10 What the bridge did not say is kept for one turn. The client already shows it, because the words reach the client ahead of the voice (14.7, 14.9), so the bridge adds no note (4.3.1). A command says it, and the agent is told where Chris stopped hearing, because the agent's own context holds the whole answer either way.

11.11 The bridge speaks what the agent says between turns. Background work that finishes makes the agent answer without being asked, and that answer is news, so it is spoken over a held one.

11.11.1 The bridge streams that answer to the client as it streams a turn Chris asked for. Its first word opens a new answer. The `blockStart`, `delta`, `blockEnd`, `sentence`, `speaking` and `turn` messages all name that answer (14.7, 14.9, 14.13). Every `turn` names its answer.

11.12 Chris can turn the audio of the bridge off and on. The client sends the `voice` message with `on` set to false or to true. The message keeps the name it had when the voice was all the audio.

11.12.1 With the audio off, the bridge makes no sound. It plays no voice, no tone and no hold music. The words carry on in the transcript. The bridge counts a sentence as said when its words go out.

11.12.2 When the audio goes off, the bridge stops the sentence in flight and the hold music at once. It does not wait for the sentence or the track to end.

11.12.3 A new bridge process starts with the audio on. A client that has the audio off sends the `voice` message again when it joins the room.

## 12. SECURITY

12.1 The bridge endpoint needs authentication. Authentication is the security boundary.

12.2 The client pairs with the bridge one time. The client keeps a long-lived token.

12.3 The same authentication method works for the web client and the Android app.

12.4 The method is easy to use. Chris does not log in again and again.

12.5 The bridge does not read secrets aloud.

12.6 The agent runs in a dev container with git work trees. This is the accepted practice for an unattended, permissive agent that has shell access. A work tree alone protects the main checkout but does not isolate the machine. The container isolates the file system and the processes.

## 13. COST CONTROL

13.1 A warm session can spend tokens quickly.

13.2 The bridge gives a spoken warning about usage. The warning level is a setting. The number is the reported one, not an estimate (see 16.6).

13.3 Chris can ask for the usage with a spoken command.

13.4 The compaction-loop detector (8.5) also protects cost, because a compaction loop spends tokens fast.

13.5 The hard ceiling (8.6) bounds the cost of one turn in the worst case. A turn only runs past the ceiling if Chris says the agreement word, and the bridge reports the usage each time it asks.

13.6 The local speech engine has no per-use cost.

## 14. RESILIENCE AND SYNCHRONIZATION

14.1 The connection in a car is not stable. The connection drops. The connection gets weak. The connection moves between towers.

14.2 LiveKit handles the reconnection of the transport. The bridge handles the session state on top of this.

14.3 The bridge does not lose the session because of a connection problem.

14.4 The bridge does not do an action two times because of a connection problem.

14.5 The bridge gives each turn a number. A recovery command is then not ambiguous.

14.6 The bridge tells the difference between a finished turn and a stalled turn. Restate replays a finished turn. Resume continues a stalled turn.

14.7 The client keeps a light text transcript. The transcript is a summary of the turns. The transcript is a fallback when the audio stalls. The transcript is also an audit trail.

14.8 The client gets the missed turns after it connects again.

14.9 A block is one unbroken part of a reply. A tool call ends a block. The text before a tool call and the text after it are two blocks.

14.9.1 The bridge tells the client when a block that holds text starts, with `blockStart`, and when it ends, with `blockEnd`. It sends nothing for a block that holds no text, such as a tool call.

14.9.2 The bridge sends the words of a block as `delta`, as the agent writes them. It sends each `delta` before it collects the words into a sentence (5.6). The words reach the client before the sentence and before the voice.

14.9.2.1 Each `delta` has `seq`, which counts the deltas of its block from 1. The client can get two messages in the wrong order: the LiveKit Android SDK gives each message to the app from a coroutine of its own, on a pool of threads. On 23 September a bubble read "but it Dropping such only logs it." The app puts the words of a bubble in the order of `seq`, not in the order they arrive. A `delta` with no `seq` goes at the end.

14.9.3 The three messages name the answer (14.7) and the block. The bridge counts the blocks of an answer from 1. The stream restarts its own block index at each message of the agent. That index cannot name a block across a tool call.

14.9.4 The `sentence` and `turn` messages do not change. Each still names its answer. A client that ignores the blocks still grows one line for each answer.

14.9.5 A client that shows one bubble for each block shows each answer once. When it has a bubble for an answer, it ignores the `sentence` and `turn` text of that answer, because the bubbles hold the words. For an answer with no bubble, it grows a line from the `sentence` messages, as in 14.7.

14.9.6 A bubble holds the words that the agent wrote. The `turn` holds the words that Chris heard (11.10). A bubble can hold more than the `turn` when a hold or a barge-in cut the voice.

14.9.7 The history (14.8) holds one `turn` for each answer and no blocks. A client that joins shows each answer of the history as one bubble.

14.9.8 The web client ignores `blockStart`, `delta` and `blockEnd`. It keeps one line for each answer, grown by sentence (14.7), and shows no clock time. Chris asked for bubbles and times in the app. The page needs no change to work, so it keeps to 14.7.

14.10 The bridge tells the client when the agent works. The message is `working`, with `on` set to true or to false.

14.10.1 The agent works when a turn runs, or when a detached job runs. A turn runs from the moment the bridge starts it to the moment the bridge ends it, which is after the last sentence is said.

14.10.2 The bridge sends the message when the answer changes. While the agent works, it sends `on` again every 5 seconds. This is the heartbeat. A client trusts a working state only while the heartbeat keeps arriving.

14.10.3 The audio has no effect on the message. The bridge sends it with the audio on and with the audio off (11.12).

14.10.4 A detached job is a job that `scripts/job` started. For each job, the script writes a directory in `~/.sidetone/jobs/`. The directory holds a `pid` file while the job runs, and an `exit` file when it ends. The bridge reads the directories every 2 seconds. A job runs when its directory has a `pid` file and no `exit` file, and the process with that pid has the directory in its command line. A job that was killed and left no `exit` file does not run. The script refuses a name whose job runs by this same test, with exit 1, so one job cannot start two times. The bridge does not see other background work, such as a background tool call of the agent.

14.10.5 The bridge does not keep the message for the history (14.8). A client that joins while the agent works gets the state at the next heartbeat. The web client ignores the message.

14.11 The client sends its screen log (17.12) to the bridge as it grows, and the bridge appends it to disk. The agent cannot see the phone, and the file lets it read what the app showed.

14.11.1 The `screen` message carries new entries of the log. It has `id`, which names the log, and `entries`, which is a list of entries. The app sends the entries it has not sent once a second, in messages smaller than 12,000 bytes, because one data message is small. While the app is out of the room, it keeps at most 2,000 unsent entries and drops the oldest. A message that fails goes again at the next second.

14.11.2 The bridge appends the entries to `~/.sidetone/screen/<id>.jsonl`, one entry on each line. The `id` is the time in milliseconds when the app started the log, so one conversation is one file, across reconnects. `~/.sidetone/screen/latest.jsonl` links to the file written last.

14.11.3 The bridge writes one line to the journal when a new `id` starts a file, and when a message is not readable or the file cannot be written. It sends no note (4.3.1).

14.11.4 The bridge does not read the entries or act on them. The agent reads the file and needs no help from Chris. The web client does not send the message.

14.12 The client sends a screenshot (17.18) to the bridge, and the bridge writes it to disk. The agent cannot see the phone, and the file lets it see what Chris saw.

14.12.1 The `screenshot` message carries one part of one image. It has `id`, which names the image, `part`, which counts from 1, `of`, which is how many parts there are, and `data`, which is a slice of the base64 of the JPEG. The app sends messages smaller than 12,000 bytes, as in 14.11.1. A slice is a multiple of 4 characters. The bridge accepts at most 200 parts for one image.

14.12.2 The bridge keeps the parts of one image until it has all of them. It then writes the image to `~/.sidetone/screenshots/<id>.jpg`. The `id` is the time in milliseconds when the phone said that Chris took the screenshot. `~/.sidetone/screenshots/latest.jpg` links to the image written last, so the agent finds the newest image without its `id`.

14.12.3 A part of a different image drops an image that is not whole. The app does not send a part again.

14.12.4 The bridge writes one line to the journal for each image it writes, for an image that it drops, and when a message is not readable or the file cannot be written. It sends no note (4.3.1).

14.12.5 The bridge does not read the image. Chris talks about the image as he does about anything else, and his words go into the transcript. The next turn names the file to the agent (14.12.6), and the agent reads the file when the words ask for it. The web client does not send the message.

14.12.6 A written screenshot is a pending screenshot. It joins the next turn that Chris starts with his words, spoken or typed. That turn takes every pending screenshot, in the order they arrived. One line for the agent names each file, and the line does not go into the transcript. The rules are these:

- A pending screenshot expires 2 minutes after it arrives. It then joins no turn, so an old image does not join an unrelated turn.
- The bridge takes the pending screenshots when it decides that Chris's words start a turn. A screenshot that arrives after that moment waits for the next turn. It does not join the turn in progress, because that turn races with its answer (11.11). This is also true while an interrupted turn stops (11.9).
- A screenshot alone does not start a turn. Words that start no turn, such as a wake command or a question that the bridge refuses mid-turn, leave the screenshot pending.

14.12.7 The bridge tells the client what becomes of each screenshot, with the `screenshot` message. It has `id`, and `state`, which is one of these:

- `pending`: the bridge wrote the image, and it waits for the next turn.
- `sent`: a turn took it.
- `expired`: it waited 2 minutes, and no turn took it.
- `dropped`: Chris dropped it.

To drop a pending screenshot, the client sends a `screenshot` message with `id` and `drop` set to true. The bridge ignores a drop for an image that is not pending. The bridge writes one line to the journal when a turn takes an image, when an image expires, and when Chris drops one.

14.13 The bridge says when the voice reaches a sentence. A sentence message (14.7) says the words are known; this says they are being said, which is a different moment: the engine takes a fraction of a second and the queue can be seconds long. The message carries the words and the answer they belong to. A reply from the bridge itself carries no answer. A sentence a barge-in cut is said again from its start, so the message can repeat. A client that shows the words can light the ones being said.

14.14 The client sends a crash report (17.20) to the bridge, and the bridge writes it to disk. The agent cannot see the phone, and the file lets it read why the app stopped.

14.14.1 The `crash` message carries one whole report. It has `id`, which is the time of the crash in milliseconds, and `text`, which is the report. The app sends a message smaller than 12,000 bytes, as in 14.11.1. A longer report loses its end, and the text then ends with `[cut]`.

14.14.2 The bridge writes the report to `~/.sidetone/crashes/<id>.txt`. A report that comes again writes the same file again.

14.14.3 The bridge writes one line to the journal for each report: `crash report at` and the file, or that the message is not readable or the file cannot be written. It sends no note (4.3.1).

14.14.4 The bridge does not read the report or act on it. The agent reads the file. The web client does not send the message.

14.15 The app says what it is each time the bridge greets it. On 23 September the bridge heard its own voice, and the record could not say which echo canceller ran, over which audio route, or which of three builds of the app was in the room.

14.15.1 The `device` message carries `model`, the phone's `Build.MODEL`; `aec`, whether the phone has a hardware echo canceller (`AcousticEchoCanceler.isAvailable()`); `canceller`, `hardware` or `software`, which canceller runs (WebRTC's own runs when the phone's is off or missing); `route`, where the bridge's audio plays, with the name of a Bluetooth device and a note of car mode; `apk`, the SHA-256 of the app's own file in hex; `setup`, the audio setup in force, in the names of 18.15.1; and `pushed`, whether the bridge pushed that setup (true) or it is the one in the app's code (false). The app leaves out `apk` when it cannot read the file. The app sends the message once for each `protocol` message (4.3), and at no other time. The bridge sends `protocol` to a client that joins, and at its own start to each client already in the room: a restart of the bridge does not end the phone's room.

14.15.2 The bridge writes one line to the journal: the model, the canceller, the route, the first 12 characters of the build, whether the build is the one the bridge serves now (17.15.1), and the setup with the word `pushed` or `the one in the code`. It writes a `device` event to the record with the same fields and `same`: true, false, or null when either hash is missing. An app from before 18.15 names no setup, and the event then has no `setup` and no `pushed`. A setup with a name the bridge does not know makes the message unreadable. It sends no note (4.3.1). The web client does not send the message.

14.15.3 The app's menu shows the first 12 characters of its build, so Chris can compare it with the journal.

## 15. AUDIBLE STATE

15.1 The bridge does not leave silence when it cannot answer. Silence is ambiguous.

15.2 The bridge plays a gentle audio cue when it is busy, for example when it does a cold start, when it restarts, or when it connects again.

15.3 The audio cue tells Chris that the bridge is still connected, as a telephone hold sound does.

15.4 Different states can have different cues. Chris can then tell the states apart without words.

15.5 The bridge does not play a cue every time Chris waits. The bridge plays a cue only after a set delay. The delay is a setting.

15.6 The audio cue is pleasant and calm. It is a short click, not a musical note.

15.7 The bridge plays hold music when a long turn is running and the room has heard no bridge voice for a set time. A turn is running when Chris has finished speaking and the agent has not returned its result. A turn is long when the agent says so (15.7.4) or when it calls a tool (15.7.5). The time is a setting. The default is 8 seconds. The value 0 turns the hold music off.

15.7.1 The bridge measures the silence from the later of two moments. The first moment is the end of Chris's utterance, when the bridge hands it to the agent. The second moment is the end of the last spoken sentence.

15.7.2 The agent decides ahead of time whether a turn is long, because it knows before it starts whether it will run tools or think hard. The bridge does not guess from the silence that a turn is long. The bridge measures the silence only to place the music inside a long turn. The bridge does not rely on the agent's word alone, since a tool call (15.7.5) settles it on its own.

15.7.3 Chris turns the hold music on and off by voice. He says "music on" or "music off" after the wake word. The bridge answers "Music on." or "Music off." The choice is a setting. The bridge keeps it across restarts. The bridge does not play the hold music while the setting is off. The "Music" button of the app sets the same setting (17.10.3). If Chris turns the music off while a track plays, the track stops. The two commands are not in the default muted set (9.6), because the hold music does not play while the bridge is muted (15.11).

15.7.4 The voice instruction (6.5) tells the agent to start its reply with the marker `[long]` when it expects a slow turn. A reply that starts with the marker makes a long turn. The agent writes no marker when it expects a quick answer, and that turn gets no hold music. The bridge removes the marker before the text reaches the sentence splitter, the voice, the app and the transcript. The marker can arrive split across stream deltas, and the bridge holds the start of the reply until it is certain. Only the very start of the reply counts. The bridge does not remove `[long]` from later in the text.

15.7.5 A reply can start with a tool call and no text, or call a tool after text with no marker in front of it. Either way the tool call itself makes the turn long, marker or not, the moment the tool call starts. This does not depend on the agent writing `[long]`.

15.8 The tracks are the audio files in a folder. The folder is a setting. The default is `~/.sidetone/hold/`. A new track needs no settings edit. The repository does not hold the audio. The bridge lists the folder once, on first use. If the folder is missing or has no tracks, the bridge writes one line to the log and does not try again in that process. A track that the bridge cannot read gets one line in the log, and the next track plays in its place.

15.9 The hold music is quieter than the voice. The gain is a setting. The default is 0.4. The bridge decodes each track once, on its first use. The bridge applies the gain in that decode and keeps the samples in memory.

15.10 The hold music stops when Chris talks, when the bridge has a sentence to say, and when the turn ends. The stop for Chris talking and for a sentence is the stop of the /play route.

15.10.1 The hold music plays one track once for each silent stretch. It does not loop. When a sentence plays and the turn still runs, a new silent stretch starts. The new stretch plays the next track in file-name order. After the last track, the first track plays. A track that was stopped starts again two seconds before where it stopped. A track that played to its end starts again from the start. The bridge keeps these positions in memory only, so a restart starts every track from the start.

15.10.2 When a sentence stops the hold music, the track fades out. Its level falls in a straight line to zero. The sentence starts when the fade ends. The fade time is a setting. The default is 300 milliseconds. The value 0 cuts the track at once.

15.10.3 Chris talking, the audio going off (11.12), the music going off (15.7.3) and the end of the turn cut the track at once. They do not fade it.

15.11 The hold music does not play when no turn is running, when the turn is not long (15.7.4), when the bridge is muted, when the audio is off (11.12), or when a track from the /play route is playing. It does not play while the bridge waits for the agreement word, because the bridge has asked Chris a question (8.6.3, 10.1).

15.12 The /play route hands the file to the mouth, which owns the room's one audio source. The track waits until nothing is being said, then plays. A sentence that arrives while it plays fades it out (15.10.2). Chris talking and the audio going off cut it at once (15.10.3). The route answers 202 as soon as the file is decoded, so the agent can ask for a track and say a sentence about it in the same turn. Before this the route wrote to the transport itself and refused, or stopped, whenever the mouth was busy, and the agent's own next sentence ended the track one second in.

15.13 The record says when a track started and when it stopped, for the hold music and for a file from /play, with how long it ran and whether it reached its end. Without those the record said nothing about when the music began, and "it came on late" (see docs/todo.md item 17) could not be checked after a drive.
15.14 The bridge plays a cue when Chris presses the hold to talk button (9.5.1), and a different cue when he lets go (9.5.2). The press cue is one bright click. The release cue is one dark click. Both are half as long and half as loud as the other cues, because they play on every hold. The app sends the `mic` message with `hold` set when a press opens the microphone, and with `release` set when a release cuts it (9.5.2). A cut or an open from the button that cuts the microphone plays no cue. The two cues follow the same rules as the other cues: they are not played over the voice, and the tones setting turns them off (15.4).

15.15 The bridge plays a cue when it has finished speaking. A pause between two sentences of one answer sounds the same as the end of the answer, and Chris could not tell when it was safe to talk. The cue is two clicks, dark then bright: the thinking cue backwards, so the start and the end of the agent's speaking are one figure, down and then up. It is half as long and half as loud as the thinking cue, because it plays at the end of every answer. The three-click cue for a process that restarts stays as it is; the count keeps the two apart.

15.15.1 The cue plays when the last sentence has finished playing, not when the bridge has finished sending it. Its frames go onto the room's one audio source behind the sentence's frames, so the phone plays the click straight after the last word. The bridge plays it only when nothing more is coming: the agent has returned its result, the last sentence has reached the voice, and the voice has said it. It never plays between the sentences of one answer, and a sentence a barge-in holds (11.3) is still to come, so the cue waits for it.

15.15.2 It plays after every answer that spoke, a report the agent began unasked included (11.11). An answer with no spoken sentence gets nothing. It plays after the rest of an answer that "carry on" says (11.10), because that rest is the end of the answer's speech. It plays after "Stopped." when "end the turn" stops an answer that had spoken. It does not play for an answer that a new question cut short (11.9): the question owns the voice then, and a cue would sound like part of the answer to it. The tones setting turns it off with the others (15.4).

## 16. LESSONS FROM PRIOR ART

16.1 Other projects do voice for the Claude command-line tool. The nearest is claude-voice, which does speech-to-text, then the Claude command-line tool, then text-to-speech, with barge-in and a phone client. The telephony project claude-phone is the call-based method that this product does not use. Other projects are Happy Coder, Paseo, VoiceMode, and Voicebox. Learn from these projects. Read their code for the plumbing. Do not adopt one as the product. None of them do the gating, the wake commands, the car resilience, or the aleph memory split that this product needs.

16.2 Claude Code does expose the context to an outside tool, measured against version 2.1.267. The `autocompact_state` event gives the window size and the compaction threshold, and the result of each turn gives the input, output, cache-read and cache-creation tokens. The earlier revisions of this document said the opposite and called for an estimate. The estimate is not needed. Confirm this again after a Claude Code upgrade, because it is not a promised interface.

16.6 Claude Code also reports the rate-limit use directly, in a `rate_limit_event` with the five-hour and seven-day numbers. The usage command of 9.4.4 and the warning of 13.2 read these numbers. They do not estimate.

16.7 Claude Code refuses `--output-format stream-json` unless `--verbose` is also given.

16.3 Auto-compaction can thrash. The context can refill at once after a compaction, and the loop repeats. This is the reason for the compaction-loop detector in 8.5.

16.4 Some versions of Claude Code have a memory leak that grows without limit and can use all the memory of the machine. This is the reason for the process-memory recycle in 8.7.

16.5 The metric that matters for speed is the time to the first audio, measured from the phone. The backend completion time is not the right metric. There is no portable number. Set a target from the real setup (see Section 18).

## 17. THE ANDROID APP

17.1 The app is private. Chris installs the app by side-load. Chris does not publish the app.

17.2 The app supports screen-off voice. The app uses a foreground service.

17.3 The app uses the LiveKit Android SDK. The transport and the echo cancellation are the same as the web client.

17.4 The echo cancellation on native Android can behave differently than in the browser, because the browser ships its own tuned cancellation. Test the barge-in quality in the car with the app, because this is the hardest setup to predict.

17.5 Lock-screen controls are a nice-to-have. The decision waits until the design of the app in 7.5. Do not decide this before that point.

17.6 A web page cannot keep the microphone open when the screen is locked. This is the reason for the app.

17.7 The app is the final method that removes the screen-on limit from 2.4.

17.8 The app shows one bubble for each block of an answer (14.9). The text grows word by word in the bubble, as the `delta` messages arrive. The app shows no bubble until its first word arrives.

17.9 Each bubble shows a clock time: hours and minutes, on the 24-hour clock, in the time zone of the phone. A note shows no time.

17.9.1 The time of a live bubble is the time the phone got its first message. The words that follow do not change it. A bubble from the history (14.8) shows the time that the bridge kept it. For an answer, this is the end of the turn.

17.10 The app has one row of three buttons: "Mic", "Audio" and "Music". "Mic" cuts the microphone (9.5), "Audio" cuts the audio (11.12), and "Music" turns the hold music off (15.7.3). Each button keeps its label. Its color shows the state: tonal while the thing is on, and the error container while it is cut.

17.10.1 On the tap of "Audio", the app sends the `voice` message (11.12). The bridge stops the sentence in flight and the hold music at once (11.12.2).

17.10.2 The app records each change as an event in the screen log, "audio off" or "audio on", "music off" or "music on", and adds no note (4.3.1).

17.10.3 On the tap of "Music", the app sends the `music` message with `on` set to false or to true. The bridge sets the setting of 15.7.3 and keeps it across restarts. It gives no answer. A track that plays stops at once (15.10.3). The app starts with the music on. An app that has the music off sends the message again when it joins the room. The bridge does not tell the app the setting, so "music off" by voice does not change the button.

17.11 The app shows a working sign in its status row, as the motion of the status dot (17.11.6). The sign says that the agent works (14.10). It has three states.

17.11.1 Off. The sign shows nothing. This is the state before any `working` message, after a message with `on` set to false, and after the app leaves the room.

17.11.2 Working. The dot pulses slowly. The sign adds no word to the row. This is the state after a message with `on` set to true, while a `working` message arrives at least every 15 seconds.

17.11.3 Stalled. The bridge said that the agent works, and no `working` message has arrived for 15 seconds. The dot blinks fast. The sign adds no word to the row. This is three heartbeats (14.10.2). It means that the bridge has stopped sending. The room is live when the sign shows (17.11.6), so the bridge is stuck. The next message ends this state. The 15 seconds is a constant of the app, because the app has no settings file.

17.11.4 The sign follows the messages of the bridge. It does not follow the sound. It shows with the audio cut (17.10), when the voice, the tones and the hold music give no sign of the work.

17.11.5 The app has no setting for the sign.

17.11.6 The status row shows one state, not three readings that can disagree. The row is one dot. The colour of the dot is the room state: green while the status is "listening", amber while the app connects, rejoins or reconnects, red when the bridge is unreachable, and grey while Chris is out of the room by his own hand (17.11.10). A ring around the dot is the connection quality: thick when excellent, thinner when good, thin when poor, and no ring when the quality is not known. The motion of the dot is the working sign (17.11). The ring and the sign show only while the status word is "listening". In any other state no message can come, and the row shows no ring and no sign. The notification (17.16) follows the same rule for the sign. When the status is "listening" and LiveKit says the connection of the phone is lost, the room is not live: the status word is "signal lost", and the row shows no ring and no sign. One function in the app gives this reading, and a test tries every input.

17.11.7 The row shows the status word beside the dot in every state: "connecting", "listening", "rejoining", "reconnecting", "signal lost", "disconnected" or "left". The colour alone does not say which amber state the room is in. Until 23 September the row showed a word only for "reconnecting", "disconnected" and "signal lost". These states last seconds, so Chris never saw a word. The notification (17.16) starts with the same word.

17.11.8 The "Leave" button is not in the row. It is in the options menu (17.22), which opens from the gear at the end of the row. It leaves the room and keeps the app open (17.11.10). Until 24 September it quit the app; "Quit" does that now (17.22.4).

17.11.9 A tap on the dot opens a legend. The legend lists each word the row can show, with the colour of the dot and what the state means. Below them it says what the ring and the motion mean. A tap anywhere closes it. The app makes the legend from the same function as the row (17.11.6), and a test checks that each state is in it.

17.11.10 Chris can leave the room and keep the app open. While the app is in the room the phone is in a call, as far as the car is concerned (4.2.2), and the car parks its own music for the whole call. The echo canceller needs the call mode, so the app does not change the mode. Chris leaves the room to listen to music and rejoins when he wants to talk.

17.11.10.1 "Leave" in the options menu (17.22) leaves the room. The app stays open and in front. The transcript stays on the screen as history: no line grows and no line comes. The dot is grey and the word is "left". No ring and no sign show, as in every state that is not "listening". The legend has the state. The notification of 17.16 goes, because no room holds the microphone.

17.11.10.2 A leave releases the phone's audio, so the car stops treating the phone as being in a call and its music comes back. The app ends its session: the room ends, LiveKit disposes the microphone track with the room, its audio handler gives back the audio mode and the audio focus, and the app clears the communication device it picked when the setup asked for no focus (4.2.2.1). This is the path a quit and a swipe away take, which the drive of 18 September checked: the bridge writes `[the room lost a microphone track]`. Only the car shows that its music comes back.

17.11.10.3 A "Rejoin" button takes the place and the size of the hold to talk button (9.5.1) while the app is out of the room, because out of the room there is no one to talk to, and that button is the one his thumb already reaches for. One tap joins the room again with the pairing the app has: no code to scan and no new pairing. The row says "connecting" until the room is up. The bridge greets the app as it greets any client that joins (4.3), and the app answers with `device` (14.15). The microphone opens again if it was open. The app does not join by itself while it is left, even when the screen is built again.

17.11.10.4 The bridge needs no change. To the bridge a phone that left is a phone in a tunnel (14.8): the conversation carries on. A turn that runs when Chris leaves runs to its end: the agent finishes, the voice speaks to a room with no one in it, and the bridge keeps the turn (14.8). After 30 seconds with no frames the bridge writes the line of 18.9.2 once and sends a `rejoin` that no phone gets. The `mic` message of 9.5 is not sent, so what the microphone had half recorded stays in the bridge's ear until the next sound, as after a drop.

17.11.10.5 The bridge sends the history when the app rejoins. The app keeps the lines it has and shows the history once for each conversation, so a room that opens again inside one conversation does not show it a second time. This is the rule the app has for a drop. The words of a turn that ended while the app was out do not reach the screen until a later change shows only the turns the app missed; "restate" (14.6) says them again by voice.

17.12 The app keeps a screen log: what it showed, in the order it showed it. Each change of a line on the screen is one entry. The log is in the memory of the app process. It ends when Chris quits the app (17.22.4). A leave (17.11.10) keeps it, as it keeps the lines, and the leave and the rejoin are two events in it (4.3.1).

17.12.1 An entry has these fields:

| Field | Meaning |
| --- | --- |
| `at` | The time the message arrived, in milliseconds since 1970. |
| `time` | The same time on the 24-hour clock of the phone, with seconds and milliseconds. |
| `kind` | What arrived: `heard` (Chris said it), `sentence`, `turn`, `block` (a block starts), `delta` (words of a block), `note` (a note from the bridge or from the app), `history`, `unknown`, or `working` (the sign changed). |
| `answer`, `block` | The numbers the message named (14.9.3), or null. |
| `bubble` | The place of the line in the transcript, from 0. It counts every line, notes and hidden bubbles too. It is null when no line changed. |
| `got` | The text the message carried, or null. |
| `text` | The exact text of that line on the screen after the change, trimmed as the screen trims it. It is empty while the bubble is hidden (17.8). For `working`, it is the words of the sign. |
| `from` | Only when `text` was cut: the number of characters cut from its front. |

17.12.2 A message that changes more than one line, such as the history, gives one entry for each line. A message that changes no line gives one entry with no bubble. A sentence that a bubble already holds (14.9.5) is such a message. The app writes no entry for the end of a block, for the `protocol` or `apk` message, or for a `working` message that does not change the sign.

17.12.3 The log has a cap. It holds at most 500 entries and 200,000 characters of text. When it is over the cap, the app drops the oldest entries first. It always keeps the newest entry. One entry keeps at most 4,000 characters of `text`. A longer text keeps its last 4,000 characters.

17.13 The app sends its screen log to the bridge by itself (14.11). It has no button for it.

17.14 Chris can select the words of any bubble or note in the transcript, and copy them. A long press starts the selection. The copy gives the plain words, without the clock time. The typing box accepts a paste.

17.15 The app updates itself from the bridge. The bridge serves the app at `/sidetone.apk` (17).

17.15.1 The `protocol` message (4.3) carries an `apk` field when the bridge has an app to serve. The field holds `url`, the address of the app, and `sha256`, the SHA-256 of the file in hex. The bridge computes the hash again when the file changes.

17.15.2 The app computes the SHA-256 of its own installed file once for each process. When the two hashes differ, the app shows the button "Update the app" under the status row. When they are the same, or the field is missing, the app shows no button. The app uses no version number.

17.15.3 On the tap, the button reads "Downloading the update…". The app downloads the file into a system install session. Android then asks Chris to confirm. The first time, Android also asks Chris to allow installs from the app. Google Play Protect can ask for a scan of an app it has not seen. "Install without scanning" continues the update.

17.15.4 A cancel or a failure adds a note to the transcript, and the button is available again. A success replaces the app and ends its process. Chris opens the app again.

17.15.5 A build can end while the app is in the room. The bridge looks at the file every 2 seconds. When the hash changes, and two looks in a row agree, the bridge sends the `apk` message to every client in the room. The message holds only the `apk` field of 17.15.1. The two looks keep the bridge from offering a file that a build still writes.

17.15.6 The app accepts the `apk` message at any time and compares the hashes as 17.15.2 says. A new hash shows the button, and a hash equal to its own removes an old button. The message changes nothing else in the app, and the page ignores it.

17.16 The notification of the foreground service (17.2) shows the state of the conversation and three buttons. It shows on the lock screen.

17.16.1 The text is the status word, then what is cut, then the working sign (17.11), joined by " · ". An example is "listening · mic off · working".

17.16.2 The buttons are "Mic off" or "Mic on", "Audio off" or "Audio on", and "End turn". Each does what the same control in the app does (9.5, 17.10, 9.4.8). "End turn" shows only while the app is in the room.

17.16.3 The channel has default importance, with no sound and no vibration, so that the phone does not hide it as a silent notification. The notification alerts only once. It stays for as long as the app is in the room. A leave (17.11.10) takes it, because no room holds the microphone.

17.17 The app posts an alerting notification for two events, while the app is not on the screen. A tap opens the app and clears the notification.

17.17.1 A line that the bridge queued to say. A `/say` request (14.10.4) also sends the line to the client as a `narration` with `announce` set to true. The app shows it as a note, and notifies it. The end of a detached job is such a line.

17.17.2 A reply that the voice did not play, because the audio is cut (17.10). The notification holds the words of the reply.

17.18 The app sends a screenshot to the bridge (14.12) when Chris takes one while the app is on the screen. Chris uses the system screenshot, with the power and volume-down keys. The app has no button for it.

17.18.1 The system tells the app that a screenshot was taken of it, with `registerScreenCaptureCallback`. The system does not give the image. The app then reads the newest image in a `Screenshots` directory of the phone's images. It accepts only an image added at most 2 seconds before the system told it. The system can write the image late, so the app looks again every 500 ms, at most 10 times.

17.18.2 The app makes the image smaller before it sends it. The longest edge is at most 1,080 pixels, and the JPEG quality is 70. A smaller image keeps its size.

17.18.3 The app needs the permission to read images, READ_MEDIA_IMAGES. It asks for it with the other permissions when it opens. When Chris refuses it, or gives access to selected photos only, the app sends no screenshot and says nothing. Android stops the question after the second refusal.

17.18.4 The app sends the image only while it is in the room. It does not keep an image for a later room.

17.18.5 When the bridge says that a screenshot is pending (14.12.7), the app shows its thumbnail in the transcript, on Chris's side, with the mark "attached to your next message". A tap on a pending thumbnail drops it, and the thumbnail goes from the transcript when the bridge says that it is dropped. When a turn takes it, the mark goes and the thumbnail stays. When it expires, the mark says that it was not sent.

17.19 The app formats the markdown in the bubbles of the agent. The bubbles of Chris and the notes stay as plain words.

17.19.1 The app formats only what the agent writes. Code and a fence show in a fixed-width font on a background of a different color. Bold, italic and a heading show in bold or italic. A list keeps its number, or shows a bullet. A table shows each row on one line, with its cells between bars. A quote shows in italic. The app removes the markers.

17.19.2 A link opens on a tap. A link is a named link, a bare address, or an address in code.

17.19.3 A marker with no partner shows as text. A bubble grows word by word (14.9.2), so a marker can wait for its partner.

17.19.4 Selection (17.14) works on the formatted words. The copy gives the words as they show, without the markers.

17.20 The app writes a crash report when an error that nothing catches ends it, and sends the report to the bridge (14.14) in the next room.

17.20.1 The report holds the time, the thread, the stack trace and the app state, in that order. The state gives the number of lines in the transcript, not their words. The app writes the report to its own storage, one file for each crash, and then lets the crash go on.

17.20.2 The app sends each report after it connects to the room, oldest first. It deletes a report when the send succeeds. A report that fails stays for the next room.

17.20.3 The report catches only an error in the app's own code. A crash in native code and a freeze of the screen (an ANR) give no report.

17.21 The app follows the voice in the bubbles of the agent. The unit is the spoken sentence: the sentence that the last `speaking` message (14.13) names.

17.21.1 The bubble that holds the spoken sentence shows the words up to its end at full weight. The words after it are grey. The other bubbles show all their words at full weight.

17.21.2 The app finds the spoken sentence in the newest bubble of the agent that holds its words. A sentence that no bubble holds, such as a reply from the bridge during a hold, does not move the spoken sentence. Before the first `speaking` message the app greys nothing.

17.21.3 A `turn` does not move the spoken sentence, because the voice can still say the answer after it arrives. A barge-in cuts a sentence and the bridge says it again (14.13), so the grey stays after the cut until that message repeats.

17.21.4 The formatting of 17.19 stays. The grey starts at the length of the words up to the end of the sentence, once formatted. A sentence that ends inside a bold or code span can show a slightly wrong edge.
17.22 The options menu opens from the gear at the end of the status row. Its accessibility name is "Options". It holds the verbosity, the tones, the hold music volume, the barge-in level, the quietest speech peak, the end-of-turn pause, "Leave", "Quit" and the build line (14.15), in that order. "Leave" shows only while the app is in the room. The voice choice and the audio switch are not in it, because each already has a command or a button.

17.22.1 Each control sends the `setting` message (9.4.9). The bridge does what the spoken command does, the voice's answer included. The control does not change when it is tapped. It shows the value in the next `settings` message, so the menu shows only what the bridge holds. Until the bridge sends its settings, each control is disabled.

17.22.2 The verbosity is a selector of three: brief, normal and full (9.4.10). The tones are a switch (15.4).

17.22.3 The hold music volume is a slider from 0 to 1. It sets `holdMusicGain` (15.9), and no spoken command sets it. The slider sends one message when the finger lifts. The bridge gives no answer and keeps the value across restarts. The next track plays at the new volume. A track that plays keeps the old volume until it stops. The bridge ignores a value outside 0 to 1.

17.22.4 "Leave" leaves the room and keeps the app open (17.11.10). "Quit" leaves the room, ends the conversation and closes the app: the transcript and the screen log go, and the next open of the app joins the room afresh. A swipe away is a quit.

17.22.5 The barge-in level and the quietest speech peak are sliders, like the volume, with the bridge's value in the label. They set `bargeInLevel` (11.3) and `minSpeechPeak` (4.6), and no spoken command sets either. The barge-in slider runs from 0 to 0.2 and the peak slider from 0 to 0.5, as fractions of full scale; each sends once when the finger lifts, rounded to two places. The bridge checks a value by the rule it checks the settings file by, so a value it takes live loads at the next start: each must be louder than the level that counts as speech. The bridge gives no answer, keeps a taken value across restarts, and the ear reads it on the next frame, so the next utterance is judged by it. A refused value is not kept. The bridge writes the refusal to the journal and sends its settings again, and the slider goes back to what the bridge holds, so the menu never shows a value the bridge does not have.

17.22.6 The end-of-turn pause is two buttons and the bridge's value between them, not a slider, because a pause is tried a step at a time. Each tap sends `endOfTurnPauseMs` (11.5) moved by 100 milliseconds. The buttons stop at 0.5 and 3 seconds. The bridge refuses a pause that the early transcription (18.4) would outrun, and otherwise takes it as 17.22.5 takes a level.

## 18. MEASUREMENTS TO MAKE

18.1 No measurement blocks the build. Make each measurement during the build. Change a setting from Section 21 with the result.

18.2 Measure the end-of-turn detection time. Measure this time separately from the round-trip time. The result sets the pause length in 11.5.

18.3 The round-trip time is the network time plus the generation time.

18.4 Measure the time to the first audio from the phone. Record a middle value and a high value across many turns.

18.5 The speed numbers in the earlier plan came from a different machine, a cloud sandbox, a small model, and a one-line prompt. The numbers are the right shape but they are not a promise. Confirm the speed numbers on Chris's machine.

18.6 Confirm what a phone microphone can do in a moving car with the screen on. This measurement comes at 7.4, because the web client is the first client either way. If the result is bad, move the app of 7.5 forward.

18.7 Watch the memory size of the Claude Code process over a long session. This confirms the recycle limit in 8.7.

18.8 Test the wake word in live use. Do not test the wake word before the build. If "sidetone" collides with normal conversation, change the setting in Section 21.

18.9 The phone can publish a microphone track that carries no sound, and only the phone can renew the track. The app renews it by leaving the room and joining again.

18.9.1 The bridge finds the fault when the track carries no sound for 30 seconds. It also finds the fault when no audio arrives for 30 seconds though the phone says its microphone is open.

18.9.2 When the bridge first finds the fault, it sends the phone one `rejoin` message. It sends no second message until the microphone has carried sound again. The bridge writes the fault to the journal and sends no note (4.3.1). The app shows the rejoin in its status row: the dot is amber and the word beside it is "rejoining" (17.11.7) until the app is in the room again.

18.9.3 The app leaves the room and joins it again when it gets the message. It opens the microphone again if the microphone was open.

18.9.4 The app rejoins at most once in 30 seconds. It ignores a message inside that time, so a phone that stays silent cannot make a loop. The 30 seconds is a constant of the app, because the app has no settings file.

18.9.5 The bridge writes one line to the journal each time it sends the message. The line says that the bridge asked. It does not say that the phone agreed.

18.9.6 The web client ignores the message. The page has no rule to renew its own track.

18.10 The bridge writes down when it hears its own voice. An utterance that repeats what the voice has just said is almost always the room rather than Chris: the phone's echo canceller let the speaker through. The bridge compares each utterance against the last few sentences it started, whole or cut. An utterance of fewer than four words is never an echo, because the bridge and Chris say the same short words. An utterance that shares at least seven words in ten with a recent sentence is one. So is an utterance whose letters come at least 0.8 close to some stretch of a recent sentence, because a garbled transcription splits and joins words.

18.10.1 The bridge records the echo and writes it to the journal. It drops the utterance only when the utterance began while the voice played or within 1 s after it stopped, and the utterance is not a command. A dropped echo takes the path of an utterance with no words, so a held passage resumes, and the journal names the utterance and the sentence it matched. An echo at another time is only recorded, because Chris may read a sentence back. The scorecard counts the echoes of a drive.

18.10.3 One utterance may cover a run of sentences. The ear ends an utterance on a pause, and a passage played into a room has none the microphone hears, so a run of sentences comes back as one line and no single sentence holds seven words in ten of it. The bridge therefore compares the utterance with the run of recent sentences joined, as well as with each one. The car of 23 September brought back four sentences at once, and the echo check called it somebody talking.

18.10.2 This exists because of the volume slider of 21 September, which was never wrong in the barge-in logic: it made the phone play loudly enough to defeat its own echo cancellation, and the bridge barged in on itself. Nothing in the code could see it, and a drive is what found it. An echo in the record is the first minute of a device run finding it instead.

18.11 The scorecard counts the utterances the room made rather than Chris: a filler, or one of the engine's own silence tokens, with nothing else in it. Measured over two hours in a coffee shop on 22 September: of 503 utterances heard, 74 carried any words, 63 of those were three words or fewer, and 70 turns were taken. "Thank you." alone appeared 22 times. Neither existing guard saw any of it. The peaks ran from 0.16 to 0.53, well above the 0.15 speech floor, and the invented count is relative to the session's own median, which a noisy session raises. The words are what separate them, so the count is by words.

18.11.1 The count is a measurement and not a gate. The bridge still sends every utterance to the agent. Whether to stop a short filler reaching the agent at all is a separate decision, and this number is what it should be decided on.

18.12 The scorecard says how hold music actually behaved: of the turns whose agent time passed `holdMusicAfterMs`, how many played a track. Hold music shipped on 21 September and was dead for a day while 25 tests passed over it, because the tests encoded the rule about which turns are long and the rule was wrong about real turns. No unit test finds that; this does, from the record.

18.12.1 The count starts at the first track the window recorded, because a track has only been written down since 22 September and an older record cannot tell "no music played" from "this build did not say". A window with no track at all reads as not recorded rather than as a fault. The cost is a blind spot, and it is the right way round: a card that raises a false alarm every hour is a card nobody reads.

18.13 The echo check tells whether the phone's echo canceller holds, on the phone. The bridge says a passage into the room at its full level while nobody talks, and the record shows whether the microphone brought any of it back: an utterance that echoes the passage (18.10), a sentence that a barge-in cut short, or a barge-in with nobody talking. Each one fails the check. Somebody who talks makes the check unable to tell. `bun scripts/echo-check.ts` runs it.

18.13.1 The app keeps the audio setup that last passed the echo check beside the one it runs with. A unit test fails when the two differ, and when any file but the one that holds the setup changes the audio path: a gain on a track, the audio mode, focus, routing or a player of its own. So a change like the volume slider of 21 September fails a test before it ships, and passes only after the check has run on the phone with it installed. The two setups are the ones written in the code, which is what ships. A setup the bridge pushes (18.15) is not held to this test: it is an experiment, and the `device` message and the record always name it.

18.13.2 The check refuses to run without a microphone in the room, and fails to tell when the phone cuts its microphone while the passage plays. A cut microphone brings nothing back, so every other reading of the record says the room stayed quiet. On 23 September a check passed that way, fourteen seconds after the phone cut its microphone. `/health` therefore says `microphone`, `open` or `cut`, from the room's tracks.

18.13.3 The check reads how long since the microphone carried any sound, and cannot tell when that is longer than the passage. An open track that carries nothing brings nothing back, exactly like a room that stayed quiet. On 23 September a check passed while the capture had been dead for 39 seconds (18.9). `/health` therefore says `soundMs`, from the ear.

18.14 The bridge keeps a copy of each clip it sends to the room, so the agent can check the sound. The agent cannot hear its own voice, and the record holds the text and the timings, not the sound. On 23 September three reports of garbled speech could not be checked for this reason.

18.14.1 The bridge keeps the last 100 clips under `~/.sidetone/sent/`, and deletes the oldest first. Each clip has the text it was made from, the time, and its source: a kept reply played from disk (11.6.1), or a clip the engine made for this sentence. A clip is two to five seconds, so 100 clips use about 20 MB and hold the last five answers or more. The copy stores speech, so a setting turns it off. The copy is on while the reports of 23 September are open.

18.14.2 `bun scripts/sent-check.ts` lists the clips. Given a clip's number, or a wav and its text, it transcribes the clip with the speech worker and compares the words with the text. It gives the likeness of 18.10 in both directions and takes the lower value. The likeness of the text in the transcription finds a lost sound. The likeness of the transcription in the text finds a repeat or an added sound. A value below 0.8 marks the clip as garbled. The check also gives the length, the sample rate, the channel count and the peak.

18.14.3 The copy is taken in the bridge. A fault that starts later, in the network, the room or the phone's decoder, does not show in it. If the copy is clean and Chris hears garbled speech, the fault is after the bridge.

18.15 The bridge changes the phone's audio setup without a build. On 23 September one boolean, the echo canceller, cost three app builds and two hours. Every echo experiment changes the setup of 4.2.2 and measures it in a car, so the setup changes from the bridge, and the record always says which setup ran (14.15). `bun scripts/audio-setup.ts` does it.

18.15.1 The `setup` message goes from the bridge to the app. It carries the setup in names, so no Android constant crosses the wire: `mode`, `call` or `normal`; `output`, `voice` or `media`, which is how the bridge's audio plays (the usage, the content type and the stream go together); `focus`, `gain` or `none`; `canceller`, `hardware` or `software`, which canceller is asked for; `noiseSuppression` and `autoGainControl`, true or false; and `default`, false. The app maps each name to its constant in the one place of 4.2.2. The capture source is not in the message: `VOICE_COMMUNICATION` is the only source Android cancels echo on, so it never changes, and echo cancellation is always on.

18.15.2 A `setup` message with `default` true carries no other field. It clears the stored setup, and the app runs with the setup in its code again.

18.15.3 The app keeps the pushed setup in its own storage, so it survives an app restart and a setup under test survives a drive. The app applies a setup by leaving the room and joining it again at once, as it does for 18.9, because LiveKit builds the audio path at join. The status row says "rejoining" until the app is in the room again. The limit of 18.9.4 does not hold a push: a push is one message from a script, not a silent phone. The app writes the setup, or the return to the code's own, to its screen log as an event (4.3.1). A setup with a name the app does not map is refused, written to the screen log, and changes nothing.

18.15.4 The app says which setup it runs with, and whether the bridge pushed it, in each `device` message (14.15.1). So the journal, the record and the echo check (18.13) always name what ran. A stored setup the app cannot read, such as one an older app wrote, is no setup: the app runs with the setup in its code and says so.

18.15.5 The bridge sends the message from `POST /setup`, which a shell on this machine reaches and the tailnet does not (12.1). It writes one line to the journal, and a `setup` event to the record with `pushed`: the six names, or null for a return to the code's own. It sends no note. The bridge keeps no setup of its own: the app is the store, and a phone that joins later runs with what it kept.

18.15.6 `bun scripts/audio-setup.ts` with no argument prints the setup the phone last reported, from the record. With `--mode`, `--output`, `--focus` and `--canceller`, and `--noise-suppression` or `--auto-gain-control` `off` (each is on unless said), it pushes one. With `--default` it sends the phone back to the setup in its code. It refuses when no bridge answers, when the bridge has no room, or when the phone is not in the room. After a push it waits for the phone to rejoin and report, and fails when the phone does not report in 45 seconds, names no setup, or names another one.

18.15.7 A pushed setup is an experiment. `Audio.checked` and the test of 18.13.1 hold the setup written in the code, which is what ships, and a pushed setup does not touch it. This is safe because a pushed setup is always named in the `device` message and the record. A setup that is to ship goes into the code, and passes the echo check there. The web client ignores the message.

## 19. POINT STATUS

19.1 Muted command subset. Mute, unmute, and the two commands that turn the tones on and off. The set is a list in the settings, so Chris adds more later. The tone commands are on it because Chris mutes when the car is loud, and the tones are the next noise he wants gone; silencing them asks nothing of the microphone. See 9.5 and 9.6.

19.2 Default model. Sonnet. This is final. The model stays a setting. See 8.11.

19.3 Lock-screen controls. Deferred to the design of the app. See 17.5.

19.4 Turn limit. Two separate limits, not one. The silence limit is one minute of no output on any channel; a busy turn does not trip it. The hard ceiling is a separate limit on turn length, set at ten minutes, and it escalates: it speaks and asks, then interrupts the turn, then restarts the process only if the interrupt does not work. See 8.4 and 8.6.

19.5 Text-to-speech voice. Take the first working local voice. Do not wait for a decision. The engine is replaceable and the voice is a setting, but each replacement is also local: the voice path is local only, with no cloud engine and no cloud fallback. See 4.5 and 4.8.

19.6 Wake word. "sidetone". Test it in live use, not in a separate test before the build. See 18.8.

## 20. TWO CHEAP TESTS BEFORE THE BUILD

20.1 The first test takes one minute. In a plain chat on the phone, not inside a project, ask what is in the memory about the Claude Code setup. If the chat reads back a real file, then the memory of Claude already works across surfaces. This test passed.

20.2 The second test takes two hours at the desk. Install a desktop voice tool. Hold a real spoken conversation with Claude Code. This shows how bad read-aloud code is. This shapes the instruction that stops it.

## 21. CONFIGURATION

21.1 The bridge reads one settings file. The bridge does not need a rebuild for a change to a setting.

21.2 Each setting has the default that follows. A default is a start value, not a fixed value.

| Setting | Default | Section |
| --- | --- | --- |
| Silence time before a restart | 1 minute | 8.4.3 |
| Hard ceiling for a turn | 10 minutes | 8.6.9 |
| Checkpoint window at the ceiling | 15 seconds | 8.6.9 |
| Grace time before a restart | 30 seconds | 8.6.9 |
| Compaction-loop limit | 3 messages | 8.5.2 |
| Compaction-loop window | 5 minutes | 8.5.2 |
| Process-memory recycle limit | 4 gigabytes | 8.7.2 |
| Context warning level | soft, then on compaction | 8.9 |
| Claude Code command and flags | `claude -p --verbose`, stream-json both ways | 16.7 |
| Model | Sonnet | 8.11 |
| Wake word | "sidetone" | 9.2 |
| Commands that work when muted | mute, unmute | 9.5 |
| Agreement word | "continue" | 10.2 |
| Gated action list | to set at 7.2 | 10.1 |
| End-of-turn pause | 1.5 seconds | 11.5 |
| A question mid-answer | holds and refuses; interrupting is the other way | 11.9 |
| Wait before insisting on an interrupt | 5 seconds | 11.9.1 |
| Usage warning level | 80 percent of the reported rate limit | 13.2 |
| Audio cue delay | 4 seconds, then every 6 seconds | 15.5 |
| Hold music: silence before it plays, in a long turn | 8 seconds, 0 turns it off | 15.7 |
| Hold music: on or off | on; "music on" and "music off" change it | 15.7.3 |
| Hold music: tracks | every audio file in `~/.sidetone/hold/` | 15.8 |
| Hold music: gain | 0.4 | 15.9 |
| Hold music: fade out | 300 milliseconds, 0 cuts at once | 15.10.2 |
| GPU budget for the voice path | 8 gigabytes, the whole GPU | 4.10 |
| Speech-to-text engine and model | faster-whisper, `small.en`, local only | 4.6 |
| Text-to-speech engine and voice | piper, `en_US-lessac-medium`, local only | 4.9 |
| Project directory list | none, any directory | 6.1 |
| Wake word forms the engine also writes | "side tone", "sigh tone", "sight tone", "cytone", "sitone", "site on", "side don't" | 9.3 |
| Speech onset before recording starts | 50 milliseconds | 11.5 |
| Level that counts as speech | 2 percent | 11.5 |
| Settle time before listening again | 300 milliseconds | 11.2 |
| Longest run of text spoken as one piece | 240 characters | 5.6 |
| Narration delay | 5 seconds | 2.3 |
| Keep a copy of each clip sent | on, the last 100, in `~/.sidetone/sent/` | 18.14 |
| Takes of a fixed reply before warm gives up | 100, alone and again in the carrier | 11.6.1 |

21.3 A setting with the value "to set at" gets its first value at the build step named. The builder does not wait for this value before that step. The three such settings got their first values at 7.3.

21.4 A new setting follows the same rule. A value that a builder wants to change during a test is a setting, not a constant.
