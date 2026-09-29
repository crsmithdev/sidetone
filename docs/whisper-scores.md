# Whisper scores on Chris's voice

Test 17 in [`testing.md`](testing.md), scored 29 September 2026 on the card
Chris read that morning (10:16 to 10:23). `scripts/score-models.ts` makes
every number here. The clips stay in `~/.sidetone/heard/`; this page holds
only the texts the models wrote.

## Result

| Question | Answer |
|---|---|
| Hears Chris best | **medium.en**: 5.3% word error rate, 34 of 45 lines exact, against 8.2% and 28 for small.en |
| Best trade of accuracy against latency | **medium.en**: 35% fewer word errors than small.en for 82 ms more at the median (207 ms against 125 ms) and 1.3 GB more GPU memory |
| Worse than medium.en | every other model. large-v3, large-v3-turbo and distil-large-v3 and v3.5 are also slower |
| The vocabulary prompt | lowers the error rate of every model but distil-small.en and distil-medium.en: by about half for small.en, medium.en, large-v3 and large-v3-turbo. Keep it |
| Could not run | none. distil-medium.en ran, but with the bridge's prompt it wrote nothing, or a word or two, for every clip. Without the prompt it scores 20.1% |
| How sure | one sitting, 45 clips, 378 words. medium.en made 20 word errors, small.en 31 and large-v3 29. Where the card was read, the car or the desk, is not in the journal |

## How it was run

| Step | What |
|---|---|
| Labels | the journal line `[the card, round R, line L, ...]` of the last full run. A clip takes the label of the first journal line after it; when two or more clips come before one line, the last one takes it |
| Clips scored | 45: three rounds of the 15 lines |
| Clips not scored | 4 in the run that another clip replaced (a tentative end or a line said twice: 000011, 000015, 000026, 000043 of 29 Sep); 66 from before the run (28 Sep: the old command card and other utterances) |
| Worker | the bridge's own `speech/stt_worker.py` through `LocalWhisper`: `float16` on CUDA, `beam_size=1`, `vad_filter=True`, the bridge's `sttVocabulary` as the initial prompt |
| Check | small.en wrote the same text as the bridge did live for 45 of 45 clips |
| Order | one model at a time, beside the running bridge |
| Word error rate | word edits against the card line, over all 45 clips. Before the count, the text goes to lower case and every run of characters other than letters and digits becomes one space: "conversation.ts" and "conversation, TS" agree; "2-4" agrees with "2.4"; "car queue" does not agree with "car cue" |
| Exact | the count of clips with no word edit |
| Commands matched | the lines 13 to 15, by `match` from `src/commands.ts`: the clip matched the command the card wants |
| Decode time | the round trip of one `transcribe` call, after one untimed pass. "First decode" is that untimed pass |
| GPU memory | the peak of the `nvidia-smi` total while the model ran, less the total before its worker started. The bridge shares the GPU, so the figure can hold about 350 MB of other use: large-v3 read 4533 MiB on one run and 4174 MiB on the other |

```
bun scripts/score-models.ts --since "2026-09-29 10:00" --python ~/sidetone/.venv/bin/python --out /tmp/scores.json
bun scripts/score-models.ts --since "2026-09-29 10:00" --python ~/sidetone/.venv/bin/python --no-prompt --out /tmp/noprompt.json
```

## Scores

With the bridge's vocabulary prompt, and the error rate and exact count of a
second run without it. RTX 5070, faster-whisper 1.2.1, CTranslate2 4.8.2.

