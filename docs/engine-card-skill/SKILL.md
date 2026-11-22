---
name: xlm-studio-engine-card
description: Write an engine card (one JSON file) that lets XLM Studio run an inference engine. Use when asked to make, write or fix a card for an engine or llama.cpp fork for XLM Studio, for example "make a card for this engine (GitHub link) for XLM Studio (GitHub link)".
---

# Write an XLM Studio engine card

XLM Studio (https://github.com/RenZekta/XLM-Studio) is a launcher for llama.cpp
and other inference engines. An **engine card** is one JSON file that tells it
how to install, configure, start and stop an engine it does not support
natively. A card is data: it cannot run code. XLM Studio validates it when the
file appears.

Your task is to produce that one JSON file for the engine you were given, and
to prove it is correct with the checker. Nothing else: do not write launcher
scripts, build scripts, READMEs or archives. XLM Studio installs, builds and
starts the engine itself.

## What is in this skill

- `guide.md`: the full reference for the card format. Read all of it first.
- `check-card.cjs`: the checker. Needs only Node.
- `examples/`: a complete engine card and a fork card to copy the shape from.

The same files live in the XLM Studio repository, which is the source of truth
if these copies look old: `docs/engine-cards.md` (the guide) and
`docs/engine-card-skill/` (this skill, the checker and the examples).
Raw files: `https://raw.githubusercontent.com/RenZekta/XLM-Studio/main/docs/engine-cards.md`,
`.../docs/engine-card-skill/check-card.cjs`, `.../docs/engine-card-skill/examples/example-engine.json`.

## Steps

1. **Read `guide.md` completely**, then `examples/`.
2. **Get the engine's source** (clone the repository you were given, or read it
   on GitHub). Find out how it is installed, how it is started, which flag takes
   the model, the port and the API key, and how it answers HTTP.
3. **Decide the card type** ("Which card to write" in the guide). A llama.cpp
   fork that ships `llama-server` gets a *fork card* (`"extends": "llama.cpp"`).
   Anything else that serves HTTP gets an *engine card*. If the engine cannot
   serve HTTP, or cannot take a GGUF path, say so instead of writing a card.
4. **Collect the parameters from the engine itself**: its `--help` output or the
   source of its argument parser. Copy flag spellings, value formats, ranges and
   option lists exactly. Never take them from memory or the README. Skip flags
   that XLM Studio sets itself (model, port, host, API key). For a fork card list
   only what the fork adds to llama.cpp.
5. **Write the card**: `source` and `install.steps` when XLM Studio should fetch
   and set up the engine, `launch` (a launcher per platform when it runs on
   several), then parameters. Use widgets, `rules`, `presets`, `overrides`,
   `checkpoints` and `memory` only where the engine really supports what they
   describe. A smaller correct card beats a large guessed one.
6. **Check it**: `node check-card.cjs <card.json>`. Fix every error and every
   warning you can, and run it again until it exits with 0. Read the command
   lines it prints and compare them with how the engine is really started. If you
   have the engine built or installed, add `--binary <program>` (and
   `--engine-dir <folder>`) so parameters the program does not know are listed.
7. **Install the card**: save it as `<id>.json` in the cards folder (see below).
   XLM Studio validates it at once; a `<id>.errors.txt` next to it lists what is
   still wrong, and disappears when the card is clean.
8. **Report back** briefly: the card file, which parameters you verified against
   which source, and anything you could not verify.

## Rules of thumb

- `id`: lowercase letters, digits, `.`, `_`, `-`. Templates store it, so it must
  not change later.
- Every parameter needs a real `description`.
- Test with the checker's sample command lines: `{port}` must reach the engine,
  and the model path must land on the engine's model flag.
- Do not list `--host` or `--api-key`; use `{host}` and `{apiKey}` in `launch.argv`.
- Do not claim anything the engine does not do (checkpoints, memory estimate,
  metrics). Leave the section out.

## Card tests

Automated tests for cards written by agents are planned. They will be placed in
this folder in the repository next to the guide and the checker.
