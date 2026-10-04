import { safeStorage } from 'electron'
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'fs'
import { join } from 'path'

// The token lives in its own file rather than settings.json: loadSettings
// rebuilds the settings object field by field, and a secret should never be
// echoed back through the general settings IPC. When the OS keystore is
// available (DPAPI / Keychain / libsecret) the token is stored encrypted;
// otherwise it falls back to plaintext with owner-only permissions, and the
// UI is told so via `encrypted: false`.
interface StoredToken { enc: boolean; data: string }

let tokenPath = ''
let cached: string | null | undefined

export function initGithubToken(root: string): void {
  tokenPath = join(root, 'github-token.json')
  cached = undefined
}

export function getGithubToken(): string | null {
  if (cached !== undefined) return cached
  cached = null
  try {
    if (!tokenPath || !existsSync(tokenPath)) return cached
    const stored = JSON.parse(readFileSync(tokenPath, 'utf-8')) as StoredToken
    cached = stored.enc
      ? safeStorage.decryptString(Buffer.from(stored.data, 'base64'))
      : stored.data
  } catch {
    cached = null
  }
  return cached
}

export function saveGithubToken(token: string): { encrypted: boolean } {
  const encrypted = safeStorage.isEncryptionAvailable()
  const stored: StoredToken = encrypted
    ? { enc: true, data: safeStorage.encryptString(token).toString('base64') }
    : { enc: false, data: token }
  writeFileSync(tokenPath, JSON.stringify(stored), { mode: 0o600 })
  cached = token
  return { encrypted }
}

export function clearGithubToken(): void {
  try { if (existsSync(tokenPath)) unlinkSync(tokenPath) } catch {}
  cached = null
}

export function githubTokenStatus(): { hasToken: boolean; encrypted: boolean } {
  if (!getGithubToken()) return { hasToken: false, encrypted: false }
  try {
    const stored = JSON.parse(readFileSync(tokenPath, 'utf-8')) as StoredToken
    return { hasToken: true, encrypted: stored.enc }
  } catch {
    return { hasToken: true, encrypted: false }
  }
}
