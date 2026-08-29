# Instructions for agents working on XLM-Studio

This is a solo-developer project. There's no PR review process and no
maintainer capacity to protect, so most of a typical AI-contribution policy
doesn't apply here. The one thing that matters: code and comments should read
as if a single careful engineer wrote them, not as a transcript of a chat
session.

## Comments

Keep comments concise. A comment should tell a future reader something the
code itself doesn't already say — a non-obvious invariant, a constraint
imposed by an external system (llama.cpp's CLI, the GGUF format, Electron),
or the reason behind a choice that isn't the obvious one. If the code is
self-explanatory, don't add a comment just to narrate it.

Do not reference the conversation that produced the change. No "Task 3",
"Item 2", "Bug fix (this round)", "per the user's request", "as discussed
above". None of that means anything to someone reading the file later — it
only means something in the chat transcript that isn't part of the
repository. Write the comment as if it's always been there.

If a comment is explaining a bug fix, describe the invariant or failure mode
itself, not the fact that a bug existed and was fixed. "X must happen before
Y because Z" is useful forever. "Fixed a bug where X happened before Y" stops
being useful the moment the surrounding code changes again.

```
// GOOD (explains a non-obvious constraint)
// mlock requires the file to already be memory-mapped; llama.cpp asserts on
// this internally, so --load-mode enforces it as one combined option.

// BAD (narrates the fix, references "the user")
// Bug fix: previously this caused a crash when the user turned off mmap
// while mlock was on. Now we combine them into one flag as requested.
```

```
// GOOD (code is self-explanatory, no comment needed)
const port = override.enabled ? override.port : template.serverPort ?? 8080

// BAD (restates what the code already says)
// Get the port: if override is enabled use the override port, otherwise
// use the template's port, falling back to 8080
const port = override.enabled ? override.port : template.serverPort ?? 8080
```

When editing existing code, don't leave the old comment in place alongside a
new one explaining the same thing differently — replace it. A function
should have one coherent explanation of what it does, not a changelog of
every pass someone made over it.

## Code style

- Match the surrounding code's conventions rather than introducing a new
  pattern for the same problem.
- Prefer extending an existing helper over adding a parallel one that does
  almost the same thing.
- No em dashes, curly quotes, or other non-ASCII punctuation in code or
  comments — plain ASCII only.

## Before large changes

For anything that touches how args/settings flow between the renderer, the
main process, and llama-server (this repo's most bug-prone seam), trace the
full path — schema definition, default application, live editing, command
preview, and actual process launch — before changing any one piece of it.
Several bugs in this codebase came from those five places drifting out of
sync with each other.
