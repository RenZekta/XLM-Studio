![](assets/github-banner.png)
<p align="center">
  <img src="https://img.shields.io/github/v/release/RenZekta/XLM-Studio?style=flat-square&color=black&label=version" alt="Latest Version" />
  <img src="https://img.shields.io/badge/Electron-191970?style=flat-square&logo=Electron&logoColor=white" alt="Electron" />
  <img src="https://img.shields.io/badge/React-20232A?style=flat-square&logo=react&logoColor=61DAFB" alt="React" />
  <img src="https://img.shields.io/badge/TypeScript-007ACC?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript" />
  <img src="https://img.shields.io/badge/Vite-B73BFE?style=flat-square&logo=vite&logoColor=FFD62E" alt="Vite" />
</p>

<br/>

XLM Studio is a fast, native desktop interface for discovering, downloading, configuring, and serving local Large Language Models with llama.cpp-compatible engines (and Strata, a model-specific engine). It strips away the friction of command-line execution and manual VRAM math, giving you a single workspace that goes from "found a GGUF on Hugging Face" to "running server with sane defaults" in a couple of clicks.

XLM Studio is a fork of [Hexllama](https://github.com/andersondanieln/hexllama), heavily extended with many features, including a memory-aware configuration engine: it reads a model's actual GGUF metadata (architecture, layer count, KV-cache geometry, MoE expert layout, quantization, speculative-decoding tensors, native chat template) and uses it to compute real VRAM/RAM budgets and recommend settings, instead of making you guess loading parameters.


## Features


**Template-Based Execution**

Save your configurations as reusable templates. Run multiple models simultaneously on different ports without conflict. Launch them in "Chat UI" mode to automatically open the built-in llama.cpp web interface, or "API Only" mode to serve them silently in the background.

<img width="1319" height="766" alt="image" src="https://github.com/user-attachments/assets/12dee642-d70f-4ab3-ab7f-0e054871ac44" />



**Integrated Model Hub**

Search Hugging Face directly within the application. Browse repositories, view file details, and download GGUF models with a single click without ever opening a browser.

<img width="1258" height="780" alt="image" src="https://github.com/user-attachments/assets/4501f8fe-5b3a-4842-9d4b-2f2acfaab906" />



**Smart Download Manager**

Pause, resume, or cancel large model downloads reliably. You can also paste direct GGUF links. If you prefer to interact with CLI, I have a project to greatly improve the HF CLI experience and control over it: https://github.com/RenZekta/HF-CFD


**Automatic Metadata Extraction**

Every detected model gets its GGUF metadata (architecture, layer/expert counts, context length, quantization, KV-cache geometry, chat template, speculative-decoding tensors) extracted and cached the moment it's discovered — scanned in parallel at launch, with a single consolidated "Extracting model metadata" notification (hover it to see which models are still being processed).

<img width="472" height="203" alt="image" src="https://github.com/user-attachments/assets/e4be6d3f-de6f-484f-8f5a-cf1555895c9c" />



**Memory-Aware VRAM/RAM Budget Calculator**

Every template shows a live Free VRAM breakdown (model weight, KV cache, compute buffer, runtime overhead) computed from the model's actual attention geometry — including MLA, grouped-query attention, sliding-window attention, and hybrid SSM/attention architectures (e.g. Qwen3-Next-style models where only a fraction of layers carry a KV cache). It tells you, in plain language:
- **Dense models:** how many of the model's layers fit on your GPU at the selected context, and separately — how much context you'd get if you kept (ideally) all layers on the fastest memory available.
- **MoE models:** how many layers need to be offloaded to (or forced onto CPU from) VRAM to fit the selected context.

Each recommendation line has a small apply button to commit it directly.

Dense:

<img width="490" height="303" alt="image" src="https://github.com/user-attachments/assets/ba8e1a8a-eb8f-42d1-be2a-6f42e2140dbd" />

MoE:

<img width="490" height="303" alt="image" src="https://github.com/user-attachments/assets/2be057e2-cfe4-44e0-b770-af82369aaf5f" />


**Three-Way Configuration Presets**

Every template has a **Quick** / **FULL AUTO** / **Manual** switch:
- **Quick** applies good fast-starting engine baseline (threads, batch sizes, flash attention, KV cache quantization, speculative decoding drafting parameters) and, for Dense models max GPU layers so llama.cpp will offload as much as it can; MoE models are left on llama.cpp's auto offloading (it's good for MoE). Context defaults to the model's native context (capped at 32K for Dense for a reasoble baseline; for MoE set to max, since MoE tolerates RAM-resident layers well).
- **FULL AUTO** starts from the same baseline but hands context and GPU-layer placement over to llama.cpp's own `--fit` auto-sizing. If you need more space for context or GPU offloading, turn off Multimodal Projector and Speculative Decoding, and you'll get the most out of your available VRAM.
- **Manual** wipes engine settings back to nothing, without touching your sampling parameters (temperature, top-p, top-k, min-p, penalties) — those are considered separate, per-preference settings that no engine preset should ever silently overwrite.

