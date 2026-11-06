// What a process exit code means when it is one of the Windows loader's, which
// is how a program that cannot start (a missing DLL) ends: nothing is printed.
export function explainExitCode(code: number): string {
  switch (code >>> 0) {
    case 0xC0000135: return 'a DLL the program needs was not found. For a ROCm build that is the SDK\'s bin folder missing from the PATH.'
    case 0xC000007B: return 'a DLL has the wrong architecture, or is damaged (STATUS_INVALID_IMAGE_FORMAT).'
    case 0xC0000139: return 'a DLL does not match the program: it lacks a function the program calls, which is a version mismatch (STATUS_ENTRYPOINT_NOT_FOUND).'
    case 0xC0000142: return 'a DLL failed to initialize (STATUS_DLL_INIT_FAILED).'
    case 0xC0000005: return 'the program crashed (access violation).'
    case 0xC000001D: return 'the program used an instruction this CPU does not have (illegal instruction); a build made for a newer CPU.'
    default: return ''
  }
}
