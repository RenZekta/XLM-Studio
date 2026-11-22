# Engine cards: handoff and plan

A hand-off document for continuing the **custom engine cards** work for XLM Studio in a new
session. It records what exists, what you decided, and a code plan for what comes next. Read it
together with the repo's `AGENTS.md`, which is authoritative.

**To resume:** upload `XLM-Studio.zip` (the repo with all work so far) and this file. The work is
uncommitted in the zip; nothing was pushed upstream.

---

## Status: Step 3, Step 4 and findings 1 to 5 are implemented

Everything below passed `tsc --noEmit` for both projects, `electron-vite build` and all
`scripts/*-verify.js`. **Nothing was run in Electron and nothing was tested on Windows.** Treat runtime
behaviour as unverified until you have tried it.

| Item | Where |
|---|---|
| Expression language (no eval, whitelisted functions, never throws) | `shared/cardExpr.ts` |
| Context (`system`, `model`, `overrides`, `template`) built the same way in renderer and main | `shared/cardContext.ts`, `renderer/hooks/useCardContext.ts`, `ipc.ts` `buildLaunchCardContext`, `mcpControl.ts` `cardContextFor` |
| Rules, presets, overrides mapping, param emission (`resolveCard`, `applyPreset`, `overrideArgsFor`, `cardParamTokens`) | `shared/cardRules.ts` |
| Types and validation of rules, blocks, presets, overrides, checkpoints, memory, source, install | `shared/cardLogic.ts`, `shared/engineCard.ts` |
| Widgets: slider, segmented, tristate, password, textarea, file, folder, list, keyvalue; `internal`, `repeat`/`join`, `valueMap`, `emit`, `optionsBy`, `{expr}` fields | `renderer/components/paramParts.tsx`, `CardParamsEditor.tsx`, `CommandParam` in `shared/types.ts` |
| Blocks (banner, stat, group, divider, estimate), preset bar, memory estimate (llama estimator fed from the card's `memory.map`) | `CardParamsEditor.tsx`, `CardPresetBar.tsx` |
| Widgets also work for parameters added in the Commands Editor (llama.cpp and Strata editors); list values launch as one flag per item | `CommandsEditor.tsx`, `CmdParamsEditor.tsx`, `EngineParamsEditor.tsx`, `ModelCard.tsx`, `mcpControl.ts`, `shared/strata.ts` |
| Engine overrides (`engineOverrides` in settings, Overrides tab per card engine, global Parallel and Threads mapped by `overrides.global`) | `ipc.ts`, `CardOverridesPanel.tsx`, `OverridesView.tsx`, `shared/cardGlobals.ts` |
| Checkpoints from the card (`enable` flag, `save`/`restore` request specs, llama.cpp is the default spec) | `ipc.ts` |
| MCP: `list-engine-parameters`, card presets in `apply-parameters-preset`, card keys in `template-edit`, card view in `display-parameters-*` | `mcpControl.ts`, `cardTools.ts` |
| Finding 1: graceful stop. llama.cpp gets 5 s, card `graceMs` is honoured on Windows through a Ctrl+C helper | `ipc.ts` `stopGrace`/`killProcessTree`, `gracefulStop.ts` |
| Finding 2: Custom Arguments box in `CardParamsEditor`, emitted after `{params}` | `engineCard.ts`, `CardParamsEditor.tsx` |
| Finding 3: `source`, `install.steps`, `launch.file` candidate lists with `*` globs, Install/Update button with a live log | `cardInstall.ts`, `engineCards.ts`, `EngineCardsSection.tsx` |
| Finding 4: lints, resolved launcher and sample command lines in the sidecar report; standalone `check-card.cjs`; "Check parameters" for installed forks (`--help`) | `shared/cardReport.ts`, `src/tools/checkCard.ts`, `scripts/build-card-check.js`, `ipc.ts` `check-fork-card` |
| Finding 5: about 30 upstream server options and 14 alternate spellings added to the llama.cpp schema | `resources/commands.json` |
| "Copy prompt for an agent" replaced by the **engine card skill** (Add/Remove SKILL under Settings > Engine Cards) | `cardSkill.ts`, `docs/engine-card-skill/`, `EngineCardsSection.tsx` |

New verify scripts: `card-logic-verify.js` (expressions, rules, presets, overrides, validation),
`card-install-verify.js` (launcher globs, install from a local git repo, graceful-stop script),
`card-skill-verify.js` (skill files, the committed checker is current, examples valid, checker CLI),
`card-editor-verify.js` (server-side render of every widget).

**Rebuild the checker whenever `src/shared/` changes:** `node scripts/build-card-check.js`. The skill
verify script fails when `docs/engine-card-skill/check-card.cjs` is out of date.

### The engine card skill

`~/.agents/skills/xlm-studio-engine-card/` gets `SKILL.md` (the repository's
`docs/engine-card-skill/SKILL.md` plus a "This machine" section with the cards and engines folders),
`guide.md` (`docs/engine-cards.md`), `check-card.cjs` and `examples/`. It needs no MCP and no running
app. The repository holds the same files, so an agent that only has the GitHub link can read
`docs/engine-card-skill/SKILL.md` and download the checker. **The card tests are not written yet:** they
go in `docs/engine-card-skill/` next to the guide (the section "Card tests" in `SKILL.md` says so);
remove that section when they exist.

### Not verified, or decided without you

- **Windows graceful stop.** The PowerShell helper (`AttachConsole`, `GenerateConsoleCtrlEvent`)
  needs a target with a console. If the engine is started without one, the helper fails and the
  process is force-killed at once, so the worst case is today's behaviour. Test with the fork's disk
  prompt cache.
- **Install flow in the real app** (git present, progress log, the engine appearing in the Templates
  list right after install, `engine-cards-changed` after install).
- **Checkpoints of a non-llama engine** (restore waits for the card's readiness flag, not `/health`).
- **The estimate block** reads the app's llama estimator with `ignoreCtxOverride`; check the numbers
  against a real card engine.
- **`group` blocks** only disable their members and show a heading; they do not box the rows.
- **Block `at: "end"` / `{ after }`** render under the row; `"start"` renders as a movable block.
- **`vram.gpus`** has one entry: the app reads one memory pool.
- **Schema sync (finding 5)** added only server options with a verified type. Skipped on purpose:
  router mode (`--models-*`), the renamed speculative options (`--spec-*`, `--draft*`, `--mtp`,
  `--dflash`; the speculative widget owns them), tool and download options, training and TTS options,
  `--mmproj-*` (the mmproj widget owns them). Re-run the diff against upstream `common/arg.cpp` with
  `SERVER` in `set_examples` when bumping the schema.
- Findings left from the earlier list: Strata upstream sync (B9). Backlog B1 to B10 are untouched.

---

## Session update: the Piggidragon test and fork cards

**What happened.** An agent wrote a card for `github.com/Piggidragon/llama.cpp` (a llama.cpp fork).
XLM Studio handled it correctly: the loader validated it with no warnings, discovery, argv, spawn, the
`/health` readiness probe and the real `CardParamsEditor` (36 parameters, all widgets) all worked
against a stand-in `llama-server` on Linux. All 37 flags existed in the fork's `common/arg.cpp`.
Not run: Electron end to end, Windows, a real build.

**Workflow decision (user):** the agent writes **only the card**. XLM Studio builds the engines
itself. The agent had invented launcher scripts, a README and a zip because a card could not say where
an engine comes from or how to build it.

**Done in this pass: fork cards.** XLM's source build (`main/sourceBuild.ts`) is llama.cpp-specific
(clones repo and branch, cmake with `GGML_*` per backend type, builds `llama-server`). So a card for a
llama.cpp fork now names the fork and lists only the parameters it adds:

```jsonc
{ "cardVersion": 1, "id": "my-fork", "label": "My fork", "extends": "llama.cpp",
  "source": { "repo": "owner/llama.cpp", "branch": "main" },
  "params": { "categories": [ /* only what the fork adds */ ] },
  "defaultOptions": { "--cache-type-k": ["f16", "q8_0"] } }
```

- `shared/engineCard.ts`: `ForkCard`, `validateForkCard` (`validateEngineCard` routes on `extends`),
  `CardValidation.fork`, `EngineCardInfo.kind/repo/branch/paramCount`. `launch` and `engine` are errors.
- `shared/trackedMerge.ts`: `mergeCardForks` turns fork cards into Engine Tracker entries
  (`TrackedBackend.fromCard`), adopts a hand-made entry for the same repo and branch in place, follows
  card edits, removes the entry when the card goes, skips a repo a built-in entry already tracks.
- `main/engineCards.ts`: loads both kinds, `activeForkCards()`, warns when a fork card repeats a
  parameter llama.cpp already has (`baseArgs` callback), sidecar `<id>.errors.txt` now lists warnings.
- `main/ipc.ts`: `loadSettings` merges fork cards after `mergeDefaultTracked`;
  `buildTrackedCommandsSchema` no longer adds an extra command whose arg exists in any group;
  `remove-tracked-backend` refuses `fromCard` entries; the agent prompt was rewritten.
- UI: `EngineCardsSection` shows fork cards; `SettingsView` hides remove for `fromCard` entries.
- `docs/engine-cards.md`: "Which card to write" and "Fork cards" sections. Tests in `engine-card-verify.js`.
- The existing tracker already routes a repo with no releases (`needsSource: 'no-releases'`) or a named
  branch (`needsSource: 'branch'`) to the build-from-source flow. Verify that in the real app.

**Findings of that session:** implemented, see the status table above.

---

## 0. First actions in a new session

```sh
unzip XLM-Studio.zip && cd XLM-Studio
npm ci --ignore-scripts --no-audit --no-fund
npx tsc --noEmit -p tsconfig.node.json
npx tsc --noEmit -p tsconfig.web.json
node scripts/engine-card-verify.js      # card format, argv, registry, loader
node scripts/card-logic-verify.js       # expressions, rules, presets, overrides, validation
node scripts/card-install-verify.js     # launcher globs, install pipeline, graceful-stop script
node scripts/card-skill-verify.js       # engine card skill and the standalone checker
node scripts/card-editor-verify.js      # widgets rendered on the server
node scripts/strata-verify.js           # add a Strata clone path to also check against upstream
npx electron-vite build                 # production build check
```

All of these passed at the end of the last session. Plus the other `scripts/*-verify.js`. The app itself was **never run in Electron**
by me, and nothing was tested on Windows. Treat runtime behaviour as unverified until you have
tried it.

Rules from `AGENTS.md` as I understood them (re-read the file, it overrides this list): short
comments that explain why, plain ASCII, typecheck with `tsc --noEmit -p <project>` and never
`tsc -b`, no version bump, add `scripts/*-verify.js` checks for new logic, keep engine-specific
behaviour behind the engine registry rather than scattering `=== 'strata'`.

---

## 1. Product vision and your decisions

**Goal:** custom, natively unsupported engines. Adding support for any HTTP-serving engine should
be as easy as pointing an agent at the engine and asking it to write an engine card for XLM Studio.

Decisions you made, in your words where possible:

- **v1 scope:** HTTP-starting engines (OpenAI-compatible server on a port). CLI-only engines later.
  It replaces the hard-coding we do today for each new engine.
- **Where cards live:** built-in engines/repos ship with their cards inside the app
  (`resources/engine-cards/`). Custom cards live in a data folder like Templates
  (`<app data>/engine-cards/`). A custom card with the same id replaces a built-in one.
- **Paths:** relative to the engine's own folder; XLM manages engine folders itself. No absolute
  paths in a card so a card can be shared.
- **No confirmation dialogs.** Any side engine or Template can be malicious; an extra click
  changes nothing.
- **Maximum flexibility and control.** Cards get system information the app already polls
  (memory, CPU, GPU) and wiring to the Overrides page. For UI building: access to our parameter UI
  and its parts as building blocks, plus fully custom parameters, with theme sync.
- **Agent workflow:** a button that opens the cards folder in the file explorer, an engine card skill
  (added and removed from Settings, replacing the earlier "copy prompt" button), and a guide in `docs/`. **No "Validate" button:** validate automatically
  on import and on every change.
- **Memory estimator:** wiring is just passing values to it. Reject non-GGUF models with the
  llama estimator. A custom estimator inside a card may be too hard; do not promise it.
- **Presets:** card authors make their own; no restrictions.
- **KV checkpoints:** the card says how to trigger a checkpoint, since the global Overrides
  setting turns it on.
- **Overrides for new engine types:** their sections must be declared in the card.
- **Skill / MCP:** commands that list parameters (and presets) can parse the loaded cards and list
  them.
- **Applies to llama.cpp and Strata too, ideally:** custom parameter cards and new widgets should
  also work for the built-in engines.
- **Strata is the benchmark:** if the card format cannot express Strata, it is too weak.
- `cardVersion` is in the format for future migrations.

My defaults on questions you did not answer: ship launch + flat params first; llama.cpp forks stay
in the llama editor (relevant once `extends` exists).

---

## 2. What exists now

### Architecture in one paragraph

An engine card (JSON) is loaded and validated by `main/engineCards.ts`, which registers a generic
`EngineDef` in the shared registry (`shared/engines.ts`). Installs are discovered as
`<engines>/<card.engine.folder>/[<version>/]<launcher>`. The renderer registers the same cards at
startup. A Template with `engine: "<card id>"` shows `CardParamsEditor`; Start sends `cardArgs`
to `runModelImpl`, which builds the argument list from the card with the resolved port and the
Base URL Override, picks an interpreter by launcher extension, detects readiness, and stops with
the card's grace period.

### Files

Shared (pure, used by main, renderer and scripts):

| File | What it holds |
|---|---|
| `src/shared/engines.ts` | `EngineId = string`, `BuiltinEngineId`, live `ENGINES` and `ENGINE_IDS`, `registerCardEngines`, `isBuiltinEngine`, `isEngineId`, `engineOf` (keeps unknown ids), `engineDef` (returns a `missing: true` placeholder for unknown ids), `modelSpecificEngines`, `engineAcceptsModel`. `InstallKind` gained `'local'`; `vramEstimator` gained `'none'`. |
| `src/shared/engineCard.ts` | `EngineCard`, `CardLaunch`, `CardReady`, `CardMetrics`, `EngineCardInfo`, `CARD_VERSION = 1`, `validateEngineCard`, `cardToEngineDef`, `cardLauncherFile`, `buildCardArgv`, `cardEnv`, `cardPlaceholderValues`, `DEFAULT_READY`. |
| `src/shared/types.ts` | `CommandParam` gained optional `offArg` and `format`. |

Main process:

| File | What it holds |
|---|---|
| `src/main/engineCards.ts` | `initEngineCards`, `refreshEngineCards` (debounced `fs.watch`), `listLoadedCards`, `engineCardOf`, `cardForFolder`, `customCardsDir`, `scanCardEngine`, `buildCardSpawn`. Writes `<id>.errors.txt` beside a broken custom card and deletes it once fixed. |
| `src/main/ipc.ts` | IPC `get-engine-cards`, `refresh-engine-cards`, `open-engine-cards-folder`, `open-engine-folder` (the prompt IPC was replaced by `get-card-skill-state`, `add-card-skill`, `remove-card-skill`); `engine-cards-changed` broadcast. `runModelImpl` has an `isLlama` / `isStrata` / `card` split: card branch builds argv (reads the saved Template's args when the caller passes no `cardArgs`, which is how MCP starts work), spawns via `buildCardSpawn`, readiness by log regex or HTTP probe (any status below 500; default `/v1/models`), `stopGrace(engine, ms)`. `loadEngineCommandsSchema` returns the card's params; `getCommandsImpl` short-circuits for card engines (nothing is persisted beside the card). `scanBackendRoot` uses `cardForFolder` + `scanCardEngine`. |
| `src/main/mcpControl.ts` | Card branch in `buildLaunchArgs` (returns no args; the launch builds them). The apply-preset tool currently **throws "has no presets"** for card engines: step 4 replaces that. |
| `src/main/perfMonitor.ts` | Metrics path/format from the card; polled only when `format === 'prometheus'`. |

Renderer:

| File | What it holds |
|---|---|
| `src/renderer/src/utils/engineCards.ts` | `loadEngineCards()` registers cards in the renderer registry. Called at the start of `App.tsx` init and on `engine-cards-changed` (followed by a backends refresh, which is what re-renders registry readers). |
| `components/CardParamsEditor.tsx` | Generic editor: rows from the card's categories, Server block, layout editing (`LayoutSections`), `CommandPreview`, debounced save, locked-while-running banner, missing-card and not-installed banners. Widgets today: boolean toggle, boolean with `offArg` (Default/On/Off), number input, string/text input, select. |
| `components/EngineCardsSection.tsx` | Settings section: open cards folder, copy agent prompt, reload, per-card status and errors, open engine folder. |
| `ModelCard.tsx`, `CreateModal.tsx` | Mount `CardParamsEditor`; Start branch sends `cardArgs`; engine dropdown includes a missing id so it can be rebound; `seedArgsFor` returns `{}` for card engines. |

Other: `docs/engine-cards.md` (the agent guide, bundled via `electron-builder.yml` extraResources
to `resources/engine-cards.md`), `scripts/engine-card-verify.js`.

### Card format today (cardVersion 1)

```jsonc
{
  "cardVersion": 1, "id": "my-engine", "label": "My Engine", "description": "optional",
  "engine": { "folder": "MyEngine" },
  "launch": {
    "file": { "windows": "start.bat", "default": "start.sh" },   // or one string
    "argv": ["--model", "{model}", "--port", "{port}", ["--host", "{host}"], ["--api-key", "{apiKey}"], "{params}"],
    "env": { "DATA": "{engineDir}/data" },
    "ready": { "log": "^ready: ", "http": "/health" },            // optional; default http /v1/models
    "stop": { "graceMs": 8000 },
    "metrics": { "path": "/metrics", "format": "prometheus" }     // prometheus text with llama.cpp metric names
  },
  "params": { "categories": [ { "name": "...", "icon": "Zap", "commands": [ /* CommandParam */ ] } ] }
}
```

Placeholders: `{model} {modelDir} {port} {host} {apiKey} {engineDir}` and `{params}` (its own argument).
An array in `argv` is a group dropped when any placeholder in it is empty. `{params}` expands set
params in card order: boolean true sends the flag, false sends `offArg` if declared, `format:
"equals"` sends `--flag=value`, empty values send nothing. `--host` and `--api-key` live in the
Server block and feed `{host}` / `{apiKey}`; they must not be listed as params.

### Known gaps in what exists

- Never run in Electron; Windows launch quoting and the HTTP readiness probe are untested.
- The shared `ENGINES` registry is mutable and not reactive. Readers refresh only because the
  backends refresh re-renders them. A store counter would be cleaner if it misbehaves.
- The Sidebar lists only model-specific engines, so card engines do not appear there.
- The Models tab and metadata reader are GGUF-only. A card engine gets a GGUF path.
- A card with no launcher for the current OS silently shows as "not installed". Consider a warning.
- Metrics: `prometheus` only (JSON was removed from the format; Strata's JSON metrics are a gap).
- Missing-card Templates show a banner and can be rebound by changing the engine in the editor;
  there is no dedicated rebind flow.
- `scripts/strata-verify.js` run against current upstream Strata reports: three new `setup.py`
  flags not exposed (`--image-noise`, `--image-vae`, `--output`) and the `draft-vocab` choices differ.
  Not fixed because the semantics need to be known.

### Unrelated fixes made in the same zip

- Winget update loop (`src/main/buildTools.ts`, `parseWingetAvailable` in `shared/buildTools.ts`):
  a refused "no applicable upgrade" version is remembered in `build-tools-state.json`.
- Strata 0.2.16 layout (`src/main/strataLayout.ts`): sources moved into `terminal/`. Clone
  recognition and every clone-internal read now go through `strataSourceDir()`.

---

## 3. Roadmap

1. A real engine card from you, to check the format against something you use. *(your side)*
2. Strata's card as the acceptance test (see Backlog B3).
3. **Step 3: widgets, rules, blocks, presets, system context, theme** (section 4).
4. **Step 4: overrides, checkpoints, estimator, MCP and skill** (section 5).
5. Backlog: sandboxed iframe blocks, `extends`, JSON Schema, git-managed engines, CLI engines.

---

## 4. Step 3: parameter widgets, rules, blocks, presets

### 3.0 Principles

- **Data only.** No code in cards. Logic is declarative rules plus a small safe expression language.
- **One resolver.** A single pure function in `shared/` computes the effective state (args after
  defaults, forced values and overrides; hidden/disabled/locked sets; warnings; requirements). The
  editor, `buildCardArgv`, `runModelImpl` and MCP all call it, so previews and launches cannot drift.
  This is the same "single launch builder" idea as the original refactor.
- **Backward compatible.** Every new field is optional; cardVersion stays 1 unless a field changes
  meaning. Validation rejects bad cards with readable messages (sidecar errors file).
- **Theme by tokens.** Cards never carry raw colours. They use tone names; native blocks use our
  components and CSS variables. Only the sandboxed iframe (backlog) gets raw CSS, with our theme
  variables injected.

### 3.1 Expression language: `src/shared/cardExpr.ts` (new, pure)

A hand-written Pratt parser and evaluator. No `eval`, no `Function`.

Grammar: literals (number, `'str'`/`"str"`, `true`, `false`, `null`), identifiers, `.field`,
`[index or key]`, calls, unary `! -`, `* / %`, `+ -`, `< <= > >=`, `== !=`, `&&`, `||`, ternary
`a ? b : c`, parentheses.

Rules:

- Roots: `args`, `system`, `model`, `overrides`, `template`. Missing paths evaluate to `null`;
  arithmetic with `null` gives `null`; comparisons with `null` are false. Evaluation never throws.
- Flags contain dashes, so use `args["--context"]` or the helpers `arg("--context")` and
  `isSet("--context")`.
- Function whitelist: `min max round floor ceil abs clamp len has isSet arg contains startsWith
  endsWith lower upper coalesce`.
- Limits: source length at most 500 characters, at most 200 AST nodes, call depth bounded.
- Text interpolation (banners, labels): `${expr}` inside a string, so it cannot clash with the
  `{model}` launch placeholders. Literal `$` is written `$$`.
- JSON shape for a dynamic value anywhere a number/string/boolean is accepted:
  `{ "expr": "min(model.contextLength, 32768)" }`.

API:

```ts
parseExpr(src: string): { ast: Ast } | { error: string; at: number }
evalExpr(ast: Ast, ctx: CardContext): unknown
interpolate(text: string, ctx: CardContext): string
exprRefs(ast: Ast): { args: string[]; roots: string[] }   // used to validate references at load
```

Verify: precedence, associativity, ternary, null propagation, whitelist enforcement (unknown
function is a load error), size limits, interpolation escaping.

### 3.2 Context: what an expression can see

```ts
interface CardContext {
  args: Record<string, unknown>                    // the Template's args for this engine
  system: {
    os: 'windows' | 'macos' | 'linux'
    ram:  { totalMB: number; freeMB: number }
    vram: { totalMB: number; freeMB: number; gpus: { name: string; totalMB: number; freeMB: number }[] }
    cpu:  { physicalCores: number; logicalCores: number; name: string }
  }
  model: { path: string; fileName: string; sizeMB: number; arch: string | null;
           contextLength: number | null; layers: number | null; /* more from GGUF metadata */ } | null
  overrides: { port: number | null; host: string | null; apiKeySet: boolean; engine: Record<string, unknown> }
  template: { name: string; port: number }
}
```

The app already polls this data. Entry points to reuse (verify the exact shapes in code first):

- IPC `get-vram-info` (`getVramInfoImpl`, nvidia-smi and others), `get-system-ram`
  (`getSystemRamImpl`), `get-cpu-info` (`getCpuInfoImpl`), all in `src/main/ipc.ts`.
- Renderer: `src/renderer/src/hooks/useVramBudget.ts` and the store for GGUF metadata
  (`ggufMetadata[modelPath]` is what `ModelCard` reads).
- Overrides: `activeServerOverrides(baseUrlOverride, ignore)` in `renderer/src/utils/templatePort.ts`.

Build the context in two places that share one type:
`renderer/src/hooks/useCardContext.ts` (live, for the editor) and `src/main/cardContext.ts`
(for `runModelImpl` and MCP, calling the same `*Impl` functions). Keep the shape in `shared/`.

### 3.3 Widgets (extend `CommandParam`, all optional)

Today `type` is one of `boolean | number | string | select | text`. Add `widget` as a rendering
hint that must be compatible with `type`:

| `widget` | Compatible `type` | Maps to |
|---|---|---|
| `slider` | number | `HybridSlider` (props: min, max, step, allowAuto, recommended, recommendedLabel, useSpacedFormat, use2xIncrements, ladderSteps) |
| `segmented` | select (at most 4 options) | `SegmentedToggle` |
| `tristate` | boolean with `offArg` | Default / On / Off menu (already what `offArg` booleans show) |
| `password` | string | masked input |
| `textarea` | text | multi-line input |
| `file`, `folder` | string | button plus path box using an existing native dialog IPC (find it by grepping `showOpenDialog` in `ipc.ts`) |
| `list` | string | add/remove list; emitted by `repeat: true` (`--lora a --lora b`) or `join: ","` |
| `keyvalue` | text | pair editor; emitted as repeated `--set k=v` |

Slider config (maps 1:1 to `HybridSlider`):

```jsonc
{ "arg": "--context", "label": "Context", "type": "number", "widget": "slider",
  "slider": { "min": 512, "max": { "expr": "min(model.contextLength, 1048576)" },
              "step": 256, "scale": "ladder", "allowAuto": true, "recommended": 8192 } }
```

Dynamic numeric/string props (`min`, `max`, `default`, `options`, `label`, `description`) accept
`{ "expr": "..." }`. Emission extensions:

- `internal: true`: stored in `args`, shown in the UI, **never sent**. For UI-only switches that
  rules react to (an "enable speculative decoding" toggle, say).
- `repeat: true`, `join: ","` for lists.
- `valueMap: { "fast": "1", "slow": "0" }`: UI value to emitted value.
- `emit: { "expr": "args['--ctx'] * args['--parallel']" }`: emitted value computed from other values.
- `optionsBy: { "arg": "--family", "map": { "qwen": ["Q2_0","IQ3_S"], "swift": ["Q2_0"] } }`:
  dependent selects. Needed for Strata's family-to-variant dropdown.

### 3.4 Rules: `params.rules`

```ts
interface CardRule { id?: string; when: Expr; then?: Effect[]; else?: Effect[] }
type Effect =
  | { show: string[] }  | { hide: string[] }         // hidden params are also not sent
  | { enable: string[] } | { disable: string[] }     // disabled: locked in the UI, still sent
  | { force: Record<string, unknown> }               // computed value, locked, not stored in args
  | { default: Record<string, unknown> }             // used when the user has not set the param
  | { clamp: { arg: string; min?: unknown; max?: unknown } }
  | { require: string[]; message?: string }          // blocks Start until set
  | { warn: string; tone?: Tone; at?: string }       // banner; `at` is a param or section to attach to
```

Resolver (`src/shared/cardRules.ts`, new):

```ts
resolveCard(card: EngineCard, args: Record<string, unknown>, ctx: CardContext, overrides?: Record<string, unknown>): {
  args: Record<string, unknown>       // effective args: base, then engine overrides, then defaults, then forced
  hidden: Set<string>; disabled: Set<string>
  locked: Map<string, { by: 'rule' | 'override'; reason: string }>
  missing: { arg: string; message: string }[]
  warnings: { tone: Tone; text: string; at?: string }[]
}
```

Order: base args, then engine overrides (step 4), then `default` rules for unset params, then rules in
declared order, each evaluated against the state so far. Later rules see earlier forces, so there are
no cycles by construction. Stored `args` are never mutated silently; `force`/`default` exist only in
the resolved view. (The existing YaRN auto-sync in `CmdParamsEditor` writes into args; if you want
that behaviour, add a separate `{ "set": {...}, "watch": ["--arg"] }` effect that fires only on a
user edit of a watched param. Decide when first needed.)

`buildCardArgv` calls `resolveCard` first and then expands `{params}` from the effective args,
skipping hidden and `internal` params. `runModelImpl` refuses to start when `missing` is non-empty
and returns the message.

### 3.5 Blocks: composable UI from our own parts

Refactor first: extract the pieces `CardParamsEditor.renderRow` uses into
`renderer/src/components/paramParts.tsx`: `ParamRow` (label, tooltip, arg), `ToggleControl`,
`NumberControl`, `SelectControl`, `SliderControl` (wraps `HybridSlider`), `ListControl`,
`FileControl`, `Banner`. `CardParamsEditor` becomes a switch over `widget`. The same parts are what
card blocks and later custom blocks use, and Strata/llama editors can adopt them gradually.

`params.blocks` entries, in JSON:

```jsonc
"blocks": [
  { "id": "vram-low", "kind": "banner", "tone": "warning", "when": "system.vram.freeMB < 4000",
    "text": "Only ${round(system.vram.freeMB / 1024, 1)} GB of VRAM is free.", "section": "Generation", "at": "start" },
  { "id": "gpu", "kind": "stat", "label": "GPU", "value": "system.vram.gpus[0].name", "section": "Hardware" },
  { "id": "spec", "kind": "group", "label": "Speculative decoding", "enabledBy": "--spec-on", "commands": ["--draft-model", "--draft-max"] }
]
```

Kinds: `banner`, `stat`, `group` (a togglable group whose members are disabled/hidden until its
switch is on), `divider`, and later `estimate` (step 4) and `html` (backlog, sandboxed iframe).
Placement: `section` (category name) and `at: "start" | "end" | { "after": "<arg>" }`.

Integration with the existing layout editor: `LayoutSections` already takes
`sections: LayoutSection<CommandParam>[]`, each with `rows` and `blocks: [{ id, title, node }]`. Map
every card block to a `blocks` entry with id `card:<block id>`. Reordering and custom categories
the user already has then work for card blocks with no new code. `paramLayout` is keyed by engine id
and is generic over ids, so it works for card engines already.

### 3.6 Presets: `params.presets`

```jsonc
"presets": [
  { "id": "fast", "name": "Fast", "description": "Small context, one slot.",
    "args": { "--context": 8192, "--parallel": 1 }, "mode": "replace" },
  { "id": "fit",  "name": "Fit to VRAM",
    "args": { "--context": { "expr": "min(model.contextLength, floor(system.vram.freeMB / 2))" } } }
]
```

`mode: "replace"` resets every non-internal param first; `"merge"` (default) only sets the listed
ones. A small `CardPresetBar.tsx` above the rows lists them (look at how the Strata and llama
editors render their preset buttons and reuse the classes). Applying records `__lastPreset` like the
other editors. No restrictions on what a preset may set. MCP uses the same list in step 4.

### 3.7 Theme

Tone tokens: `info | success | warning | danger | muted`, mapped in one place to the app's existing
CSS variables. The editor already uses `var(--warning)`, `var(--danger)` and `var(--text-muted)`;
confirm the remaining names in the stylesheet before adding the map. Banners reuse the
`cpu-info-banner` class. No raw colour values in cards.

### 3.8 Make custom parameters work for llama.cpp and Strata too

The Commands Editor in Settings already lets a user add commands per engine folder, saved as
`commands.json` in that folder (see `getCommandsImpl` and `buildTrackedCommandsSchema`;
`TrackedBackend.extraCommands` is the same idea for forks). Plan: extend that editor's UI to author
the new widget fields and make `CmdParamsEditor` and `EngineParamsEditor` render custom/extra
commands through `paramParts`. **First read how those two editors treat custom and extra commands
today** (I did not trace it) and then decide how much is feasible; both editors are large and mostly
hard-coded.

### 3.9 Validation additions (`validateEngineCard`)

- `widget` compatible with `type`; slider props numeric or `{expr}`; `scale` in a known set.
- Every expression parses; every `args[...]` reference names a declared param; unknown functions and
  roots are errors; reference to an undeclared arg in a rule is an error.
- `force` and `default` targets exist; `show/hide/enable/disable/require` targets exist.
- Block ids unique; `section` names an existing category; `after` names an existing arg.
- Preset arg keys exist; preset values type-check against the param type when literal.
- `internal` params must not also set `offArg`/`format`.
- Warnings (not errors) for unknown keys, as today.

### 3.10 Order of work, with a checkpoint after each

1. `cardExpr.ts` plus tests in `engine-card-verify.js`.
2. `cardRules.ts` (`resolveCard`), wire `buildCardArgv` and `runModelImpl` (no UI change). Tests:
   defaults, force, hide, require, clamp, ordering, null handling.
3. `cardContext` builders (main and renderer) and the shared type.
4. Extract `paramParts.tsx`; add widgets to `CardParamsEditor`.
5. Rules-driven UI: hidden, disabled, locked badge, warnings, Start blocked on `missing`.
6. Blocks and the `LayoutSections` mapping; presets bar.
7. Validation additions, `docs/engine-cards.md` update, example cards in the docs.
8. Built-in engines' custom parameters (3.8), after reading the editors.

Acceptance: a card exercising every widget, a rule per effect, a block of each kind and two
presets loads without errors, renders, resolves identically in the editor preview and in the
launched argv, and produces a clear sidecar errors file when any part is wrong.

---

## 5. Step 4: overrides, checkpoints, estimator, MCP and skill

### 4.1 Engine override sections declared in the card

Today `OverridesView.tsx` has global sections (Base URL Override, Model Loading Guardrails, Engine
settings with per-engine tabs for llama.cpp and Strata, KV Cache Checkpoints, Parallel Inference,
Model Defaults). A card engine's tab currently shows "has no global overrides".

Card format:

```jsonc
"overrides": {
  "sections": [
    { "id": "perf", "title": "Performance", "icon": "Zap", "fields": [
      { "id": "parallel", "label": "Parallel requests", "type": "number", "min": 1, "max": 8,
        "description": "Forces this on every Template of this engine.",
        "applyTo": "--parallel" },
      { "id": "fa", "label": "Flash attention", "type": "boolean", "applyTo": "--flash-attn" }
    ] }
  ]
}
```

- Field types reuse the widget set from step 3, via `paramParts`.
- `applyTo` names a declared param. Optionally `value: { "expr": ... }` to compute what is forced.
- **Storage:** a new settings field `engineOverrides: Record<engineId, Record<fieldId, value | null>>`,
  `null` or absent meaning "no override". Add to `AppSettings` in `shared/types.ts`, default `{}` in
  `loadSettings`, and persist with the existing settings save. Strata's `parallelOverride` (around
  `types.ts` line 424, applied to every Strata Template) is the precedent to copy.
- **Precedence:** engine override > `force` rule > Template value > `default` rule > engine default.
  `resolveCard` takes the override map as its fourth argument (see 3.4), and marks those params
  `locked` with `by: 'override'` so the editor shows a "Set by Overrides" note, the same way it does
  for the global port override today (`PreviewToken.overridden`).
- **UI:** a `CardOverridesPanel.tsx` rendered by the card engine's tab in `OverridesView`; the tab
  label count `activeOverrides[id]` counts non-null fields.
- Main side: `runModelImpl` and MCP load `engineOverrides` from settings and pass them to
  `resolveCard`, so UI and launch agree.

### 4.2 Mapping the app's global overrides onto card params

Base URL Override is already wired through `{port}` / `{host}` / `{apiKey}`. For the others, the
card declares which of its params each one drives:

```jsonc
"overrides": { "global": { "parallel": "--parallel", "threads": "--threads" } }
```

First read what the global Parallel Inference, Model Defaults and Model Loading Guardrails settings
hold and how llama.cpp applies them in `runModelImpl` (search for `parallel`, `defaultsFor`,
`guardrail`); I did not trace them. Apply a mapped global override at the same precedence slot as an
engine override. Unmapped global overrides are ignored for that engine.

### 4.3 KV cache checkpoints via the card

The global setting turns checkpoints on; the card says how to trigger one. Today llama.cpp only:
`runModelImpl` force-adds `--slot-save-path` (around lines 3440 to 3455), and `saveSlotCheckpoint` /
`restoreSlotCheckpoint` (around lines 1925 to 2010) call `POST /slots/0?action=save|restore` through
`postJsonLocal`.

```jsonc
"checkpoints": {
  "enable": { "arg": "--slot-save-path", "value": "{checkpointDir}" },
  "save":    { "method": "POST", "path": "/slots/0?action=save",    "body": { "filename": "{filename}" } },
  "restore": { "method": "POST", "path": "/slots/0?action=restore", "body": { "filename": "{filename}" } }
}
```

Plan: generalise the two functions to take a request spec with `{filename}` and `{checkpointDir}`
placeholders; llama.cpp's behaviour becomes the default spec so nothing changes for it; replace the
`isLlama` guards around checkpointing with "the engine has a checkpoint spec". Set
`caps.slotCheckpoints` from the card. The existing global settings UI needs no change.

### 4.4 Memory estimator wiring (GGUF only)

`useVramBudget` (renderer) holds the llama estimator (weights, KV from the GGUF's attention
geometry and the chosen cache types, compute buffer, overhead). Also search `main/ipc.ts` and
`main/mcpControl.ts` for where the guardrail uses it. Card side:

```jsonc
"memory": { "estimator": "llama",
  "map": { "contextLength": "--context", "cacheTypeK": "--cache-type-k", "cacheTypeV": "--cache-type-v",
           "parallel": "--parallel", "gpuLayers": "--n-gpu-layers" } }
```

Plan: refactor the estimator input to a plain object so a card's `map` can fill it (values read from
the resolved args); set `caps.vramEstimator = 'llama'` when the card declares it, `'none'` otherwise;
refuse non-GGUF models for that estimator (the Models tab is GGUF-only anyway); add the `estimate`
block kind from 3.5 to show the result. A custom formula is out of scope unless the expression
language proves enough. The estimate is only as accurate as the engine resembles llama.cpp, so say
so in the guide.

### 4.5 MCP and the skill

Files: `src/main/mcpControl.ts` (`TOOL_DEFS`, from about line 1583: the edit tool with a `changes`
object, the preset tool, the template/backends listing tools), `src/main/mcpServer.ts`
(`registerTool`, `zodShapeFor(tool.params)`), `src/main/skillGenerator.ts` (`buildSkillMd(mcp)`,
`writeSkillFiles`, `removeSkillFiles`).

- **Parameter listing.** Add a tool (for example `list_engine_parameters`) or extend the existing
  inspection tool to return, per loaded card: id, label, categories with arg, type, min/max/options,
  default, plus presets, override fields and the launch placeholders in use. Built from
  `listLoadedCards()`.
- **Edit tool.** For card engines, validate `changes` keys against the card schema, coerce by param
  type, and return the list of valid args on an unknown key. Find where llama/Strata keys are
  validated today and mirror it.
- **Preset tool.** Replace my temporary throw in `toolApplyParametersPreset` with the card's
  `presets` (accept id or name).
- **Skill file.** Add a generated "Custom engines" section to `SKILL.md` listing each card's
  parameters and presets, and rewrite the skill files when cards change (hook `engine-cards-changed`;
  find where `writeSkillFiles` is currently triggered, only when MCP is enabled).
- **Harnesses.** Check `src/main/harnesses.ts` and `shared/harnessConfig.ts` for assumptions about
  llama's `--alias` and model naming that a card engine would not satisfy.

### 4.6 Order of work

1. `engineOverrides` storage and `resolveCard` precedence plus tests.
2. `CardOverridesPanel` and the `OverridesView` tab; locked-by-override note in the editor.
3. Global-override mapping (4.2) after reading the settings code.
4. Checkpoint generalisation (4.3), verifying llama.cpp behaviour is unchanged.
5. Estimator input refactor and `estimate` block (4.4).
6. MCP tool, edit validation, presets, skill section (4.5).
7. Guide and verify-script updates for everything above.

---

## 6. Backlog

- **B1. Sandboxed iframe blocks** (`kind: "html"`). Fully custom parameters. Runs in a sandboxed
  iframe (no IPC access, so a bug or hostile card cannot reach `window.api`), receives our theme CSS
  variables, and talks to the app through a small `postMessage` API: get and set values, read the
  system context. A crash stays inside the frame.
- **B2. `extends`.** Most custom engines will be llama.cpp forks. Two options to discuss before
  building: (a) a card with `extends: "llama.cpp"` that is a distinct engine id inheriting llama's
  editor and logic, which needs every `engine === 'llama.cpp'` branch to ask for a *base engine*
  instead; (b) a card that only adds parameters to an existing llama.cpp backend key, like
  `extraCommands` today. (b) is much smaller. Built-in forks currently using `extraCommands` could
  move onto cards either way.
- **B3. Strata card as the acceptance test.** Write a Strata card as a test fixture (do not
  activate it; the hard-coded Strata path stays), then a script that compares `buildCardArgv`
  against the real Strata argv builder over a matrix of inputs. Expected gaps: data folder passing,
  family and variant dropdowns (`optionsBy`), the memory estimator, ready regex
  `^ready: https?://`, grace 8000/20000, and Strata's JSON metrics (not supported by the card
  format today). Only migrate Strata onto its card once the commands match.
- **B4. JSON Schema file** for agents (`resources/engine-card.schema.json`) kept in step with
  `validateEngineCard`, with a test that sample cards pass both.
- **B5. Engine install management.** Cards currently describe local folders. Possible later:
  `engine: { repo, install: "git" }` reusing `TrackedBackend` and the git engine machinery, so XLM
  can clone and update a card's engine.
- **B6. CLI (non-HTTP) engines and non-GGUF models.** Needs changes to the Models tab, readiness,
  chat window and harnesses.
- **B7. Sidebar listing and a dedicated missing-engine rebind flow.**
- **B8. `cardVersion` migrations** when the format first changes meaning.
- **B9. Strata upstream sync:** expose `--image-noise`, `--image-vae`, `--output`; update the
  `draft-vocab` choices in `resources/commands.strata.json` after confirming their meaning.
- **B10. Card-level Windows warnings,** for example when no launcher is declared for the current OS.

---

## 7. Open questions for the next session

1. `set` effects (write into args on a user edit) versus force/default only: needed for any
   behaviour like the YaRN auto-sync?
2. For built-in engines (3.8): how far to go, given how hard-coded `CmdParamsEditor` is?
3. `extends`: option (a) or (b) in B2?
4. Should a preset be able to carry a full layout choice, or only arguments?
5. Should `engineOverrides` be per-engine only, or also per-Template opt-out like
   `__ignoreBaseUrlOverride`?

---

## 8. Quick reference

Commands:

```sh
npx tsc --noEmit -p tsconfig.node.json
npx tsc --noEmit -p tsconfig.web.json
node scripts/engine-card-verify.js
node scripts/strata-verify.js [path/to/Strata]
npx electron-vite build
```

Where to start reading:

- Launch path: `runModelImpl` in `src/main/ipc.ts` (search `const card =`).
- Card loading: `src/main/engineCards.ts`; validation and argv: `src/shared/engineCard.ts`.
- Editors: `CardParamsEditor.tsx` (new), `EngineParamsEditor.tsx` (Strata, closest model for presets
  and the Server block), `CmdParamsEditor.tsx` (llama.cpp, about 2.8k lines).
- Layout editing: `LayoutSections.tsx`, `shared/paramLayout.ts`.
- Overrides: `OverridesView.tsx`, `renderer/src/utils/templatePort.ts`.
- MCP and skill: `mcpControl.ts` (`TOOL_DEFS`), `mcpServer.ts`, `skillGenerator.ts`.
- Strata layout fix: `src/main/strataLayout.ts`.