| Model | WER | Exact lines | Commands matched | Median decode | Worst decode | First decode | GPU memory | WER, no prompt | Exact, no prompt |
|---|---|---|---|---|---|---|---|---|---|
| small.en | 8.2% | 28/45 | 9/9 | 125 ms | 199 ms | 648 ms | 814 MiB | 16.1% | 16/45 |
| tiny.en | 18.5% | 19/45 | 9/9 | 89 ms | 155 ms | 631 ms | 302 MiB | 26.2% | 13/45 |
| base.en | 13.0% | 19/45 | 9/9 | 96 ms | 150 ms | 561 ms | 398 MiB | 20.9% | 13/45 |
| medium.en | 5.3% | 34/45 | 9/9 | 207 ms | 312 ms | 703 ms | 2134 MiB | 11.9% | 19/45 |
| large-v3 | 7.7% | 26/45 | 9/9 | 420 ms | 558 ms | 517 ms | 4533 MiB | 13.2% | 21/45 |
| large-v3-turbo | 9.0% | 28/45 | 9/9 | 263 ms | 346 ms | 395 ms | 2318 MiB | 17.5% | 17/45 |
| distil-small.en | 24.1% | 9/45 | 7/9 | 102 ms | 154 ms | 767 ms | 622 MiB | 20.6% | 15/45 |
| distil-medium.en | 96.8% | 0/45 | 0/9 | 169 ms | 213 ms | 719 ms | 1230 MiB | 20.1% | 14/45 |
| distil-large-v3 | 15.1% | 17/45 | 9/9 | 255 ms | 323 ms | 338 ms | 2254 MiB | 17.5% | 17/45 |
| distil-large-v3.5 | 17.7% | 16/45 | 9/9 | 259 ms | 349 ms | 402 ms | 2254 MiB | 19.6% | 14/45 |

The first decode costs 330 to 770 ms for every model. The worker warms up on a
second of silence, which `vad_filter` drops, so the decoder does not run until
the first real utterance. On the bridge that is the first thing Chris says
after a restart.

## Wrong clips by line

The count of rounds, of three, that each model got wrong on each line, with
the prompt.

| # | Line | tiny | base | small | medium | large-v3 | turbo | d-small | d-medium | d-large-v3 | d-large-v3.5 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | Drop that job. | · | · | · | · | · | · | · | 3 | · | · |
| 2 | Add a to-do item for the car cue. | 3 | 3 | 3 | 3 | 3 | 3 | 3 | 3 | 3 | 3 |
| 3 | What does item 67 say? | · | · | · | · | · | · | 1 | 3 | · | · |
| 4 | Open conversation.ts and find the readLine function. | 1 | 2 | · | · | · | · | 3 | 3 | 2 | 3 |
| 5 | Is the LiveKit server still up on port 7880? | 3 | 3 | 3 | 2 | 3 | 3 | 3 | 3 | 3 | 3 |
| 6 | Land the transcription card job, then restart the service. | 1 | · | · | · | · | · | 2 | 3 | 1 | · |
| 7 | Check the worktree for changes before you rebase onto main. | 3 | 1 | 1 | · | 1 | 2 | 3 | 3 | 3 | 3 |
| 8 | Read ADR 6 and tell me why Sidetone matches the sound of the wake word. | 3 | 3 | 2 | 1 | 2 | 3 | 3 | 3 | 3 | 3 |
| 9 | Ask Claude to build the APK and run bun test. | 3 | 3 | 3 | 2 | 2 | 3 | 3 | 3 | 1 | 1 |
| 10 | The answer took 2.4 seconds, and Kokoro used 350 milliseconds of that. | 2 | 2 | 2 | 1 | 1 | 1 | 3 | 3 | 2 | 2 |
| 11 | Which Whisper model are we running right now? | · | · | · | · | · | · | 1 | 3 | · | · |
| 12 | When the road gets loud on the highway, keep each answer short and say the item number first. | 3 | 2 | 2 | 2 | 2 | 2 | 2 | 3 | 2 | 2 |
| 13 | sidetone, end the turn | 3 | 3 | · | · | 2 | · | 3 | 3 | 3 | 3 |
| 14 | sidetone, male voice | · | 3 | · | · | 1 | · | 3 | 3 | 3 | 3 |
| 15 | sidetone, recap | 1 | 1 | 1 | · | 2 | · | 3 | 3 | 2 | 3 |

Some errors are in the clip, not the model. Where the top four models
(small.en, medium.en, large-v3, large-v3-turbo) all wrote the same other
word, Chris most likely said it, and no model can score that clip:

