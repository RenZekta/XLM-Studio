![](assets/github-banner.png)
<p align="center">
  <img src="https://img.shields.io/github/v/release/RenZekta/XLM-Studio?style=flat-square&color=black&label=version" alt="Latest Version" />
  <img src="https://img.shields.io/badge/Electron-191970?style=flat-square&logo=Electron&logoColor=white" alt="Electron" />
  <img src="https://img.shields.io/badge/React-20232A?style=flat-square&logo=react&logoColor=61DAFB" alt="React" />
  <img src="https://img.shields.io/badge/TypeScript-007ACC?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript" />
  <img src="https://img.shields.io/badge/Vite-B73BFE?style=flat-square&logo=vite&logoColor=FFD62E" alt="Vite" />
</p>

<br/>

XLM Studio is a fast, native desktop interface for discovering, downloading, configuring and serving local LLMs with llama.cpp-compatible engines (and Strata, a model-specific engine). Run any llama.cpp compatible model with fastest settings in a couple of clicks.

It is a fork of [Hexllama](https://github.com/andersondanieln/hexllama), extended with a lot of features, main being memory-aware configuration engine: it reads a model's real GGUF metadata (architecture, layers, KV-cache geometry, MoE layout, quantization, speculative-decoding tensors, chat template) to compute VRAM/RAM budgets and recommend settings, so you don't have to guess loading parameters.

## Features

**Template-Based Execution**

Save configurations as reusable templates and run several models at once on different ports. Launch in "Chat UI" mode (opens the llama.cpp web interface) or "API Only" mode (serves silently in the background).

<img width="1319" height="766" alt="image" src="https://github.com/user-attachments/assets/12dee642-d70f-4ab3-ab7f-0e054871ac44" />

**Integrated Model Hub**

Search Hugging Face, browse repositories and file details, and download GGUF files without leaving the app. Model split into numbered shards one entry.

<img width="1258" height="780" alt="image" src="https://github.com/user-attachments/assets/4501f8fe-5b3a-4842-9d4b-2f2acfaab906" />

**Smart Download Manager**

Pause, resume or cancel large downloads, or paste direct GGUF links. For a CLI alternative see [HF-CFD](https://github.com/RenZekta/HF-CFD).

**Automatic Metadata Extraction**

GGUF metadata is extracted and cached as soon as a model is discovered, scanned in parallel at launch, with one consolidated "Extracting model metadata" notification.

<img width="472" height="203" alt="image" src="https://github.com/user-attachments/assets/e4be6d3f-de6f-484f-8f5a-cf1555895c9c" />

**Memory-Aware VRAM/RAM Budget Calculator**

Every template shows a live Free VRAM breakdown (weights, KV cache, compute buffer, runtime overhead) computed from the model's actual attention geometry: MLA, grouped-query, sliding-window and hybrid SSM/attention. Each recommendation has an apply button.

- **Dense models:** how many layers fit on your GPU at the selected context, and how much context you get with all layers on the fastest memory.
- **MoE models:** how many layers must be offloaded to (or forced onto) the CPU to fit the selected context.

Dense:

<img width="490" height="303" alt="image" src="https://github.com/user-attachments/assets/ba8e1a8a-eb8f-42d1-be2a-6f42e2140dbd" />

MoE:

<img width="490" height="303" alt="image" src="https://github.com/user-attachments/assets/2be057e2-cfe4-44e0-b770-af82369aaf5f" />

**Three-Way Configuration Presets**

Every template has a **Quick** / **FULL AUTO** / **Manual** switch:

- **Quick:** fast-starting baseline (threads, batch sizes, flash attention, KV cache quantization, drafting parameters). Dense: max GPU layers, context set to the native size capped at 32K. MoE: llama.cpp's own offloading, context set to max.
- **FULL AUTO:** same baseline, but context and GPU-layer placement are left to llama.cpp's `--fit`. Turn off Multimodal Projector and Speculative Decoding to free more VRAM.
- **Manual:** clears engine settings. Sampling parameters (temperature, top-p, top-k, min-p, penalties) are never touched by any preset.

Common shows only the most impactful parameters (LM Studio style), Full shows everything. Parameters that differ from the selected preset (or sampling values that differ from your main sampling preset) are highlighted, with a reset button.

<img width="330" height="122" alt="image" src="https://github.com/user-attachments/assets/aaf946c7-3f40-4bbb-a339-fb4944590d53" />

**Visual Command Editor**

Edit engine-specific commands through a structured UI with Common and Full views. Toggle booleans, set limits on numeric inputs and define defaults. Raw commands can still be pasted in the Import section.

<img width="480" height="712" alt="image" src="https://github.com/user-attachments/assets/b6c514ea-b6cd-46ee-bd2e-e1fba93e74c0" />

**Speculative Decoding: five tiers, auto-detected**

The best available method is selected automatically:

| Tier | Method | Detected via |
|---|---|---|
| 5 | **DFlash2** | sidecar `.gguf` filename containing `dflash`/`dflash2` |
| 4 | **DSpark2** | sidecar filename containing `dspark`/`dspark2` |
| 3 | **EAGLE3** | sidecar filename containing `eagle` |
| 2 | **Draft Model** | sidecar filename containing `draft`/`mtp` |
| 1 | **Native MTP** | embedded `nextn`/MTP tensors in the model's own GGUF metadata |

Sidecar files are scanned in the model's folder (like mmproj files). All candidates are listed, so you can switch tier or file at any time. `--spec-draft-n-max`, `--spec-draft-n-min` and `--spec-draft-p-min` are tuned per tier. The n-gram modifiers `ngram-map-k4v` and `ngram-mod` can be stacked on any method or used alone.

<img width="503" height="306" alt="image" src="https://github.com/user-attachments/assets/db72733c-acc5-4d46-85f6-2912c5f02215" />

**Multimodal Projector Auto-Detection**

`mmproj` files are detected and auto-attached (this can default to off in Settings to save memory). If a model folder has several, they are ranked by precision (bf16 first) and the best is used; pick another from the Detected projector dropdown.

<img width="1013" height="408" alt="image" src="https://github.com/user-attachments/assets/fddb0a4d-c09c-4431-8936-7c5c17559336" />

**Chat Template Auto-Detection**

A model's native Jinja chat template is detected and shown for reference or editing, and never silently overwritten.

<img width="469" height="400" alt="image" src="https://github.com/user-attachments/assets/a99553c1-8081-4eac-9c3d-26275a6d1ee3" />

**Monitoring**

Tracks decode and prefill speed for every running template by polling llama-server's `/metrics` endpoint (Chat UI opens in your browser, so this is the only way to see live performance without proxying requests). Plot speed against context size or against time, switch between live and saved sessions, compare several sessions on one chart, export/import sessions as JSON, and set how many past sessions to keep.


<img width="2552" height="1184" alt="image" src="https://github.com/user-attachments/assets/34e69e37-6c2f-423c-bdc2-68984506ab82" />

**Overrides**

Global settings applied across all templates: the Base URL override, per-model defaults (AutoFit context minimum, MoE offload strategy, CPU-thread recommendation, mmproj auto-enable and more), and a Parallel Inference override that forces `--parallel`/`-np` to one value for all models, or separate values for Dense and MoE.

<img width="806" height="984" alt="image" src="https://github.com/user-attachments/assets/47c55a63-3063-4982-82aa-df8302c55a42" />

**YaRN Context Scaling**

Turn on Automatic YaRN scaling (per template, or globally as an "upscale to AutoFit" override) and `--rope-scaling yarn`, `--rope-scale` and `--yarn-orig-ctx` are computed as you move the context slider. They are omitted at or below the native context and when turned off.

<img width="503" height="269" alt="image" src="https://github.com/user-attachments/assets/90ca473e-1153-49c3-90cd-06c33acf2ffb" />

**Command Preview**

A live preview of the exact `llama-server` command, including values resolved only at launch (AutoFit floor, `--fit`/`--no-webui`, default port), marked when they differ from what is saved. A stacked view shows one flag per line.

<img width="503" height="338" alt="image" src="https://github.com/user-attachments/assets/252df95b-d6f1-4c6e-953b-17744c109a34" />

**Version and Engine Management**

Maintain several engine builds and switch between them. XLM Studio checks upstream repositories for new releases and downloads/extracts them from Settings.

[atomic-llama-cpp-turboquant](https://github.com/AtomicBot-ai/atomic-llama-cpp-turboquant) and [BeeLlama.cpp](https://github.com/Anbeeld/beellama.cpp) are built in. Their fork-only parameters (KVarN and extra low-bit KV cache types, KV precision tail, DFlash depth controller, reasoning loop guard) only appear for templates running on that fork and are dropped if the template moves to a backend without them.

<img width="2553" height="1388" alt="image" src="https://github.com/user-attachments/assets/128c738d-de86-4906-8752-f5a7f255820d" />

**Build from Source and branches**

Each engine in Settings > Engine Tracker has its own install method, switched with the download or hammer button beside its GitHub link: **Download Binary** (default) or **Build from Source**, which clones the repo and compiles `llama-server` locally. The button turns blue when the other method already has a build installed.

- **Tools:** a build needs git, CMake, a C++ compiler and the CUDA, Vulkan or ROCm SDK for the chosen backend. If any is missing, the button becomes **Install tools and build** (winget on Windows, Homebrew on macOS, apt/dnf/pacman/zypper on Linux with a polkit prompt). CUDA on most Linux distributions and the Xcode command line tools must be installed manually; the panel says how.
- **ROCm:** choose your GPU and the app fetches AMD's SDK into `.sdk/rocm` (Tarball by default, or pip), with no admin rights and nothing added to the system PATH.
- **CUDA:** **CUDA (newest)** and **CUDA 12.4** (for Maxwell, Pascal and Volta GPUs that CUDA 13 dropped) install side by side. On Windows the app downloads and installs the toolkit itself.
- **Naming and updates:** builds are named after the release tag of their commit (`b10298-2.1.0-src`) and installed like downloaded ones. **Update & Rebuild** pulls the branch and rebuilds; **Rebuild** recompiles as checked out (use e.g. after changing CMake options or the SDK). A finished build replaces the older downloaded binary of that backend, and the reverse.
- **Per-OS trees:** source and build trees live in `<repo>/.work/<os>/`, so an engines folder shared by several systems (dual boot) works; installed builds are shared.
- **Failures:** stale CMake state is repaired and retried automatically (never for compile errors). Build and tool-install progress appears in the Logs tab.

A link to another branch (`https://github.com/owner/repo/tree/branch` or `owner/repo@branch`) tracks it as its own engine, listed separately in the sidebar, Template editor and Installed Engines. Branches are always built from source.

**Strata (model-specific engine)**

[Strata](https://github.com/Niko1221/Strata) runs Qwen3.8-Flash-Next on consumer GPUs by keeping the MoE weights in RAM. One instance per OS for separate engines.

- **Engine, Repo, Backend:** every template picks an Engine (llama.cpp or Strata), then a repo and, where there are several, a GPU backend. Values are kept per engine when you switch back and forth.
- **Automatic model validation:** every GGUF is fingerprinted and checked against each installed Strata engine (forks included) using that engine's own file table, so new models need no app update. The Models tab shows the verdict, and new templates for a recognised file start on Strata. Model Family and Variant are dropdowns autofilled from the engine itself.
- **Presets and editor:** like the llama.cpp editor, minus Manual. FULL AUTO leaves every value to Strata's recommendation; Quick carries over context size and KV precision. Fields show the value Strata will actually use, with a Common/Full switch, the context slider, launch preview and a memory estimate (KV cache, experts on GPU, RAM).
- **Image input:** Automatic by default (Strata's own behavior); choose no, yes, gpu or cpu.
- **Drafter:** Auto, MTP, DFlash2 or Off, in Speculative Decoding. XLM writes the choice to the model's run config before each launch and fetches DFlash2 drafter files if needed.
- **Setup flags:** every applicable `setup.py` flag is editable. XLM sets port, host, API key, data folder, GGUF folder, `--yes` and `--no-browser` itself and never sends flags that don't serve a model. Launches default to `--parallel 1`, `--draft-vocab cjk` and `--mtp on` unless the template says otherwise.
- **Data folder:** one global folder (default `<engines folder>/Strata-data`) or an isolated one per setup. Changing it does not move existing files.

**Logs**

Server logs are collected in the background and kept until you clear them or close the app.

<img width="2129" height="777" alt="image" src="https://github.com/user-attachments/assets/113dfc32-4bc4-4e3f-883b-bbbcde0df009" />

**MCP server and agentic control over XLM-Studio**

Let your agents switch the model running behind them with a skill, choosing a faster or smarter model for the task. You can agentically benchmark, manage and create templates this way, and more.

<img width="785" height="693" alt="image" src="https://github.com/user-attachments/assets/ce261fce-9386-47f5-b64c-edae42b72122" />

## Installation

### Download the Release

1. Go to the [Releases](https://github.com/RenZekta/XLM-Studio/releases) page.
2. Download the installer for your operating system.
3. Run it and launch XLM Studio.

### Build Locally

Prerequisites: Node.js 18 or higher and npm.

Clone the repository:

```
git clone https://github.com/RenZekta/XLM-Studio
```

Then, in PowerShell 7 as administrator or in Terminal on Linux, install dependencies, build and package the installer in one go:

```
cd (X:\your\chosen\destination\XLM-Studio) && npm install && npm run build && npm run package
```

## Roadmap

**Completed**

- **Core:** upgraded visuals, Model Hub, Download Manager, template-based execution, version and engine management, visual command editor.
- **Deep control:** VRAM/RAM budget calculator, five-tier speculative decoding management and control, TurboQuant and BeeLlama support (KVarN and low-bit KV types, SWA overrides, DFlash depth controller), mmproj control and management, unified KV cache, presets, YaRN scaling automatic control, command preview, monitoring, overrides.
- **Automation:** MCP control over XLM Studio. Harness Manager: keeps an XLM Studio provider in coding harnesses (DSH, OpenCode, Pi, Pithagoras) and updates them. Persistent KV cache for quick conversation resume after switching or restarting templates (hybrid-model support depends on the fork).
- **Expansion:** Alternative engines: Strata support (v2.2.0), the first model-specific engine.

**Planned**

- [ ] **Built-in Chat Interface:** native chat client, which would also let Monitoring see real per-request data instead of polling `/metrics`. Optional; a separate chat window works fine.
- [ ] **Multi-Language Support:** i18n beyond English.
- [ ] **Alternative engines:** MLX (Apple Silicon), vLLM, and [PicoLM](https://github.com/whoreson/picolm) as a llama.cpp alternative.

## Acknowledgements

XLM Studio is built using the foundation laid by [Hexllama](https://github.com/andersondanieln/hexllama).
