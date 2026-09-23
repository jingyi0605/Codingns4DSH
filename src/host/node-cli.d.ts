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
    readonly pid?: number
    readonly stdout: AsyncIterable<string> & ChildStream
    readonly stderr: ChildStream
    kill(signal?: string): boolean
    unref(): void
  }
  export function spawnSync(command: string, args?: readonly string[], options?: SpawnSyncOptions): SpawnSyncResult
  export function spawn(command: string, args?: readonly string[], options?: Record<string, unknown>): ChildProcessWithoutNullStreams
}

declare module 'node:fs' {
  export const constants: { readonly X_OK: number }
  export interface Dirent {
    readonly name: string
    isDirectory(): boolean
    isFile(): boolean
  }
  export function existsSync(path: string): boolean
  export function accessSync(path: string, mode?: number): void
  export function readFileSync(path: string, encoding: 'utf8'): string
  export function writeFileSync(path: string, data: string, encoding: 'utf8'): void
  export function rmSync(path: string, options?: { force?: boolean }): void
}

declare module 'node:fs/promises' {
  import type { Dirent } from 'node:fs'
  export interface FileHandle {
    read(buffer: Uint8Array, offset: number, length: number, position: number): Promise<{ bytesRead: number; buffer: Uint8Array }>
    close(): Promise<void>
  }
  export interface Stats { isDirectory(): boolean; isFile(): boolean }
  export function open(path: string, flags: string): Promise<FileHandle>
  export function readdir(path: string, options: { withFileTypes: true }): Promise<Dirent[]>
  export function stat(path: string): Promise<Stats>
  export function mkdtemp(prefix: string): Promise<string>
  export function readFile(path: string, encoding: 'utf8'): Promise<string>
  export function writeFile(
    path: string,
    data: string,
    options: { encoding: 'utf8'; mode?: number; flag?: string },
  ): Promise<void>
  export function mkdir(path: string, options?: { recursive?: boolean; mode?: number }): Promise<void>
  export function rename(oldPath: string, newPath: string): Promise<void>
  export function rm(path: string, options?: { force?: boolean; recursive?: boolean }): Promise<void>
}

declare module 'node:os' {
  export function homedir(): string
  export function tmpdir(): string
}

declare module 'node:path' {
  export function basename(path: string): string
  export function dirname(path: string): string
  export function join(...paths: string[]): string
  export function isAbsolute(path: string): boolean
  export function normalize(path: string): string
  export function relative(from: string, to: string): string
  export const sep: string
}

declare module 'node:crypto' {
  interface Hash {
    update(data: string | Uint8Array): this
    digest(encoding: 'hex'): string
  }
  export function createHash(algorithm: string): Hash
  export function randomUUID(): string
  export function timingSafeEqual(left: Uint8Array, right: Uint8Array): boolean
}

declare module 'node:url' {
  export function fileURLToPath(url: URL | string): string
}

declare module 'node:readline' {
  export interface ReadlineInterface extends AsyncIterable<string> { close(): void }
  export function createInterface(options: { input: AsyncIterable<string> }): ReadlineInterface
}

declare const process: {
  readonly pid: number
  readonly platform: string
  readonly argv: readonly string[]
  readonly execPath: string
  readonly env: Record<string, string | undefined>
  cwd(): string
  kill(pid: number, signal?: string): void
}