Common parameters shows only the most impactful parameters (LM Studio style), Full shows all menu control supported parameters.

Parameters that differ from the currently-selected preset (or, for sampling values, from your main selected sampling preset) are highlighted with a reset-to-default button.

<img width="330" height="122" alt="image" src="https://github.com/user-attachments/assets/aaf946c7-3f40-4bbb-a339-fb4944590d53" />


**Visual Command Editor**

No need to memorize execution flags or save your commands in an endless unreadable diary. Edit engine-specific commands through a structured user interface, with a "Common" view for everyday parameters and a "Full" view for all supported parameters. Toggle booleans, set limits on numerical inputs, and define default parameter values. You can still input commands directly in the Import section.

<img width="480" height="712" alt="image" src="https://github.com/user-attachments/assets/b6c514ea-b6cd-46ee-bd2e-e1fba93e74c0" />



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

(Qwen3.8-27B-i1-IQ4_XS-GGUF-Smaller.gguf running on 16 gb RX 9070 XT with automatic 60k context. In memory-constrained scenarios results depends on GPU usage, but with XLM Studio you can squeeze more out of your hardware, thanks to design that does not limit your options.)

<img width="2552" height="1184" alt="image" src="https://github.com/user-attachments/assets/34e69e37-6c2f-423c-bdc2-68984506ab82" />



**Overrides**

Global settings that apply across every template in one place: the Base URL override, per-model defaults (AutoFit context minimum, MoE offload strategy, CPU-threads recommendation percentage, mmproj auto-enable, and more), and a Parallel Inference override that can force `--parallel`/`-np` to a single value for all models, or independent values for Dense vs. MoE.

<img width="806" height="984" alt="image" src="https://github.com/user-attachments/assets/47c55a63-3063-4982-82aa-df8302c55a42" />




**YaRN Context Scaling**

Need more context than a model's native window? Turn on Automatic YaRN scaling control (per-template, or globally as an "upscale to AutoFit" override) and XLM Studio computes and applies `--rope-scaling yarn`, `--rope-scale`, and `--yarn-orig-ctx` for you as you move the context slider — no manual RoPE math required. They are left out at or below the native context, and removed when the control is turned off.

<img width="503" height="269" alt="image" src="https://github.com/user-attachments/assets/90ca473e-1153-49c3-90cd-06c33acf2ffb" />



**Command Preview**

Every template shows a live preview of the exact `llama-server` command that will run — including values that only get resolved at launch time (the AutoFit context-override floor, `--fit`/`--no-webui` flags, the default port), clearly marked when they differ from what's literally saved in the template. Switch to the stacked view to see it as one flag per line instead of a single long string.

<img width="503" height="338" alt="image" src="https://github.com/user-attachments/assets/252df95b-d6f1-4c6e-953b-17744c109a34" />



**Version and Engine Management**

Running cutting-edge models sometimes requires different builds of llama.cpp (or compatible with extra feature forks, e.g. TurboQuant-enabled builds). XLM Studio lets you maintain and seamlessly switch between multiple engine builds, and can check upstream repositories for new releases and download/extract them straight from the settings panel.