| Line | Round | All four wrote |
|---|---|---|
| 12 | 1 | "say the number first", no "item" |
| 12 | 2 | "read the item number first" |
| 10 | 3 | "Kokoro took", not "used" |
| 5 | 1, 2 | "service", not "server" |

Every model got line 2 wrong in every round: "car cue" is always "car queue"
or "CarQ", and "Add a" is often "Edit" or "and a". "bun test" is "BunTest",
"buntest" or "button test". "wake word" is sometimes "weak word".

## What each model wrote wrong

With the prompt. distil-medium.en is left out: it wrote nothing for any clip.

#### small.en

| # | Round | Heard |
|---|---|---|
| 2 | 1 | added to do item for the Car Queue. |
| 5 | 1 | is LiveKit service still up on port 78080. |
| 8 | 1 | Read ADR6 and tell me why Sidetone matches the sound of the wake word. |
| 9 | 1 | Ask Claude to build the APK and run BunTest. |
| 10 | 1 | The answer to 2.4 seconds and Kokoro used 350 milliseconds of that |
| 12 | 1 | When the road gets loud on the highway, keep each answer short and say the number first. |
| 15 | 1 | Sidetone and Recap |
| 2 | 2 | and a to-do item for the Car Queue. |
| 5 | 2 | Is the LiveKit service still up on port 780-90? |
| 9 | 2 | Ask Claude to build the APK and run button test. |
| 12 | 2 | When the road gets loud on the highway keep each answer short and read the item number first. |
| 2 | 3 | Edit to-do item for the car queue. |
| 5 | 3 | Is LiveKit server still up on port 7880? |
| 7 | 3 | Check the worktree for changes before you rebase on to main. |
| 8 | 3 | read ADR6 and tell me why Sidetone matches the sound of the wake word. |
| 9 | 3 | ask Claude to build the APK and run Buntest |
| 10 | 3 | The answer took 2 4 seconds and Kokoro took 350 milliseconds of that. |

#### medium.en

| # | Round | Heard |
|---|---|---|
| 2 | 1 | Edit to do item for the car queue. |
| 5 | 1 | Is the LiveKit service still up on port 78080? |
| 9 | 1 | Ask Claude to build the APK and run BUNTEST. |
| 12 | 1 | When the road gets loud on the highway, keep each answer short and say the number first. |
| 2 | 2 | and a to-do item for the car queue. |
| 5 | 2 | Is the LiveKit service still up on port 78090? |
| 8 | 2 | Read ADR 6 and tell me why Sidetone matches the sound of the weak word. |
| 12 | 2 | When the road gets loud on the highway, keep each answer short and read the item number first. |
| 2 | 3 | Edit to do item for the car queue |
| 9 | 3 | Ask Claude to build the APK and run BUNTEST. |
| 10 | 3 | The answer took 2-4 seconds and Kokoro took 350 milliseconds of that. |

#### large-v3

| # | Round | Heard |
|---|---|---|
| 2 | 1 | Add a to-do item for the car queue. |
| 5 | 1 | Is the LiveKit service still up on port 78080? |
| 9 | 1 | Ask Claude to build the APK and run buntest. |
| 12 | 1 | When the road gets loud on the highway, keep each answer short and say the number first. |
| 13 | 1 | Sidetone and the turn |
| 15 | 1 | Sightone and recap |
| 2 | 2 | and a to-do item for the car queue. |
| 5 | 2 | Is the livekit service still up on port 78090? |
| 8 | 2 | Read ADR6 and tell me why Sidetone matches the sound of the weak word. |
| 12 | 2 | When the road gets loud on the highway, keep each answer short and read the item number first. |
| 13 | 2 | Sidetone and the turn |
| 14 | 2 | Sightone Male Voice |
| 2 | 3 | Add a to-do item for the car queue. |
| 5 | 3 | Is the LiveKit service still up on port 7880? |
| 7 | 3 | Check the worktree for changes before you rebase on domain. |
| 8 | 3 | Read ADR6 and tell me why Sidetone matches the sound of the wake word. |
| 9 | 3 | Ask Claude to build the APK and run one test. |
| 10 | 3 | The answer took 2-4 seconds and Kokoro took 350 milliseconds of bass. |
| 15 | 3 | Sightone recap |

