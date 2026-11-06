import { execFile } from 'child_process'
import { existsSync } from 'fs'
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
