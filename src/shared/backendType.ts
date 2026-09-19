// Multi-backend-type support: a single release can ship several GPU-runtime
// variants of the SAME version (vulkan, cuda, rocm, metal, ...), and most
// forks don't encode that anywhere except the asset filename itself. This
// derives a stable "type" folder name from that filename so each variant
// gets extracted into its own <backendKey>/<type>/<version>/ folder instead
// of colliding with every other variant of the same release under a single
// <backendKey>/<version>/ folder.

// Derives a stable "backend type" from a downloaded asset's filename, e.g.:
//   "llama-b11046-bin-win-vulkan-x64.zip"        -> "vulkan"
//   "llama-b11046-bin-win-cuda-12.4-x64.zip"     -> "cuda-12.4"
//   "llama-turboquant-windows-x64-vulkan.zip"    -> "vulkan"
//   "llama-turboquant-windows-x64-rocm.zip"      -> "rocm"
// The build number itself is deliberately NOT part of the type (that's what
// the version subfolder underneath it is for) -- two releases of the same
// variant should keep landing in the same type folder across updates.
export function extractBackendTypeFromAssetName(assetName: string): string {
  const base = assetName.replace(/\.(zip|tar\.gz|tgz)$/i, '').toLowerCase()
  // CUDA builds often pin a toolkit version (e.g. "cuda-12.4", "cu11.7") --
  // keep it as part of the type so the two don't collide as if they were
  // the same variant; they need different NVIDIA driver versions.
  const cudaVersion = base.match(/\bcu(?:da)?[-_]?(\d+\.\d+)\b/)
  if (cudaVersion) return `cuda-${cudaVersion[1]}`
  if (/\bcuda\b/.test(base)) return 'cuda'
  if (/\brocm\b|\bhip\b/.test(base)) return 'rocm'
  if (/\bvulkan\b/.test(base)) return 'vulkan'
  if (/\bmetal\b/.test(base)) return 'metal'
  if (/\bsycl\b|\boneapi\b/.test(base)) return 'sycl'
  if (/\bopencl\b|\bclblast\b/.test(base)) return 'opencl'
  if (/\bavx512\b/.test(base)) return 'avx512'
  if (/\bnoavx\b/.test(base)) return 'noavx'
  if (/\bavx2\b/.test(base)) return 'avx2'
  if (/\bavx\b/.test(base)) return 'avx'
  if (/\barm64\b|\baarch64\b/.test(base)) return 'arm64'
  if (/\bcpu\b/.test(base)) return 'cpu'
  // Unrecognised naming: fall back to a sanitized slug of whatever's left
  // after stripping generic OS/arch/build-number noise, so distinct (if
  // unknown) variants still land in separate folders instead of silently
  // colliding under one.
  const NOISE = new Set(['bin', 'win', 'windows', 'linux', 'macos', 'osx', 'darwin', 'ubuntu', 'x64', 'x86', 'x86_64', 'amd64'])
  const tokens = base.split(/[-_.]+/).filter(t => t && !NOISE.has(t) && !/^b?\d{3,7}$/.test(t))
  return tokens.length ? tokens.join('-') : 'default'
}

// Coarse runtime category for a backend type string (as produced above),
// used to pick the right default VRAM overhead. More reliable than
// guessing from a fork's free-form display name: this is the literal
// keyword parsed from the release asset's own filename at download time.
export function backendTypeToRuntimeCategory(type: string | null | undefined): 'cuda' | 'rocm' | 'vulkan' | 'cpu' | 'unknown' {
  if (!type) return 'unknown'
  const t = type.toLowerCase()
  if (t.startsWith('cuda')) return 'cuda'
  if (t === 'rocm') return 'rocm'
  if (t === 'vulkan') return 'vulkan'
  if (t === 'cpu' || t === 'avx' || t === 'avx2' || t === 'avx512' || t === 'noavx' || t === 'arm64') return 'cpu'
  return 'unknown'
}

// Human-friendly grouping label for a backend type, used to bucket several
// installed variants of the same runtime family (e.g. "cuda-11.7" and
// "cuda-12.4") under one sidebar filter tab. Unlike
// backendTypeToRuntimeCategory, this keeps Vulkan/Metal/SYCL/OpenCL/etc as
// their own distinct labels rather than lumping them together, since the
// sidebar switch is meant to show every runtime family the user actually
// has installed, not just a coarse cuda/rocm/vulkan/cpu split.
export function backendTypeGroupLabel(type: string | null | undefined): string {
  if (!type) return 'Other'
  const t = type.toLowerCase()
  if (t.startsWith('cuda')) return 'CUDA'
  if (t === 'rocm') return 'ROCm'
  if (t === 'vulkan') return 'Vulkan'
  if (t === 'metal') return 'Metal'
  if (t === 'sycl') return 'SYCL'
  if (t === 'opencl') return 'OpenCL'
  if (t === 'cpu' || t === 'avx' || t === 'avx2' || t === 'avx512' || t === 'noavx') return 'CPU'
  if (t === 'arm64') return 'ARM64'
  if (t === 'default') return 'Other'
  // Unknown/custom slug -- title-case it as-is so it still reads as a label
  // rather than a raw folder-name fragment.
  return type.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
}