#### large-v3-turbo

| # | Round | Heard |
|---|---|---|
| 2 | 1 | Add a to-do item for the car queue |
| 5 | 1 | Is the LiveKit service still up on port 78080? |
| 8 | 1 | Read ADR6 and tell me why Sidetone matches the sound of the wake word |
| 9 | 1 | Ask Claude to build the APK and run BunTest |
| 12 | 1 | When the road gets loud on the highway, keep each answer short and say the number first. |
| 2 | 2 | Edit to-do item for the car queue |
| 5 | 2 | Is the LiveKit service still up on port 78090? |
| 7 | 2 | Check the worktree for changes before you rebase on domain |
| 8 | 2 | Read ADR6 and tell me why Sidetone matches the sound of the weak word |
| 9 | 2 | Ask Claude to build the APK and run button test. |
| 12 | 2 | When the road gets loud on the highway, keep each answer short and read the item number first. |
| 2 | 3 | Edit to do item for the car queue |
| 5 | 3 | Is the LiveKit service still up on port 7-880? |
| 7 | 3 | Check the worktree for changes before you rebase on domain |
| 8 | 3 | Read ADR6 and tell me why Sidetone matches the sound of the wake word. |
| 9 | 3 | Ask Claude to build the APK and run BunTest. |
| 10 | 3 | The answer took 2-4 seconds and Kokoro took 350 milliseconds of bass |

#### tiny.en

| # | Round | Heard |
|---|---|---|
| 2 | 1 | Edit to do item for the car queue. |
| 4 | 1 | OpenConversation.ts and find the readline function. |
| 5 | 1 | is LiveKit service still up on port 788. |
| 7 | 1 | Check the worktree for changes before you rebates on to main. |
| 8 | 1 | Read ADR6 until me why Sidetone matches the sound of the wake word. |
| 9 | 1 | as Claude to build the APK and run Buntest. |
| 10 | 1 | The answer to 2.4 seconds and Kokoro use 350 milliseconds of that. |
| 12 | 1 | When the Rogue is loud on the highway, keep each answer short and say the number first. |
| 13 | 1 | Sidetone and the turn. |
| 15 | 1 | Sidetone, a recap. |
| 2 | 2 | and it's a du item for the car queue. |
| 5 | 2 | is the LiveKit service to up on port 780.90. |
| 6 | 2 | Land the transcripting card job then restart the service. |
| 7 | 2 | Check the worktree for changes before you rebates onto main. |
| 8 | 2 | Read ADR6 until my wife Sidetone matches the sound of the wake word. |
| 9 | 2 | S. Claude to build the APK and run Bun Test. |
| 12 | 2 | and the road gets loud on the highway, keep each answer short and a revi item number first. |
| 13 | 2 | Sidetone and the turn. |
| 2 | 3 | Edit to do item for the car queue. |
| 5 | 3 | is LiveKit service still up on port 788. |
| 7 | 3 | to shut the worktree for changes before you rebates on to main. |
| 8 | 3 | Read ADR6 and tell me why Sidetone matches the sound of the wake word. |
| 9 | 3 | S. Claude to build the APK and run one test. |
| 10 | 3 | The answer took two four seconds and Kokoro took 350 milliseconds of bass. |
| 12 | 3 | and the road gets loud on the highway, keep each answer short and say the item number first. |
| 13 | 3 | Cytone and the turn. |

#### base.en

