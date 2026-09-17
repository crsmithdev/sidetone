# The bridge starts the agent; the phone is not the brain

A phone app that reasons and calls tools on the machine is the obvious shape,
and it was tried: the project bridge exposed one project's command-line tool to
claude.ai as a connector. It loses the Claude Code loop, the instructions file,
the skills and the subagents, which is acceptable only when a project's logic
already lives in its own tool. The bridge therefore starts Claude Code in a
project directory and carries voice to it, and a project declares nothing.

## Considered options

- **A connector to claude.ai.** Ran from 6 September 2026. It needs a
  hand-written verb list per project and cannot help a project that has no
  command-line tool. It still exists on the `project-bridge` branch, where it
  runs the story pipeline.
- **A plugin inside Claude Code.** Impossible for the part that matters: this
  program starts Claude Code, so it cannot live inside it.
