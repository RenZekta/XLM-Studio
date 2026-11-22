# Writing an engine card for XLM Studio

An engine card (and a fork card) is one JSON file that lets XLM Studio list,
configure, launch and stop an engine it does not support natively. A card is data only; it cannot run
code. XLM Studio validates it when the file appears and again on every change.

## Which card to write

Write only the card. XLM Studio builds and starts the engine itself, so do not
create launcher scripts, build scripts, READMEs or archives.

- **The engine is a llama.cpp fork** (it ships `llama-server` and takes
  llama.cpp's flags): write a **fork card**. XLM Studio already clones, builds
  from source (CUDA, Vulkan, ROCm, Metal or CPU), launches and configures
  llama.cpp, with its full parameter list, memory estimate, presets and
  checkpoints. The card names the fork and lists only the parameters the fork
  adds.
- **Any other engine** that serves HTTP: write an **engine card**, described
  from "Engine cards" on.

Before writing parameters, check every one against the engine itself: its
`--help` output or the source of its argument parser. Copy value formats and
option lists from there, not from memory or a README.

When you are done, run the checker (see "Checking a card" at the end). It is the
same validation XLM Studio applies, and it prints the command lines the card
produces.

## Fork cards

```json
{
  "cardVersion": 1,
  "id": "my-fork",
  "label": "My llama.cpp fork",
  "extends": "llama.cpp",
  "source": { "repo": "owner/llama.cpp", "branch": "main" },
  "params": {
    "categories": [
      {
        "name": "Prompt cache",
        "icon": "Database",
        "commands": [
          { "arg": "--cache-disk", "label": "Disk cache folder", "description": "Folder for the on-disk prompt cache.", "type": "text", "placeholder": "D:/llama-cache" }
        ]
      }
    ]
  },
  "defaultOptions": { "--cache-type-k": ["f16", "q8_0", "q4_0", "iq4_nl"] }
}
```

- `extends` must be `"llama.cpp"`. `source.repo` is `owner/repo` on GitHub;
  `source.branch` is optional (the default branch when left out). There is no
  `engine` and no `launch`: using either is an error.
- After the card appears, the fork is listed in Settings > Engine Tracker, where
  it is built from source. No releases are needed. Templates pick it as their
  backend, and its parameters show in the normal llama.cpp editor.
- `params` uses the same parameter fields as an engine card (below). List only
  what the fork adds. A parameter XLM Studio already has is shown once, from its
  own list, and the card's copy is ignored with a warning. If an option is
  already there under another spelling (`--gpu-layers` for `--n-gpu-layers`),
  leave it out.
- A category with the same name as a built-in group joins it; any other name
  becomes a new group.
- `defaultOptions` replaces the option list of a built-in select, by its arg.
- A tracker entry that comes from a card follows the card and cannot be removed
  by hand: remove the card instead. Builds already installed stay on disk.

## Engine cards

### What an engine must be

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
  version (`<engine.folder>/v1/`, `<engine.folder>/v2/`). A card with `source`
  or `install` (below) lets XLM Studio put the engine there itself.
- If a card is invalid or has warnings, `<id>.errors.txt` appears beside it
  (errors, warnings, the launcher candidates and the command lines the card
  produces for a sample model). Read it, fix the card, save; it is removed once
  there is nothing left to report.

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
| `source` | Optional. `{ "repo": "owner/repo", "branch": "main" }`. XLM Studio clones it into `<engines>/<engine.folder>/<repo>` (Settings > Engine Cards > Install) and updates it with `git pull`. |
| `install.steps` | Optional. A list of `{ "run": ["program", "arg", ...], "platform": ["windows", "linux", "macos"] }`, run in order inside the clone with no shell. `{engineDir}` is the clone. `platform` limits a step to those systems. A failing step stops the install. |
| `launch.file` | The launcher, relative to the engine folder. A string; a list of candidates, of which the first that exists is used (`*` matches within one name: `.venv/*/python.exe`); or an object keyed by `windows`, `macos`, `linux`, `default` whose values are either of those. |
| `launch.argv` | Arguments in order. A string is one argument. An array is a group that is left out when any placeholder in it is empty. |
| `launch.env` | Optional environment variables; values may use placeholders. |
| `launch.ready` | Optional. `log`: a regular expression tested against each output line. `http`: a path polled on the port. Any answer below 500 counts as ready. With neither, `/v1/models` is polled. |
| `launch.stop.graceMs` | Optional. How long the engine gets to exit on its own before it is killed (0 to 120000). It is asked to stop first: SIGTERM on Linux and macOS, Ctrl+C on Windows. |
| `launch.metrics` | Optional. `{ "path": "/metrics", "format": "prometheus" }` charts the Performance view from Prometheus text that uses llama.cpp's metric names. Default is none. |
| `params` | Optional: `categories`, `rules`, `blocks`, `presets`, below. |
| `overrides` | Optional global override sections, below. |
| `checkpoints` | Optional KV cache checkpoints, below. |
| `memory` | Optional memory estimate, below. |

Launchers run through the interpreter their extension implies: `.bat` and
`.cmd` through `cmd.exe` (arguments may not contain `"` or `%`), `.ps1` through
PowerShell, `.py` through Python, `.sh` through bash, anything else directly.
A launcher that exists on one system only (`.exe`, `.bat`, `.sh`) cannot start
the engine on the others; give one per platform when the engine runs there.

## Placeholders

`{model}` model file path, `{modelDir}` its folder, `{port}`, `{host}`,
`{apiKey}`, `{name}` the Template's name (a model id the engine can serve it
under, so harnesses and MCP tools find it), `{engineDir}` the folder of the
engine version in use, and `{params}` (must be an argument on its own) which
expands to every parameter the user set, in card order, followed by the
Template's Custom Arguments text.

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
- `icon` (of a category): one of `Box`, `Cpu`, `Zap`, `Database`, `Wind`,
  `Server`, `GitBranch`, `Image`, `Wrench`, `Sliders`.