| # | Round | Heard |
|---|---|---|
| 2 | 1 | Edit to do item for the car queue. |
| 4 | 1 | Open Conversation.ts and find the read line function. |
| 5 | 1 | is LiveKit service still up on Port 78080. |
| 8 | 1 | Read ADR6 until me why Sidetone matches the sound of the wake word. |
| 9 | 1 | Ask Claude to build the APK and run Buntest. |
| 10 | 1 | The answer to 2.4 seconds and Kokoro used 350 milliseconds of that. |
| 12 | 1 | When the road gets loud on the highway, keep each answer short and say the number first. |
| 13 | 1 | Sidetone and the turn |
| 14 | 1 | Sidetone, mail voice. |
| 15 | 1 | Sidetone and Recap |
| 2 | 2 | and a to-do item for the car queue. |
| 4 | 2 | Open conversation.ts and find the read line function |
| 5 | 2 | is LiveKit service still up on Port 78090. |
| 8 | 2 | Read ADR6 and tell me why Sidetone matches the sound of the wake word. |
| 9 | 2 | S. Cloud to build the APK and run button test. |
| 12 | 2 | When the road gets loud on the highway, keep each answer short and read the item number first. |
| 13 | 2 | Sidetone and the turn |
| 14 | 2 | Sidetone, mail voice |
| 2 | 3 | Add a to-do item for the car queue |
| 5 | 3 | is like it serviced still up on port 7880. |
| 7 | 3 | Check the worktree for changes before you rebase on Tamein. |
| 8 | 3 | Read ADR6 and tell me why Sidetone matches the sound of the wake word. |
| 9 | 3 | Ask Claude to build the APK and run Buntest. |
| 10 | 3 | The answer took two four seconds and Kokoro took 350 milliseconds of that. |
| 13 | 3 | Sidetone in the turn |
| 14 | 3 | Sidetone, mail voice. |

#### distil-small.en

| # | Round | Heard |
|---|---|---|
| 2 | 1 | Headed to Do Item for the CarQ. |
| 4 | 1 | Open Conversation.T.S. and Find the Readline function. |
| 5 | 1 | Is the Live Kit service still up on Port 78080? |
| 7 | 1 | Check the work tree for changes before you rebase onto Maine. |
| 8 | 1 | Read ADR6 and tell me why Sightone matches the sound of the wakeword. |
| 9 | 1 | Ask Claw to build the APK and run Bun test. |
| 10 | 1 | The Answer to 2.4 seconds and Coro used 350 milliseconds of that. |
| 12 | 1 | When the road gets loud on the highway, keeping each answer short and say the number first. |
| 13 | 1 | Side-tone, end the turn. |
| 14 | 1 | Sitone, Mail Voice. |
| 15 | 1 | Saitone, or Recap. |
| 2 | 2 | and it's a do item for the car queue. |
| 4 | 2 | Open, Conversation.T.S. and Find the Readline function. |
| 5 | 2 | Is the Live Kit service still up on Port 780-90? |
| 6 | 2 | Land the transcripting card job, then restart the service. |
| 7 | 2 | Check the work fee for changes before you rebase on domain. |
| 8 | 2 | Read ADR6 and Tell Me Why Side Tone matches the sound of the wakeward. |
| 9 | 2 | Ask Cloud to build the APK and run button test. |
| 10 | 2 | The answer took 2.4 seconds and Kakoro used 350 milliseconds of that. |
| 11 | 2 | Which Whisper Model are we, we running right now? |
| 12 | 2 | When the road gets loud on the highway, keep each answer short, and read the item number first. |
| 13 | 2 | Saitone, End the Turn. |
| 14 | 2 | Sitone, Mail Voice. |
| 15 | 2 | Sitone, Recap. |
| 2 | 3 | Added to-do item for the car queue. |
| 3 | 3 | Which is item 67, too. |
| 4 | 3 | Open Conversation.T.S. and Find the Reedsline function. |
| 5 | 3 | Is Live Get Service still up on Port 788? |
| 6 | 3 | Land the transcription car job, then restart the service. |
| 7 | 3 | Check the work for changes before you rebates on domain. |
| 8 | 3 | Read ADR6 and tell me why Sightone matches the sound of the wake word. |
| 9 | 3 | Ask Claw to build the APK and run Bun test. |
| 10 | 3 | The answer took two four seconds and Kakoro took 350 milliseconds of that. |
| 13 | 3 | Sitone, End the Turn. |
| 14 | 3 | Sigmail Voice. |
| 15 | 3 | Situent, Recap. |

#### distil-large-v3

