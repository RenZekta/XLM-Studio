# XLM Studio
<p align="center">
  <img src="https://img.shields.io/github/v/release/RenZekta/XLM-Studio?style=flat-square&color=black&label=version" alt="Latest Version" />
  <img src="https://img.shields.io/badge/Electron-191970?style=flat-square&logo=Electron&logoColor=white" alt="Electron" />
  <img src="https://img.shields.io/badge/React-20232A?style=flat-square&logo=react&logoColor=61DAFB" alt="React" />
  <img src="https://img.shields.io/badge/TypeScript-007ACC?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript" />
  <img src="https://img.shields.io/badge/Vite-B73BFE?style=flat-square&logo=vite&logoColor=FFD62E" alt="Vite" />
</p>

<br/>

XLM Studio is a fast, native desktop interface for discovering, downloading, configuring, and serving local Large Language Models with llama.cpp-compatible backends. It strips away the friction of command-line execution and manual VRAM math, giving you a single workspace that goes from "found a GGUF on Hugging Face" to "running server with sane defaults" in a couple of clicks.

XLM Studio is a fork of [Hexllama](https://github.com/andersondanieln/hexllama), heavily extended with many features, including a memory-aware configuration engine: it reads a model's actual GGUF metadata (architecture, layer count, KV-cache geometry, MoE expert layout, quantization, speculative-decoding tensors, native chat template) and uses it to compute real VRAM/RAM budgets and recommend settings, instead of asking you to guess.

<!-- NOTE TO SELF: replace the screenshots below with current ones once the new
     UI has settled — several older screenshots (model-hub, model-download,
     my-templates, settings) are from before this fork's changes and may not
     reflect the current look. Every "SCREENSHOT NEEDED" comment inline below
     marks a spot for a new one; the main ones still missing are: the Quick/
     FULL AUTO/Clear preset switch + parameter diff highlighting, the Free
     VRAM recommendation panel, the Monitoring tab, the Overrides tab, and
     the reworked Speculative Decoding block (tier picker + candidate list +
     stackable n-gram modifiers). -->

## Features

**Integrated Model Hub**

Search Hugging Face directly within the application. Browse repositories, view file details, and download GGUF models with a single click without ever opening a browser.

<img width="1258" height="780" alt="image" src="https://github.com/user-attachments/assets/4501f8fe-5b3a-4842-9d4b-2f2acfaab906" />



**Smart Download Manager**

Pause, resume, or cancel large model downloads reliably. You can also paste direct GGUF links. When a download completes, XLM Studio automatically generates an execution template with recommended settings tailored to the model's architecture and your hardware. If you prefer to interact with HF CLI, I have a project to greatly improve the HF CLI experience and control over it: https://github.com/RenZekta/HF-CFD


**Automatic Metadata Extraction**

Every detected model gets its GGUF metadata (architecture, layer/expert counts, context length, quantization, KV-cache geometry, chat template, speculative-decoding tensors) extracted and cached the moment it's discovered — scanned in parallel at launch, with a single consolidated "Extracting model metadata" notification (hover it to see which models are still being processed) instead of one popup per model. A "Reextract model data" button in the Models tab lets you force a clean re-scan of everything, e.g. after replacing a file in place or updating the app.

<img width="1248" height="790" alt="image" src="https://github.com/user-attachments/assets/8594dcd9-53c9-4cd0-b900-ff0faf5e2141" />


**Memory-Aware VRAM/RAM Budget Calculator**

Every template shows a live Free VRAM breakdown (model weight, KV cache, compute buffer, runtime overhead) computed from the model's actual attention geometry — including MLA, grouped-query attention, sliding-window attention, and hybrid SSM/attention architectures (e.g. Qwen3-Next-style models where only a fraction of layers carry a KV cache). It tells you, in plain language:
- **Dense models:** how many of the model's layers fit on your GPU at the selected context, and — separately — how much context you'd get if you kept (ideally) all layers on the fastest tier available.
- **MoE models:** how many layers need to be offloaded to (or forced onto CPU from) VRAM to fit the selected context, honoring whichever MoE offload strategy you've picked.

Each recommendation line has a small apply button to commit it directly.

MoE:
<img width="540" height="219" alt="image" src="https://github.com/user-attachments/assets/e7cfe713-ecf8-4c72-aea8-3bb8ea1ef3ac" />

Dense:
<img width="531" height="227" alt="image" src="https://github.com/user-attachments/assets/ed5b3043-dca3-4e94-803a-c560ecc4c41e" />


**Three-Way Configuration Presets**

Every template has a **Quick** / **FULL AUTO** / **Clear** switch:
- **Quick** applies good fast-starting engine baseline (threads, batch sizes, flash attention, KV cache quantization, speculative decoding drafting parameters) and, for Dense models max GPU layers so llama.cpp will offload as much as it can; MoE models are left on llama.cpp's auto offloading (it's good for MoE). Context defaults to the model's native context (capped at 32K for Dense for a reasoble baseline; for MoE set to max, since MoE tolerates RAM-resident layers well).
- **FULL AUTO** starts from the same baseline but hands context and GPU-layer placement over to llama.cpp's own `--fit` auto-sizing. If you need more space for context or GPU offloading, turn off Multimodal Projector and Speculative Decoding, and you'll get the most out of your available VRAM.
- **Clear** wipes engine settings back to nothing, without touching your sampling parameters (temperature, top-p, top-k, min-p, penalties) — those are considered separate, per-preference settings that no engine preset should ever silently overwrite.

