// Remembers which binary variant (cuda / vulkan / cpu / etc.) the user last
// picked for each tracked backend, so the download dropdowns in Settings and
// the update banner default to it instead of always falling back to the
// first asset in the list.
const STORAGE_KEY = 'xlm_backend_last_asset_type'

function loadAll(): Record<string, string> {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}')
    return raw && typeof raw === 'object' ? raw : {}
  } catch {
    return {}
  }
}

// Release asset filenames embed the version/build number (and sometimes a
// runtime-library version like "cuda-12.4"), so the same binary variant
// never has an identical filename across releases. Stripping all digits
// collapses "llama-b10448-bin-win-cuda-12.4-x64.zip" and
// "llama-b10512-bin-win-cuda-12.6-x64.zip" to the same key while still
// telling "cuda" apart from "vulkan" or "cpu".
export function assetTypeKey(assetName: string): string {
  return assetName.toLowerCase().replace(/\d+/g, '')
}

export function getLastAssetType(backendId: string): string | undefined {
  return loadAll()[backendId]
}

export function setLastAssetType(backendId: string, assetName: string): void {
  const all = loadAll()
  all[backendId] = assetTypeKey(assetName)
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(all)) } catch {}
}

// Picks the asset matching the last-selected type for this backend, falling
// back to the first asset in the list if there is no remembered preference
// or it no longer matches anything on offer.
export function pickDefaultAsset<T extends { name: string; downloadUrl: string }>(
  backendId: string,
  assets: T[]
): string {
  if (!assets.length) return ''
  const wanted = getLastAssetType(backendId)
  if (wanted) {
    const match = assets.find(a => assetTypeKey(a.name) === wanted)
    if (match) return match.downloadUrl
  }
  return assets[0].downloadUrl
}
