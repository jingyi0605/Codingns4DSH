declare module 'node:net' {
  interface Socket {
    pipe(destination: Socket): Socket
    destroy(error?: Error): void
    on(event: 'error' | 'close', listener: (...args: unknown[]) => void): this
    once(event: 'connect' | 'error' | 'close', listener: (...args: unknown[]) => void): this
    removeListener(event: 'error', listener: (...args: unknown[]) => void): this
  }

  interface Server {
    listen(options: { port: number; host: string }, callback?: () => void): this
    close(callback?: (error?: Error) => void): this
    once(event: 'error', listener: (error: Error) => void): this
    removeListener(event: 'error', listener: (error: Error) => void): this
    address(): { port: number } | string | null
  }

  export function createServer(listener: (socket: Socket) => void): Server
  export function connect(options: { port: number; host: string }): Socket
}

declare module 'node:os' {
  interface NetworkInterfaceInfo {
    address: string
    family: string | number
    internal: boolean
  }

  export function networkInterfaces(): Record<string, NetworkInterfaceInfo[] | undefined>
}