A boolean set to on sends its flag alone. A value the user never set is not
sent. Every Template also has a Custom Arguments box for flags the card does not
list; they follow the listed parameters.

### Widgets

`widget` picks how a value is edited. It must fit the `type`.

| `widget` | For `type` | Notes |
|---|---|---|
| `slider` | `number` | Needs `slider.min` and `slider.max` (numbers or `{ "expr": ... }`). Also `slider.step`, `slider.scale` (`linear`, or `ladder` for powers of two), `slider.allowAuto`, `slider.recommended`, `slider.recommendedLabel`. |
| `segmented` | `select` | Up to 4 options shown as buttons. |
| `tristate` | `boolean` | Engine default / On / Off. Needs `offArg`. |
| `password` | `string`, `text` | Hidden text. |
| `textarea` | `text`, `string` | Several lines. |
| `file`, `folder` | `string`, `text` | Text box with a picker. |
| `list` | `string`, `text` | A list of items, stored as a list. Sent as one flag per item (`--lora a --lora b`), or with `"join": ","` as one flag with the items joined. `"repeat": true` forces one flag per item. |
| `keyvalue` | `text`, `string` | Name and value pairs, stored as `name=value` items and sent like a list. |

More emission fields:

- `internal: true`: the value is stored and shown but never sent. Use it for a
  switch that rules and groups react to. It cannot have `offArg`, `format` or `emit`.
- `valueMap` (selects): maps what is stored to what is sent: `{ "q8_0": "q8" }`.
- `emit`: `{ "expr": "..." }` computes what is sent from other values.
- `optionsBy` (selects): `{ "arg": "--family", "map": { "qwen": ["a", "b"] } }`
  changes the options with the value of another select.

`label`, `description`, `default`, `min` and `max` can be computed:
`{ "expr": "min(model.contextLength, 65536)" }`. `options` cannot; use
`optionsBy`.

## Expressions

