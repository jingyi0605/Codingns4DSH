import type { CodingNsCliAdapterDescriptor } from './cli-adapter.js'

export type CliManagementAction = 'install' | 'update'

export interface CliManagementMethod {
  readonly id: string
  readonly label: string
  readonly command: string | null
  readonly instructions: string
  readonly executable: boolean
}

export interface CliManagementPlan {
  readonly adapter: CodingNsCliAdapterDescriptor
  readonly action: CliManagementAction
  readonly platform: string
  readonly sourceUrl: string
  readonly methods: readonly CliManagementMethod[]
  /** Host-selected installer or verified updater; no user method choice is needed. */
  readonly automaticMethodId?: string
  readonly fingerprint: string
}

export interface CliManagementOperation {
  readonly id: string
  readonly adapterId: string
  readonly action: CliManagementAction
  readonly state: 'running' | 'succeeded' | 'failed' | 'cancelled'
  readonly output: string
  readonly error?: string
  readonly adapter?: CodingNsCliAdapterDescriptor
}