Parameters that differ from the currently-selected preset (or, for sampling values, from your starred sampling preset) are highlighted with a reset-to-default button.

**Visual Command Editor**

No need to memorize execution flags or save your commands in an endless unreadable diary. Edit backend-specific commands through a structured user interface, with a "Common" view for everyday parameters and a "Full" view for everything the backend schema exposes. Toggle booleans, set limits on numerical inputs, and define default parameter values. You can still input commands directly in the Import section.

<img width="327" height="123" alt="image" src="https://github.com/user-attachments/assets/6bff1dd2-3759-470a-8468-d1db2ee01cd5" />


**Speculative Decoding — full tier system, auto-detected**

XLM Studio recognizes five tiers of speculative decoding, from best to most basic, and automatically selects the highest tier actually available for a model:

| Tier | Method | Detected via |
|---|---|---|
| 5 | **DFlash2** | sidecar `.gguf` filename containing `dflash`/`dflash2` |
| 4 | **DSpark2** | sidecar filename containing `dspark`/`dspark2` |
| 3 | **EAGLE3** | sidecar filename containing `eagle` |
| 2 | **Draft Model** | sidecar filename containing `draft`/`mtp` |
| 1 | **Native MTP** | embedded `nextn`/MTP tensors inside the model's own GGUF metadata |

Sidecar draft/speculative-head files are detected the same way multimodal projectors are — scanned in the model's own folder — and excluded from the Model File picker so they don't clutter it. Every detected candidate (not just the winner) is shown, so you can manually switch to a different tier or a different sidecar file at any time; `--spec-draft-n-max` / `--spec-draft-n-min` / `--spec-draft-p-min` are treated as each tier's own tuned preset (with the usual diff-highlighting + reset button when you edit them). The two stackable n-gram modifiers (`ngram-map-k4v`, `ngram-mod`) can be layered on top of any primary method, or used on their own.

<img width="503" height="306" alt="image" src="https://github.com/user-attachments/assets/db72733c-acc5-4d46-85f6-2912c5f02215" />

**Multimodal Projector Auto-Detection**

