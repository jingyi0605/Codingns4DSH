declare module 'node:child_process' {
  export interface SpawnSyncOptions {
    encoding?: 'utf8'
    timeout?: number
    windowsHide?: boolean
    shell?: boolean
  }
  export interface SpawnSyncResult {
    status: number | null
    stdout: string
    stderr: string
  }
  export interface ChildStream {
    on(event: 'data', listener: (chunk: Uint8Array | string) => void): this
  }
  export interface ChildProcessWithoutNullStreams {
    readonly stdout: AsyncIterable<string> & ChildStream
    readonly stderr: ChildStream
    kill(signal?: string): boolean
  }
  export function spawnSync(command: string, args?: readonly string[], options?: SpawnSyncOptions): SpawnSyncResult
  export function spawn(command: string, args?: readonly string[], options?: Record<string, unknown>): ChildProcessWithoutNullStreams
}

declare module 'node:fs' {
  export function existsSync(path: string): boolean
  export function readFileSync(path: string, encoding: 'utf8'): string
  export function writeFileSync(path: string, data: string, encoding: 'utf8'): void
  export function rmSync(path: string, options?: { force?: boolean }): void
}

declare module 'node:fs/promises' {
  export function mkdtemp(prefix: string): Promise<string>
  export function readFile(path: string, encoding: 'utf8'): Promise<string>
  export function writeFile(path: string, data: string, options: { encoding: 'utf8'; mode?: number }): Promise<void>
  export function rm(path: string, options?: { force?: boolean; recursive?: boolean }): Promise<void>
}

declare module 'node:os' {
  export function homedir(): string
  export function tmpdir(): string
}

declare module 'node:path' {
  export function join(...paths: string[]): string
}

declare module 'node:readline' {
  export interface ReadlineInterface extends AsyncIterable<string> { close(): void }
  export function createInterface(options: { input: AsyncIterable<string> }): ReadlineInterface
}

declare const process: {
  readonly platform: string
  readonly env: Record<string, string | undefined>
  cwd(): string
}
