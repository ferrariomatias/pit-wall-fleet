// Just the piece of Node's API the worker uses, so `tsc` passes without @types/node.
declare module 'node:child_process' {
  export function execFile(
    file: string,
    args: readonly string[],
    options: { timeout?: number; maxBuffer?: number },
    callback: (error: (Error & { code?: string | number | null }) | null, stdout: string, stderr: string) => void
  ): unknown
}
