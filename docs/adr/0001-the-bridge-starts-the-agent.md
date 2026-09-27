# The bridge starts the agent; the phone does not reason

The obvious design is a phone app that reasons and calls tools on the machine.
Chris tried it: the earlier connector (the `project-bridge` branch) exposed one
project's command-line tool to claude.ai. That design loses the Claude Code
loop, the instructions file, the skills and the subagents. The loss is
acceptable only when a project's logic already lives in its own tool. So the
bridge starts Claude Code in a project directory and carries voice to it. A
project declares nothing.

## Considered options

- **A connector to claude.ai.** Ran from 6 September 2026. It needs a
  hand-written verb list per project and cannot help a project that has no
  command-line tool. It still exists on the `project-bridge` branch, set up
  for the command-line tool of one writing project.
- **A plugin inside Claude Code.** Impossible for the part that matters: this
  program starts Claude Code, so it cannot live inside it.