Multimodal projector (mmproj) files are detected and auto-attached (configurable to default off in Settings, to save memory when you don't need vision). 
<img width="1013" height="408" alt="image" src="https://github.com/user-attachments/assets/fddb0a4d-c09c-4431-8936-7c5c17559336" />

**Chat Template Auto-Detection**

A model's native Jinja chat template, if present, is detected and shown for reference/editing without ever being silently overwritten.
<img width="469" height="400" alt="image" src="https://github.com/user-attachments/assets/a99553c1-8081-4eac-9c3d-26275a6d1ee3" />


**Monitoring**

A dedicated tab tracks real generation speed and prompt-processing (prefill) speed for every running template, by polling llama-server's own `/metrics` endpoint (since Chat UI mode opens in your default browser, this is the only way to see live performance without proxying every request). Switch between active sessions and saved session history, compare multiple sessions side by side on the same charts, export/import session data as JSON, and configure how many past sessions to keep.

<img width="2543" height="1198" alt="image" src="https://github.com/user-attachments/assets/79ce5b75-ead2-4306-a637-6c0ea3cb0b5b" />


**Overrides**

Global settings that apply across every template in one place: the Base URL override, per-model defaults (AutoFit context minimum, MoE offload strategy, CPU-threads recommendation percentage, mmproj auto-enable, and more), and a Parallel Inference override that can force `--parallel`/`-np` to a single value for all models, or independent values for Dense vs. MoE.

<img width="1261" height="791" alt="image" src="https://github.com/user-attachments/assets/a6824c82-f195-44da-b5ce-1551c0c4ef63" />

**YaRN Context Scaling**

Need more context than a model's native window? Turn on Automatic YaRN scaling control (per-template, or globally as an "upscale to AutoFit" override) and XLM Studio computes and applies `--rope-scaling yarn`, `--rope-scale`, and `--yarn-orig-ctx` for you as you move the context slider — no manual RoPE math required.

<img width="503" height="269" alt="image" src="https://github.com/user-attachments/assets/90ca473e-1153-49c3-90cd-06c33acf2ffb" />


**Command Preview**

Every template shows a live preview of the exact `llama-server` command that will run — including values that only get resolved at launch time (the AutoFit context-override floor, `--fit`/`--no-webui` flags, the default port), clearly marked when they differ from what's literally saved in the template. Switch to the stacked view to see it as one flag per line instead of a single long string.

<img width="515" height="276" alt="image" src="https://github.com/user-attachments/assets/1da56562-01ef-4954-be6a-befb9e7b9901" />


**Template-Based Execution**

Save your configurations as reusable templates. Run multiple models simultaneously on different ports without conflict. Launch them in "Chat UI" mode to automatically open the built-in llama.cpp web interface, or "API Only" mode to serve them silently in the background.

<img width="1257" height="690" alt="image" src="https://github.com/user-attachments/assets/ea45d530-cb5e-4321-b38f-37e16f47479c" />


**Version and Backend Management**

Running cutting-edge models sometimes requires different builds of llama.cpp (or compatible forks, e.g. TurboQuant-enabled builds). XLM Studio lets you maintain and seamlessly switch between multiple backend binaries, and can check upstream repositories for new releases and download/extract them straight from the settings panel.

<img width="806" height="733" alt="image" src="https://github.com/user-attachments/assets/8fb6f00f-2099-4b64-94df-437006f39fbf" />


**Persistent Logs**

Server logs are collected in the background for the life of the app — switching tabs no longer loses in-flight output — and stay available until you clear them manually or close the app.

<img width="2129" height="777" alt="image" src="https://github.com/user-attachments/assets/113dfc32-4bc4-4e3f-883b-bbbcde0df009" />


## Installation

### Download the Release
The fastest way to get started is to use the pre-compiled installer.

1. Navigate to the [Releases](https://github.com/RenZekta/XLM-Studio/releases) page.
2. Download the installer for your operating system.
3. Run the installer and launch XLM Studio.

### Run Locally
If you want to build from source or modify the project, you can easily run the development environment.

Prerequisites:
- Node.js 18 or higher
- npm


Clone the repository in desired destination. Copy the destination.
```
git clone https://github.com/RenZekta/XLM-Studio
```

Run Powershell 7 as an administrator (open folder, install dependencies, build and package installer
```
cd X:\(your chosen destination)\XLM-Studio && npm install && npm run build && npm run package
```

## Roadmap (hexllama + XLM-Studio)

### Phase 1: Core Foundation (Completed)
- [x] **Integrated Model Hub**: Hugging Face search & download direct from the app.
- [x] **Smart Download Manager**: Pause/resume/cancel, auto-template generation based on hardware & quant level.
- [x] **Template-Based Execution**: Run multiple models on different ports, reusable configuration templates.
- [x] **Version and Backend Management**: Download and switch between different versions of `llama.cpp`-compatible binaries directly.
- [x] **Visual Command Editor**: Graphical UI for configuring server parameters instead of terminal flags.

### Phase 2: Memory-Aware Configuration (Completed)
- [x] **VRAM/RAM Budget Calculator**: Architecture-aware KV-cache and weight-memory estimation (MLA, GQA, sliding-window, hybrid SSM/attention), with live Dense/MoE-specific recommendations.
- [x] **Speculative Decoding — 5-tier system**: Auto-detects and prioritizes the best available method per model — Native MTP, Draft Model, EAGLE3, DSpark2, and DFlash2 — plus stackable n-gram modifiers (`ngram-map-k4v`, `ngram-mod`), each combinable with any primary method.
- [x] **TurboQuant Support**: KV-cache quantization support tuned for TurboQuant-enabled backends.
- [x] **Unified KV Cache**: `--kv-unified` on by default, so `--parallel` sequences share a single KV buffer instead of splitting the context window between them.
- [x] **Three-Way Presets**: Quick / FULL AUTO / Clear, with preset-relative diff highlighting that never touches sampling parameters.
- [x] **YaRN Context Scaling**: Automatic RoPE/YaRN scaling to extend usable context past a model's native window.
- [x] **Command Preview**: Live, launch-accurate preview of the actual command that will run, with a stacked (one-flag-per-line) view option.
- [x] **Monitoring**: Real-time and historical generation-speed/prefill-speed tracking per session, with comparison, export/import, and configurable history retention.
- [x] **Overrides**: Centralized global overrides — Base URL, Model Defaults, and per-architecture (Dense/MoE) Parallel Inference control.

### Phase 3: Enhanced Inference & Native UI (Short to Mid-Term)
- [ ] **Built-in Chat Interface**: Native chat client to interact with models directly within XLM Studio without launching external browser tabs — would also let Monitoring see real per-request data instead of polling `/metrics`. Optional goal, it works just fine with a separate chat window too.
- [ ] **Multi-Language Support**: Complete internationalization (i18n) to support languages beyond English.

### Phase 4: Multi-Backend & Advanced Engines (Long-Term)
- [ ] Optional **Alternative Backend Integration**: Expand support beyond `llama.cpp` to include:
  - **MLX**: Native backend for Apple Silicon optimized performance.
  - **vLLM / ExLlamaV2**: Support for high-throughput and GPU-optimized engines.

## Acknowledgements

XLM Studio is built on top of the foundation laid by [Hexllama](https://github.com/andersondanieln/hexllama).