| # | Round | Heard |
|---|---|---|
| 2 | 1 | Add a to-do item for the car queue. |
| 4 | 1 | Openconversation.ts and find the readline function. |
| 5 | 1 | Is the live kit service still up on Port 78080? |
| 7 | 1 | Check the work tree for changes before you rebase onto Maine. |
| 8 | 1 | Read ADR6 and tell me why side tone matches the sound of the wake word. |
| 10 | 1 | The answer took 2.4 seconds, and KKhor used 350 milliseconds of that. |
| 12 | 1 | When the road gets loud on the highway, keep each answer short and say the number first. |
| 13 | 1 | Side tone and the turn. |
| 14 | 1 | Sightone male voice. |
| 15 | 1 | Sightone and recap. |
| 2 | 2 | and a to-do item for the car queue. |
| 5 | 2 | Is the Live Kit service still up on port 78090? |
| 7 | 2 | Check the wordtree for changes before you rebase on domain. |
| 8 | 2 | Read ADR6 and tell me why side tone matches the sound of the weak word. |
| 9 | 2 | Ask Cloud to build the APK and run Bun Test. |
| 12 | 2 | When the road gets loud on the highway, keep each answer short and read the item number first. |
| 13 | 2 | Sidetone and the turn. |
| 14 | 2 | Sightone male voice. |
| 15 | 2 | Saitone Recap. |
| 2 | 3 | Add a to-do item for the car queue. |
| 4 | 3 | Openconversation.ts and find the readline function. |
| 5 | 3 | Is the LiveKit service still up on Port 7 880? |
| 6 | 3 | land the transcription car job, then restart the service. |
| 7 | 3 | Check the worksheet for changes before you rebase on domain. |
| 8 | 3 | Read 80R6 and tell me why sidetone matches the sound of the wake word. |
| 10 | 3 | The answer took 2-4 seconds, and Kokoro took 350 milliseconds of bass. |
| 13 | 3 | Sightone, end the turn. |
| 14 | 3 | Sightone male voice. |

#### distil-large-v3.5

| # | Round | Heard |
|---|---|---|
| 2 | 1 | Add a to-do item for the car queue. |
| 4 | 1 | Openconversation.ts and find the read line function. |
| 5 | 1 | Is the live kit service still up on port 78080? |
| 7 | 1 | Check the work tree for changes before you rebase onto main. |
| 8 | 1 | Read ADR6 and tell me why side tone matches the sound of the wake word. |
| 10 | 1 | The answer took 2.4 seconds, and Kikora used 350 milliseconds of that. |
| 12 | 1 | When the road gets loud on the highway, keep each answer short and say the number first. |
| 13 | 1 | Side tone and the turn. |
| 14 | 1 | Side-tone male voice. |
| 15 | 1 | Sightone and recap. |
| 2 | 2 | and a to-do item for the car queue |
| 4 | 2 | Open, conversation.ts and find the read line function. |
| 5 | 2 | Is the live kit service still up on port 780-90? |
| 7 | 2 | Check the work tree for changes before you rebase on domain. |
| 8 | 2 | Read ADR6 and tell me why side tone matches the sound of the weak word. |
| 9 | 2 | Ask Cloud to build the APK and run bun test. |
| 12 | 2 | When the road gets loud on the highway, keep each answer short and read the item number first. |
| 13 | 2 | Side tone and the turn. |
| 14 | 2 | Sightone male voice. |
| 15 | 2 | Sightone recap. |
| 2 | 3 | Add a to-do item for the car queue. |
| 4 | 3 | Openconversation.ts and find the readline function. |
| 5 | 3 | Is the LiveKit service still up on port 7 880? |
| 7 | 3 | Check the worksheet for changes before you rebase on domain. |
| 8 | 3 | Read ADR6 and tell me why sidetone matches the sound of the wake word. |
| 10 | 3 | The answer took two four seconds and Kokoro took 350 milliseconds of bass. |
| 13 | 3 | Sightone, end the turn. |
| 14 | 3 | Sightone male voice. |
| 15 | 3 | Sightone, recap. |