[atomic-llama-cpp-turboquant](https://github.com/AtomicBot-ai/atomic-llama-cpp-turboquant) and [BeeLlama.cpp](https://github.com/Anbeeld/beellama.cpp) are built in. Their fork-only parameters (KVarN and extra low-bit KV cache types, KV precision tail, DFlash depth controller, reasoning loop guard) appear only for templates running on that fork, and are dropped automatically if a template moves to a backend that doesn't support them.

<img width="2553" height="1388" alt="image" src="https://github.com/user-attachments/assets/128c738d-de86-4906-8752-f5a7f255820d" />

**Which backend a Template runs on:** a Template that pins a backend (Follow global backend off) always runs on the pinned repo and backend type. The version is only a preference among builds of that repo and type, since a version folder is replaced when an engine is updated or rebuilt; if the pinned backend is not installed at all, the launch says so instead of starting on the global backend. The parameter editor's defaults and highlighted differences are computed from the Template's own backend, not the global one.

**Several multimodal projectors per model:** every `mmproj` file in a model folder is listed in Models and ranked by precision (bf16, f16, f32, q8, q6, q5, q4_K_M, other q4, q4_0, then unlabelled); the first is used automatically. When a model folder has more than one, the Template's Multimodal Projector section has a Detected projector dropdown to choose another; if the chosen file disappears the best one is used again.

**Context size:** the model's maximum is always the last stop of the 2x slider, even when it is not a power of two (128000).

**Build from Source and branches**

The **Install method** switch at the top of Settings > Engine Tracker chooses how llama.cpp-style engines are installed: **Download Binary** (default) takes the prebuilt release assets, **Build from Source** clones the repository and compiles `llama-server` on this machine. A build needs git, CMake and a C++ compiler, plus the CUDA, Vulkan or ROCm SDK for that backend. If any is missing, the Build button becomes **Install tools and build** and installs them with winget on Windows, Homebrew on macOS, or apt, dnf, pacman or zypper on Linux; on Linux a password dialog (polkit) asks for administrator rights. With **Keep build tools up to date** on, a newer version of an installed tool is applied the same way before a build you start yourself (never in the background). The AMD ROCm SDK is not installed through a package manager: for a ROCm build you choose your GPU (detected when possible) and the app gets AMD's SDK for that GPU family into the engines folder (`.sdk/rocm`). Settings has a switch for how: **Tarball** (default) downloads and unpacks AMD's TheRock archive (stable, or the nightly builds), self-contained and with no Python; **pip** installs AMD's `rocm[devel,libraries,device-<gpu>]` wheels into a virtual environment, which needs Python 3.11 to 3.14 (installed for you like the other tools). If one gives trouble, switch to the other; the SDK of the other kind is replaced. That needs no administrator rights and adds nothing to the system PATH; the SDK is only put on PATH for the build itself, and a newer one replaces the old one on update. The SDK is searched for its device libraries (`ocml.bc` and the other bitcode clang links into every GPU file) and the folder is passed to clang, since a layout clang does not expect makes it fail with "cannot find ROCm device library"; if the SDK has none, the build log says so. HIP builds on Windows also need Ninja, which is installed with winget, and run inside the Visual Studio build environment (Windows SDK tools and libraries) that the Ninja generator would not set up by itself. If winget is not found, the app tries registering Windows' App Installer again (`Add-AppxPackage -RegisterByFamilyName`) once per run before giving up. A few tools still cannot be installed automatically (CUDA on most Linux distributions, the Xcode command line tools); the panel says what to do for those. Pick the backend, add extra CMake options if you need them, and follow the build and the tool installation in the Logs tab. A build is named after the release tag of the commit it was built from (`b10298-2.1.0-src`), ignoring moving and CI tags such as `dev-latest`, so the downloaded release of the same version is recognised and replaced. A commit without a release tag of its own is named after the nearest release and its own short hash (`b10298-2.1.0-g8d935078-src`). "Nearest" is measured against every recent release tag, not only the commit's ancestors as `git describe` does, because some forks (TurboQuant) cut their releases on a side branch that is not in the history of the branch they develop on. A repo that was tracked twice (a custom entry made before it became built-in) is merged into the built-in entry and its old folder is moved in at startup. Compiled builds are installed like downloaded ones (`<repo>/<backend>/<version>/`) and listed in the same dropdown, flagged when the branch has moved on, and rebuilt with the same options by **Update & Rebuild** (the white button, shown only while a build is behind the branch; it pulls the branch first and rebuilds the builds that are behind), Update all and the automatic update. **Rebuild** (the black button) compiles the source again as it is checked out, without pulling, for after you change the CMake options or the SDK. A finished build replaces the older (or same-tag) downloaded binary of that backend, also when the tracker finds nothing to rebuild, and downloading a newer binary replaces an older compiled build. Which release a build stands for is worked out from its commit as well as its folder name, so builds named by an older version of the app (`dev-latest-src`, a bare hash) still replace the downloads they make redundant; what is removed, and what could not be removed (a folder in use on Windows), is written to the build log or, for a tracker check, to a "Cleanup" source in the Logs tab. A build whose CMake has been updated since it was configured repairs itself: sub-builds such as the Vulkan `vulkan-shaders-gen` helper that point at a CMake that is gone are removed before configuring, and if a build still fails with CMake's "Build files cannot be regenerated correctly" family of errors, the sub-builds are removed and it is retried, then the whole build folder, but never for a compile error. CUDA builds on Windows are generated with Ninja inside the Visual Studio environment too, so they do not need NVIDIA's "Visual Studio Integration" component (the part of its installer that is known to hang); the toolkit's DLL folders (`bin\x64`, `bin`) are added to the environment of the server like the ROCm SDK's. There are two CUDA types: **CUDA (newest)** and **CUDA 12.4**, for GPUs CUDA 13 dropped (Maxwell, Pascal, Volta such as the V100); toolkits install side by side and each build uses the one of its type. On Windows the app installs the toolkit itself: winget is only asked for its manifest (installer address and SHA-256), the app downloads the installer (resumable, with a percentage, checksum verified) because winget has been seen to stall on that 4 GB file, and runs it silently with administrator rights, first with only the components llama.cpp needs (`nvcc`, `cudart`, `cublas`, `cublas_dev`, `thrust`, plus `crt` and `nvvm` from CUDA 13, where the CRT headers and the NVVM compiler are components of their own) and with the full set if that leaves no toolkit or one that cannot compile (the app checks for the CRT, runtime and cuBLAS headers, the `cudart` and `cublas` libraries, thrust, and `nvvm\bin\cicc.exe`). A toolkit that is there but incomplete counts as missing, so **Install tools and build** repairs it by running the installer over it. The downloaded installer stays in `.sdk\cuda` until a CUDA build has succeeded, so a repair after a failed build does not download it again, and when the CUDA configure step fails the log lists what the toolkit's key folders hold. On Linux the Vulkan backend needs, besides `glslc` and the Vulkan headers, the CMake package of the SPIR-V headers (`spirv-headers-devel` on Fedora, `spirv-headers` on Debian, Ubuntu, Arch and openSUSE): all of them are installed with the build tools, and Vulkan only counts as present when all three are found, so a system with `glslc` alone is no longer built blindly (the configure error also says which package to install). On Linux CUDA comes from the package manager, and a specific series such as 12.4 has to be installed from NVIDIA. winget shows no progress when it runs from the app, so while an install is quiet the log says so every 30 seconds and reports the size of winget's installer file, which shows whether it is still downloading or the installer is running. A ROCm build gets the library folder of the SDK it was built against (the app's own, or one already on the machine) added to its environment when a model starts, since (unlike the release zips) it does not carry the ROCm libraries with it. If a server still stops at once, the Logs tab shows its exit code, with an explanation for the common Windows loader errors (a missing or mismatched DLL). The source and CMake build tree are kept per OS, in `<repo>/.work/<os>/source` and `<repo>/.work/<os>/build/<type>`, so a rebuild is incremental. An engines folder shared by several systems (dual boot) therefore holds a Windows, a Linux and a macOS clone and build tree side by side, and a system never reuses or clears another's: a CMake tree remembers absolute paths and a clone carries its system's line endings and native `node_modules`, so sharing them fails to configure and clearing them to recover destroys the other system's work. The installed builds (`<repo>/<type>/<version>`) are shared, each folder knowing which OS it is for. A clone and build tree made by an older version of the app (`<repo>/.source`, `<repo>/.build`) stay where they are and belong to the OS that cloned it, which is read from the clone's own git config (Windows, Linux and macOS write different settings), so nothing is rebuilt. The ROCm SDKs in `.sdk/rocm` record their OS in the same way, and finding or removing an SDK only ever deals with the current OS's. A repository with no releases offers to switch to Build from Source instead of failing.