An expression is a small formula with no side effects. A missing value is
`null`, `null` spreads through arithmetic, and an ordering comparison
(`<`, `<=`, `>`, `>=`) with `null` is false, so a rule never fails on a missing
value; it just does not fire. Division by zero is `null`.

- Operators: `+ - * / %`, `< <= > >= == !=`, `&& || !`, `a ? b : c`, parentheses.
  `+` joins text when either side is text.
- Literals: numbers, `"text"` or `'text'`, `true`, `false`, `null`.
- Functions: `min max round(x, digits) floor ceil abs clamp(x, lo, hi) len has(obj, key)
  isSet("--flag") arg("--flag") contains startsWith endsWith lower upper coalesce`.
  `arg("--x")` and `args["--x"]` are the value of a parameter now (after rules so far);
  `isSet` is true when it has a value.
- Text with `${expr}` parts (banner `text`, `warn`) fills them in; `$$` is a dollar sign.

What an expression can see:

| Name | Holds |
|---|---|
| `args` | Parameter values by flag. |
| `system.os` | `"windows"`, `"macos"`, `"linux"`. |
| `system.ram.totalMB`, `.freeMB` | Memory. |
| `system.vram.totalMB`, `.freeMB`, `.gpus[i].name/.totalMB/.freeMB` | GPU memory (one pool is read). |
| `system.cpu.physicalCores`, `.logicalCores`, `.name` | Processor. |
| `model.fileName`, `.sizeMB`, `.arch`, `.contextLength`, `.layers`, `.expertCount`, `.hiddenSize`, `.headCount`, `.kvHeads`, `.isMoe` | The GGUF model of the Template (`null` when none or unreadable). |
| `overrides.port`, `.host`, `.apiKeySet`, `.engine` | Global overrides in effect. |
| `template.name`, `.port` | The Template. |

## Rules

Rules react to values and hardware. They are evaluated in order, and a later
rule sees what an earlier one did.

```json
"rules": [
  { "id": "low-vram", "when": "system.vram.freeMB < 6000",
    "then": [
      { "clamp": { "arg": "--context", "max": 16384 } },
      { "warn": "Only ${round(system.vram.freeMB / 1024, 1)} GB of VRAM is free.", "tone": "warning", "at": "--context" }
    ],
    "else": [] }
]
```

`when` is an expression. `then` runs when it is true, `else` when it is not.
Each effect has exactly one action:

| Action | Effect |
|---|---|
| `show`, `hide`: `["--arg"]` | Hidden parameters are not shown and not sent. |
| `enable`, `disable`: `["--arg"]` | A disabled parameter is shown, greyed out. |
| `force`: `{ "--arg": value }` | Sets the value and locks it. Values may be `{ "expr": ... }`. |
| `default`: `{ "--arg": value }` | The value when the user has not set one. |
| `clamp`: `{ "arg", "min", "max" }` | Limits a number. `min` and `max` may be `{ "expr": ... }`. |
| `require`: `["--arg"]`, `message` | The Template cannot start while these are empty. |
| `warn`: text, `tone`, `at` | A banner. `at` is a parameter (under its row) or a category. Without it, it is shown at the top. |

Forced and default values exist only for a launch and for the display; the
Template keeps what the user typed. Precedence, strongest first: an engine
override (below), a `force` rule, the user's value, a `default` rule, the
engine's own default. Tones: `info`, `success`, `warning`, `danger`, `muted`.

## Blocks

Extra pieces of interface, in `params.blocks`:

```json
"blocks": [
  { "id": "gpu", "kind": "stat", "label": "GPU", "value": "system.vram.gpus[0].name", "section": "Generation" },
  { "id": "note", "kind": "banner", "tone": "info", "when": "model.isMoe", "text": "Mixture of experts: ${model.expertCount} experts." },
  { "id": "spec-group", "kind": "group", "label": "Speculative decoding", "enabledBy": "--spec", "commands": ["--draft"], "at": { "after": "--spec" } },
  { "id": "estimate", "kind": "estimate", "label": "Estimated memory" }
]
```

