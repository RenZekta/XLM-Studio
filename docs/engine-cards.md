# Writing an engine card for XLM Studio

An engine card is one JSON file that lets XLM Studio list, configure, launch and
stop an engine it does not support natively. A card is data only; it cannot run
code. XLM Studio validates it when the file appears and again on every change.

## What an engine must be

- A program that starts an HTTP server (OpenAI-compatible, so the chat window
  and harnesses work) on the port XLM Studio gives it.
- Started by one launcher file (`.exe`, `.bat`, `.cmd`, `.ps1`, `.sh`, `.py` or
  any executable), with settings passed as command-line arguments.
- Models are GGUF files chosen in the Template; the engine gets the path.

## Where files go

- The card: `<data folder>/engine-cards/<id>.json` (Settings > Engine Cards >
  Open cards folder).
- The engine itself: `<engines folder>/<engine.folder>/`. Either the launcher is
  directly in that folder, or each subfolder holding the launcher is one
  version (`<engine.folder>/v1/`, `<engine.folder>/v2/`).
- If a card is invalid, `<id>.errors.txt` appears beside it. Read it, fix the
  card, save; it is removed once the card is valid.

## Minimal card

```json
{
  "cardVersion": 1,
  "id": "my-engine",
  "label": "My Engine",
  "engine": { "folder": "MyEngine" },
  "launch": {
    "file": { "windows": "start.bat", "default": "start.sh" },
    "argv": ["--model", "{model}", "--port", "{port}", ["--host", "{host}"], ["--api-key", "{apiKey}"], "{params}"]
  }
}
```

## Fields

| Field | Meaning |
|---|---|
| `cardVersion` | Always `1`. |
| `id` | Lowercase letters, digits, `.`, `_`, `-`. Not `llama.cpp` or `strata`. Templates store it, so do not rename it later. |
| `label` | Name shown in the app. |
| `description` | Optional. |
| `engine.folder` | Folder name inside the engines folder. |
| `launch.file` | Launcher relative to the engine folder: a string, or an object keyed by `windows`, `macos`, `linux`, `default`. |
| `launch.argv` | Arguments in order. A string is one argument. An array is a group that is left out when any placeholder in it is empty. |
| `launch.env` | Optional environment variables; values may use placeholders. |
| `launch.ready` | Optional. `log`: a regular expression tested against each output line. `http`: a path polled on the port. Any answer below 500 counts as ready. With neither, `/v1/models` is polled. |
| `launch.stop.graceMs` | Optional. How long the engine gets to exit on its own before it is killed (0 to 120000). |
| `launch.metrics` | Optional. `{ "path": "/metrics", "format": "prometheus" }` charts the Performance view from Prometheus text that uses llama.cpp's metric names. Default is none. |
| `params.categories` | Optional parameter groups, below. |

Launchers run through the interpreter their extension implies: `.bat` and
`.cmd` through `cmd.exe` (arguments may not contain `"` or `%`), `.ps1` through
PowerShell, `.py` through Python, `.sh` through bash, anything else directly.

## Placeholders

`{model}` model file path, `{modelDir}` its folder, `{port}`, `{host}`,
`{apiKey}`, `{engineDir}` the folder of the engine version in use, and
`{params}` (must be an argument on its own) which expands to every parameter the
user set, in card order.

`{port}` is the Template's port, or the global Base URL Override port when that
is on. `{host}` is `0.0.0.0` when the override serves on the local network, else
the Template's Host field. `{apiKey}` follows the same rule.

## Parameters

```json
"params": {
  "categories": [
    {
      "name": "Generation",
      "icon": "Zap",
      "commands": [
        { "arg": "--context", "label": "Context", "description": "Tokens kept in context.", "type": "number", "min": 256, "max": 1048576, "default": 8192 },
        { "arg": "--flash-attn", "label": "Flash attention", "description": "Faster attention.", "type": "boolean", "offArg": "--no-flash-attn" },
        { "arg": "--kv", "label": "KV precision", "description": "Cache type.", "type": "select", "options": ["f16", "q8_0", "q4_0"], "format": "equals" }
      ]
    }
  ]
}
```

- `arg`: the flag, and the key the value is stored under. Must be unique and
  must not start with `__`. `--host` and `--api-key` belong to the Server block
  and are used through `{host}` and `{apiKey}`; do not list them.
- `type`: `boolean`, `number`, `string`, `text` or `select`.
- `label`, `description`: shown in the app.
- `default`: shown when the user has not set a value. It is not sent.
- `min`, `max`, `placeholder`: for numbers and text.
- `options`, `optionLabels`, `emptyLabel`, `requireValue`: for selects.
  `optionLabels` maps an option to display text; `requireValue` removes the
  empty "engine default" choice.
- `offArg`: booleans only. Adds an On, Off and Engine default choice; Off sends
  this flag instead of nothing.
- `format`: `"space"` (`--flag value`, default) or `"equals"` (`--flag=value`).
- `icon`: one of `Box`, `Cpu`, `Zap`, `Database`, `Wind`, `Server`, `GitBranch`,
  `Image`, `Wrench`, `Sliders`.

A boolean set to on sends its flag alone. A value the user never set is not
sent.

## Not supported yet

Sliders and other widgets, rules between parameters, presets, memory estimates,
KV checkpoints, global override sections for an engine, and engines that
inherit another engine's parameters. A card that uses unknown keys loads, with
a warning, and the keys are ignored.
