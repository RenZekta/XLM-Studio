import { execFile } from 'child_process'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { delimiter, join } from 'path'

// The environment build tools are looked up in. An app started from Finder or
// the Start menu gets a smaller PATH than a terminal, and on Windows it keeps
// the PATH it started with even after an installer changes the system one.

export function onPath(cmd: string): boolean {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : ['']
  return (process.env.PATH || '').split(delimiter).some(dir => dir && exts.some(ext => existsSync(join(dir, cmd + ext))))
}

function addToPath(dirs: string[]): void {
  const have = new Set((process.env.PATH || '').split(delimiter))
  const add = dirs.filter(d => !have.has(d) && existsSync(d))
  if (add.length) process.env.PATH = [...add, process.env.PATH || ''].filter(Boolean).join(delimiter)
}

// Re-reads the machine and user environment from Windows, for tools an
// installer just added (git, CMake, the CUDA and Vulkan variables).
async function refreshWindowsEnv(): Promise<void> {
  const script = "$o=@{}; foreach($n in 'Path','CUDA_PATH','VULKAN_SDK','HIP_PATH'){ $m=[Environment]::GetEnvironmentVariable($n,'Machine'); $u=[Environment]::GetEnvironmentVariable($n,'User'); if($n -eq 'Path'){ $o[$n]=(@($m,$u) -join ';') } else { $o[$n]= if($u){$u}else{$m} } }; $o | ConvertTo-Json -Compress"
  const out = await new Promise<string>(resolve => {
    execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 15000, windowsHide: true }, (err, stdout) => resolve(err ? '' : String(stdout)))
  })
  try {
    const env = JSON.parse(out) as Record<string, string | null>
    if (env.Path) {
      const merged = [...new Set([...env.Path.split(';'), ...(process.env.PATH || '').split(';')])].filter(Boolean)
      process.env.PATH = merged.join(';')
    }
    for (const n of ['CUDA_PATH', 'VULKAN_SDK', 'HIP_PATH']) if (env[n]) process.env[n] = env[n]!
  } catch { /* keep the environment the app started with */ }
}

let prepared = false

// Call before looking for a tool. `force` re-reads the system environment
// again, after installing something.
export async function ensureToolEnv(force = false): Promise<void> {
  if (process.platform === 'darwin') addToPath(['/opt/homebrew/bin', '/usr/local/bin'])
  if (process.platform === 'linux') addToPath(['/usr/local/cuda/bin'])
  if (process.platform === 'win32' && (force || !prepared)) await refreshWindowsEnv()
  prepared = true
}

// ---------------------------------------------------------------------------
// Tools the app installs into its own folders, made visible system-wide
// ---------------------------------------------------------------------------

function underFolder(p: string, folder: string, ci: boolean): boolean {
  const norm = (x: string) => { const y = x.replace(/\\/g, '/').replace(/\/+$/, ''); return ci ? y.toLowerCase() : y }
  const a = norm(p), b = norm(folder)
  return a === b || a.startsWith(b + '/')
}

// A PATH value without the entries inside `folder`, with `add` appended. The
// app's own folders go last so they never shadow a tool the user installed.
export function rewritePath(current: string, folder: string, add: string[], sep: string, ci: boolean): string {
  const kept = current.split(sep).filter(d => d && !underFolder(d, folder, ci))
  return [...kept, ...add.filter(d => !kept.includes(d))].join(sep)
}

const PROFILE_BEGIN = '# >>> XLM Studio build tools >>>'
const PROFILE_END = '# <<< XLM Studio build tools <<<'

function shellQuote(v: string): string {
  return `'${v.replace(/'/g, `'\\''`)}'`
}

// A shell profile with the app's block replaced by `lines`, or removed when
// `lines` is null.
export function rewriteProfile(text: string, lines: string[] | null): string {
  const block = new RegExp(`\\n?${PROFILE_BEGIN}[\\s\\S]*?${PROFILE_END}\\n?`, 'g')
  const rest = text.replace(block, '\n').replace(/\n{3,}/g, '\n\n').replace(/^\n+|\n+$/g, '')
  if (!lines) return rest ? `${rest}\n` : ''
  return `${rest ? `${rest}\n\n` : ''}${PROFILE_BEGIN}\n${lines.join('\n')}\n${PROFILE_END}\n`
}

function powershell(script: string, env: Record<string, string> = {}): Promise<string | null> {
  return new Promise(resolve => {
    execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 15000, windowsHide: true, env: { ...process.env, ...env } }, (err, stdout) => resolve(err ? null : String(stdout)))
  })
}

// Puts `dirs` on the user's PATH and sets `vars`, after taking out whatever an
// earlier call left inside `folder` (an SDK version that was replaced or
// deleted). With `add` null it only takes that out. Variables are set only
// where they are unset or already point into `folder`. Windows edits the user
// environment, Linux a block in ~/.profile (read at the next sign-in); other
// systems have no such tools. Returns an error message, or null.
export async function syncManagedPath(folder: string, add: { dirs: string[]; vars: Record<string, string> } | null): Promise<string | null> {
  const names = Object.keys(add?.vars ?? {})
  if (process.platform === 'win32') {
    const read = await powershell("$k=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment'); $o=@{}; foreach($n in 'Path','HIP_PATH','ROCM_PATH'){ $o[$n]=$k.GetValue($n,$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) }; $o | ConvertTo-Json -Compress")
    let user: Record<string, string | null>
    try { user = JSON.parse(read ?? '') } catch { return 'The user environment could not be read.' }
    const set: Record<string, string> = {}
    const clear: string[] = []
    for (const n of ['HIP_PATH', 'ROCM_PATH']) {
      const cur = user[n]
      const ours = !cur || underFolder(cur, folder, true)
      if (add?.vars[n] && ours) set[n] = add.vars[n]
      else if (!add?.vars[n] && cur && underFolder(cur, folder, true)) clear.push(n)
    }
    const path = rewritePath(user.Path ?? '', folder, add?.dirs ?? [], ';', true)
    // Setting a variable makes Windows tell running programs the environment changed; the
    // throwaway one makes it do so when only the PATH was edited.
    const script = "$p=$env:XLM_ENV | ConvertFrom-Json; $k=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment',$true); $k.SetValue('Path',$p.path,[Microsoft.Win32.RegistryValueKind]::ExpandString); foreach($v in $p.set.PSObject.Properties){ [Environment]::SetEnvironmentVariable($v.Name,[string]$v.Value,'User') }; foreach($n in $p.clear){ [Environment]::SetEnvironmentVariable($n,$null,'User') }; [Environment]::SetEnvironmentVariable('XLM_STUDIO_SYNC',$null,'User')"
    const out = await powershell(script, { XLM_ENV: JSON.stringify({ path, set, clear }) })
    return out === null ? 'The user environment could not be changed.' : null
  }
  if (process.platform === 'linux') {
    const file = join(homedir(), '.profile')
    try {
      const text = existsSync(file) ? readFileSync(file, 'utf8') : ''
      if (!add && !text.includes(PROFILE_BEGIN)) return null
      const lines = add ? [
        `export PATH="$PATH"${add.dirs.map(d => `:${shellQuote(d)}`).join('')}`,
        ...names.map(n => `export ${n}=${shellQuote(add.vars[n])}`)
      ] : null
      writeFileSync(file, rewriteProfile(text, lines))
    } catch (e) {
      return `~/.profile could not be changed: ${e instanceof Error ? e.message : String(e)}`
    }
  }
  return null
}