`kind`: `banner` (`text`, `tone`), `stat` (`label`, `value` expression), `divider`
(`label`), `group` (`label`, `enabledBy` a boolean parameter, `commands`: those
are disabled while the switch is off) and `estimate` (needs `memory`).
Every block may have `when` (shown only while true), `section` (a category name;
default the first) and `at`: `"start"` (default), `"end"`, or `{ "after": "--arg" }`
to sit under that parameter.

## Presets

```json
"presets": [
  { "id": "fast", "name": "Fast", "description": "Short context.", "args": { "--context": 8192 } },
  { "id": "long", "name": "Long context", "mode": "replace", "args": { "--context": { "expr": "min(model.contextLength, 65536)" } } }
]
```

Buttons above the parameters. `mode` is `merge` (default: set the listed values,
keep the rest) or `replace` (clear every parameter except internal switches
first). Values may be `{ "expr": ... }`. MCP clients apply them with
`apply-parameters-preset`.

## Overrides

Settings of the Overrides page for this engine. A field that is on forces its
parameter on every Template of the engine and locks it in the editor.

```json
"overrides": {
  "sections": [
    { "id": "perf", "title": "Performance", "fields": [
      { "id": "batch", "label": "Batch size", "type": "number", "min": 1, "max": 4096, "applyTo": "--batch" }
    ] }
  ],
  "global": { "parallel": "--max-parallel", "threads": "--threads" }
}
```

A field has `id`, `label`, `type` (`boolean`, `number`, `string`, `select` with
`options`), `description`, `applyTo` (a parameter) and optional `value` (an
expression computing what is forced from the field's value). `global` maps the
app's own Parallel Inference and CPU Threads overrides onto parameters of this
engine; leave a key out when the engine has no such setting.

## Checkpoints

Saves the prompt cache when the engine stops and restores it when it starts,
like llama.cpp. The engine must expose HTTP calls for it.

```json
"checkpoints": {
  "enable": { "arg": "--slot-save-path", "value": "{checkpointDir}" },
  "save": { "method": "POST", "path": "/slots/0?action=save", "body": { "filename": "{filename}" } },
  "restore": { "method": "POST", "path": "/slots/0?action=restore", "body": { "filename": "{filename}" } }
}
```

`enable` is the flag that tells the engine where it may keep files (leave it out
when it needs none). `{checkpointDir}` and `{filename}` are the only
placeholders. `save` and `restore` are optional individually (one is enough).
The global setting and the per-Template switch work as for llama.cpp.

## Memory estimate

```json
"memory": { "estimator": "llama", "map": { "contextLength": "--context", "cacheTypeK": "--kv", "cacheTypeV": "--kv-v" } }
```

Feeds llama.cpp's memory model with the card's parameters (inputs:
`contextLength`, `cacheTypeK`, `cacheTypeV`, `parallel`, `gpuLayers`). It is
exact for GGUF models of architectures llama.cpp knows, and only an estimate for
anything else; it shows in an `estimate` block and reads GGUF models only. Add
it only when the engine's memory behaves like llama.cpp's.

## Checking a card

`check-card.cjs` is next to this guide (`docs/engine-card-skill/` in the
repository; the installed skill carries a copy). It needs only Node.

```
node check-card.cjs my-engine.json
node check-card.cjs my-engine.json --binary /path/to/engine --engine-dir /path/to/engine/folder
node check-card.cjs my-fork.json --binary /path/to/llama-server
```

It reports errors (the card will not load), warnings (it loads but probably does
not do what was meant), the launcher candidates per platform and the command
lines the card produces for a sample model, with every preset applied.
`--binary` runs `<program> --help` and lists card parameters the program does not
mention. It exits with 1 on errors. Fix everything it reports, then check every
parameter again against the engine's own source.

## Not supported yet

Engines that inherit another engine's parameters, and rules that write into
other values when the user edits one (`force` and `default` cover what a launch
needs). A card that uses unknown keys loads, with a warning, and the keys are
ignored.
