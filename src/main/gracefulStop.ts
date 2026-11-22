// Asking a Windows program to exit the way Ctrl+C does. Windows has no signal
// to send to another process, so a short PowerShell helper attaches to the
// target's console and raises CTRL_C_EVENT there, after making itself immune
// to the event. The caller still force-kills when the program has not exited
// within its grace period, so a failure here only costs the grace.

import { execFile } from 'child_process'

export function windowsCtrlCScript(pid: number): string {
  return [
    "$sig = '[DllImport(\"kernel32.dll\")] public static extern bool FreeConsole();",
    '[DllImport("kernel32.dll")] public static extern bool AttachConsole(uint p);',
    '[DllImport("kernel32.dll")] public static extern bool SetConsoleCtrlHandler(IntPtr h, bool add);',
    "[DllImport(\"kernel32.dll\")] public static extern bool GenerateConsoleCtrlEvent(uint e, uint g);'",
    'Add-Type -Namespace Xlm -Name Con -MemberDefinition $sig',
    '[void][Xlm.Con]::FreeConsole()',
    `if (-not [Xlm.Con]::AttachConsole(${Math.trunc(pid)})) { exit 1 }`,
    '[void][Xlm.Con]::SetConsoleCtrlHandler([IntPtr]::Zero, $true)',
    '[void][Xlm.Con]::GenerateConsoleCtrlEvent(0, 0)'
  ].join('\n')
}

// Resolves true when Ctrl+C was delivered, false when it could not be.
export function sendWindowsCtrlC(pid: number): Promise<boolean> {
  return new Promise(resolve => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', windowsCtrlCScript(pid)],
      { timeout: 6000, windowsHide: true }, err => resolve(!err))
  })
}