A link to another branch (`https://github.com/owner/repo/tree/branch` or `owner/repo@branch`) tracks that branch as its own engine: it is listed as a separate Repo (with the branch name) in the sidebar, the Template editor and Installed Engines, and sits inside the same repo block in the Engine Tracker. Release binaries are not per branch, so a branch is always built from source.


**Strata (model-specific engine)**

[Strata](https://github.com/Niko1221/Strata) runs Qwen3.8-Flash-Next on consumer GPUs by keeping the mixture-of-experts weights in system RAM. It is installed as a `git clone` (Settings > Engine Tracker), updated with git, and driven through its own launcher scripts, so XLM Studio never needs to know how it prepares a model. Its launcher builds a Python environment and the engine inside the clone, and both belong to an OS, so each OS has an instance of its own: an engines folder shared by several systems (dual boot) holds `Strata` and, for example, `Strata-linux` side by side, and each system lists, updates and launches only its own, so switching OS never rebuilds the other's. Which OS a clone belongs to is read from its git config. The first time XLM Studio starts on a system that has no instance of its own, it makes one from the one another OS left, as a local `git clone` (nothing is downloaded, and the environment and build output of the other system stay behind), with its origin set back to GitHub; the launcher then builds it once. The same is what **Install** does for a system that has none. One that is deleted afterwards is not made again. Strata's version is its release tag alone (`v0.2.10`), with nothing added for the commits a clone is past it, unlike a source build's name.

- **Engine, Repo, Backend.** Every template picks an **Engine** (llama.cpp or Strata) and then a repo and, for engines with several builds, a GPU backend. "Follow global" templates use the engine's selection in the sidebar; each engine has its own. Values you set for an engine are kept if you switch the template away and back.
- **Automatic model validation.** Every GGUF is fingerprinted (its routed experts, the way Strata's own `strata_inspect.py` does) and tested against each installed Strata engine, Strata and its forks alike, by the file table that engine's own clone ships. No architecture is assumed, so a newer table or a fork's models need no app update. Each engine answers separately: a file it installs, the same layout, untested, not runnable, or unverified (its table has nothing to compare the file with, so it checks the file itself on start). The Models tab shows the best answer except unverified, and new templates for a recognised file start on Strata. A Template uses the verdict of the engine it runs on; if that engine cannot run a file that another installed engine can, the form says so and offers to switch. A bundled snapshot of Strata's table stands in while no engine is installed. Model Family and Variant are dropdowns filled from the engine the Template runs on (its file table and the families its `setup.py` declares, read at runtime), so nothing is typed, even for a model the engine cannot pre-verify; the variants follow the chosen family, and a file the engine recognises fills both in by itself.
- **Import from command (Strata).** Paste a launch command (`START-HERE.bat`, `./setup.sh` or `python setup.py` with flags). Port, host and API key go to the Server fields, `--family` and `--model` to Model Family and Variant, `--gguf-dir` selects the matching model from your library, and flags the launch adds itself are dropped.
- **Presets and editor.** The Strata editor works like the llama.cpp one: FULL AUTO sends only the model's identity and leaves every value to Strata's own recommendation, Quick carries over context size and KV precision, and, like FULL AUTO, leaves image input on Automatic (Strata enables it when the model has a projector, with the encoder on the CPU; "yes" is only for when you want the GPU reader) (there is no Manual preset, since there is little to set). Fields show the value Strata will actually use (for example the recommended context for your GPU and RAM), not a placeholder, and are highlighted when they differ from the selected preset's own values. There is a Common / Full parameters switch, the same context slider with optional 2x steps and automatic YaRN scaling, and a selectable launch preview with the global overrides applied. A memory panel estimates KV cache, the share of experts on the GPU and the RAM needed, using the same rules as Strata's setup.
- **Image input.** The default is Automatic: nothing is sent, which is Strata's own default (images on where the model can read them, the encoder on the CPU under 24 GB of VRAM and on the GPU from 24 GB, plus the encoder's download). Pick no for text only, or yes, gpu or cpu to choose the reader. The memory estimate follows the encoder Automatic would get.
- **Drafter.** In the Speculative Decoding category, which is also shown in Common. Auto, MTP, DFlash2 and Off are Strata's saved drafting choice, which `setup.py` cannot set: before each launch XLM writes it to the model's run config (`strata-<family tag><model>.json`), after an install-only pass if the model has none yet, and for DFlash2 downloads the drafter files with `strata drafting fetch --if-needed`. Setup is sent `--drafter dflash2` only for DFlash2, which skips the MTP download. A step that fails is logged and the launch continues.
- **Setup flags.** The Strata editor lists every `setup.py` flag that applies to a launch, grouped like the llama.cpp editor. XLM sets the port, host, API key, data folder, GGUF folder, `--yes` and `--no-browser` itself, and never sends flags that do not serve a model (`--setup`, `--no-start`, `--check`, `--update`, `--rollback-engine`, `--inspect`, `--prepare-pack`, `--move-data`, `--set-default-data-dir`, `--browser`), whether they come from a Template or a pasted command. Strata keeps `parallel`, `mtp` and `drafting` between setups, so every launch sends `--parallel 1`, `--draft-vocab cjk` and `--mtp on` unless the Template sets them. Replicas and Replica Profile cannot be turned off through setup; remove `replicas` from the run config. `scripts/strata-verify.js` fails when `setup.py` gains a flag that is not sorted into one of these groups.
- **Updates.** "Update tracked engines automatically" (off by default) updates installed llama.cpp builds and Strata after the startup check. "Update before launch" is a separate Strata switch that fast-forwards the clone before each launch; a failed update never blocks the launch.
- **Data folder.** Strata's prepared data lives in one global folder (default `<engines folder>/Strata-data`), or in an isolated folder with its own Strata settings. Strata only moves data between folders on the same drive, so changing the folder does not move existing files.
- **Overrides.** The API and Network block (port, local network, API key) and the loading guardrails apply to every engine; the rest of the Overrides page is per engine.
- **Server parameters.** Every Template, llama.cpp or Strata, has a Server block with its port, host (with a Serve on local network switch) and API key. The port is the same value as the Server Port field of the Template form, and the two stay in step. When the global Base URL Override takes one of them over, the block only notes what it is overridden to; the Template keeps its own value for when the override is off. Pasting a command into Import from command fills the port, host and API key into these fields.

Windows and Linux only; Strata does not support macOS.




**Logs**

Server logs are collected in the background for the life of the app and stay available until you clear them manually or close the app.

<img width="2129" height="777" alt="image" src="https://github.com/user-attachments/assets/113dfc32-4bc4-4e3f-883b-bbbcde0df009" />



**MCP server and agentic control over XLM-Studio**

Let your agents switch the model running behind themselves with a skill, chosing the faster or more intelligent model for the task when you ask it. You can benchmark, manage, create templates this way, and much more!

<img width="785" height="693" alt="image" src="https://github.com/user-attachments/assets/ce261fce-9386-47f5-b64c-edae42b72122" />



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

Run Powershell 7 as an administrator (open folder, install dependencies, build and package installer in one task)
```
cd (X:\your\chosen\destination)\XLM-Studio && npm install && npm run build && npm run package
```

## Roadmap (hexllama + XLM-Studio)

### Phase 1: Core Foundation (Completed)
- [x] **Integrated Model Hub**: Hugging Face search & download direct from the app.
- [x] **Smart Download Manager**: Pause/resume/cancel, paste direct GGUF links. Downloads never create Templates on their own.
- [x] **Template-Based Execution**: Run multiple models on different ports, reusable configuration templates.
- [x] **Version and Engine Management**: Download and switch between different versions of `llama.cpp`-compatible binaries directly.
- [x] **Visual Command Editor**: Graphical UI for configuring server parameters instead of terminal flags.

### Phase 2: Memory-Aware Configuration (Completed)
- [x] **VRAM/RAM Budget Calculator**: Architecture-aware KV-cache and weight-memory estimation (MLA, GQA, sliding-window, hybrid SSM/attention), with live Dense/MoE-specific recommendations.
- [x] **Speculative Decoding — 5-tier system**: Auto-detects and prioritizes the best available method per model — Native MTP, Draft Model, EAGLE3, DSpark2, and DFlash2 — plus stackable n-gram modifiers (`ngram-map-k4v`, `ngram-mod`), each combinable with any primary method.
- [x] **TurboQuant Support**: KV-cache quantization support tuned for TurboQuant-enabled backends.
- [x] **BeeLlama Support**: KVarN (`kvarn2`-`kvarn8`) and `q2_0`-`q6_1` KV cache types, SWA overrides, `--kv-tail-tokens` precision tail, adaptive DFlash depth controller and reasoning loop guard parameters, with matching KV-cache memory estimates.
- [x] **mmproj RAM Offload**: per-Template Follow global / Disabled / Enabled control (and a global Overrides switch, on by default) for `--no-mmproj-offload`; nothing is emitted when the projector stays on the GPU.
- [x] **Draft Model KV Cache Types**: `--spec-draft-type-k/-v` dropdowns in Speculative Decoding, offering the same types as the target KV cache and defaulting to each fork's own KV default.
- [x] **Unified KV Cache**: `--kv-unified` on by default, so `--parallel` sequences share a single KV buffer instead of splitting the context window between them.
- [x] **Three-Way Presets**: Quick / FULL AUTO / Manual, with preset-relative diff highlighting that never touches sampling parameters.
- [x] **YaRN Context Scaling**: Automatic RoPE/YaRN scaling to extend usable context past a model's native window.
- [x] **Command Preview**: Live, launch-accurate preview of the actual command that will run, with a stacked (one-flag-per-line) view option.
- [x] **Monitoring**: Real-time and historical generation-speed/prefill-speed tracking per session, with comparison, export/import, and configurable history retention.
- [x] **Overrides**: Centralized global overrides — Base URL, Model Defaults, and per-architecture (Dense/MoE) Parallel Inference control.

### Phase 3: Enhanced Inference & Native UI (Short to Mid-Term)
- [ ] **Built-in Chat Interface**: Native chat client to interact with models directly within XLM Studio without launching external browser tabs — would also let Monitoring see real per-request data instead of polling `/metrics`. Optional goal, it works just fine with a separate chat window too.
- [ ] **Multi-Language Support**: Complete internationalization (i18n) to support languages beyond English.
- [X] MCP control over XLM Studio
- [X] Persistent KV Cache for quick conversation resume after switching or restarting templates. Support for Hybrid models was merged only recently, so whether it works or not depends on the individual fork.

### Phase 4: Multi-Engine & Advanced Engines (Long-Term)
- [x] **Strata Support (v2.2.0)**: First model-specific engine. Git-clone install and update, automatic GGUF validation, per-engine Template values with an Engine / Repo / Backend selector, Strata presets and memory estimate, and a shared API & Network override.
- [ ] Optional **Alternative Engine Integration**: Expand support beyond `llama.cpp` and Strata to include:
  - **MLX**: Native backend for Apple Silicon optimized performance.
  - **vLLM / ExLlamaV2**: Support for high-throughput and GPU-optimized engines.
  - Planned: [PicoLM](https://github.com/whoreson/picolm) support as llama.cpp alternative

## Acknowledgements

XLM Studio is built on top of the foundation laid by [Hexllama](https://github.com/andersondanieln/hexllama).
