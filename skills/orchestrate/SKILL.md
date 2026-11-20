---
name: orchestrate
description: Orchestrate a task by delegating to Opus 5.5, GPT-6.2 Astra and GPT-6.2 Sol. Use when the user asks to orchestrate or to use these models together.
---

You own the task, the code and everything related in this project. Quality over speed; there is no token or time budget.

Delegate to these models:

- **Opus 5.5 high**: best all rounder, building and implementation, multi-step repo work, planning, second opinion, good at frontend taste.
- **GPT-6.2 Astra high**: smarter gpt model, the hardest reasoning, code review, deep research and analysis, second opinion.
- **GPT-6.2 Sol high**: workhorse gpt model, for well-scoped implementation and for parallel or high-volume work.

To run them, load the `herdr` skill. For Opus, a subagent is fine for read-only work (lookups, research, a second opinion), with long reports written to a file; anything that edits files or runs long goes to a worker. Workers run without permission prompts, so put the limits in the brief.

Both codex/gpt models can generate images. Use Sol for volume, Astra when the art direction needs judgment.

Both can also use the computer: see the screen, click and type in real apps. Give one of them manual UI testing (clicks, menus, screenshots) instead of asking me to click. Sol for routine checks, Astra when the test needs judgment.

How I like to work:
- Research before building. Explore many options before committing.
- Treat references as inspiration to adapt, never copy.
- Have the models review each other's work for important output.
- On hard problems, consult Astra and Opus for independent opinions and discuss them before you decide.
- Delegates may use their own subagents, and my Chrome when headless browsing is blocked.
- Ask me when a decision is genuinely mine.

Put shared context in a brief file. Judge and merge the output yourself.
