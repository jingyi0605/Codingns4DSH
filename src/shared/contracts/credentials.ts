export const CREDENTIALS_FEATURE_NAME = 'credentials'

export type CredentialFieldKind =
  | 'username'
  | 'password'
  | 'token'
  | 'api-key'
  | 'host'
  | 'port'
  | 'private-key'
  | 'custom'

export type CredentialFieldUsage =
  | 'ssh.username'
  | 'ssh.password'
  | 'ssh.askpass'
  | 'http.authorization'
  | 'http.header'
  | 'generic'

export interface CredentialFieldSemanticMetadata {
  readonly kind?: CredentialFieldKind
  readonly usages?: readonly CredentialFieldUsage[]
}

export interface CredentialFieldMetadata {
  readonly name: string
  readonly hasValue: boolean
  readonly kind: CredentialFieldKind
  readonly usages: readonly CredentialFieldUsage[]
}

export interface CredentialMetadata {
  readonly id: string
  readonly label: string
  readonly fields: readonly CredentialFieldMetadata[]
  readonly createdAt: string
  readonly updatedAt: string
}

export interface CredentialListPage {
  readonly items: readonly CredentialMetadata[]
  readonly nextCursor?: string
}

export interface CredentialEnvironmentBinding {
  readonly field: string
  readonly env: string
}

export interface CredentialReference {
  readonly credentialId: string
  readonly bindings: readonly CredentialEnvironmentBinding[]
}

export type CredentialFieldMutation =
  | string
  | { readonly keepExisting: true }
  | { readonly clear: true }

export interface CredentialMutation {
  readonly id: string
  readonly label: string
  readonly fields: Readonly<Record<string, CredentialFieldMutation>>
  readonly fieldMetadata?: Readonly<Record<string, CredentialFieldSemanticMetadata>>
}

export type CredentialErrorCode =
  | 'CREDENTIAL_INVALID'
  | 'CREDENTIAL_STORE_UNAVAILABLE'
  | 'CREDENTIAL_NOT_FOUND'
  | 'CREDENTIAL_FIELD_NOT_FOUND'
  | 'CREDENTIAL_ENV_INVALID'
  | 'CREDENTIAL_ENV_CONFLICT'
  | 'CREDENTIAL_INJECTION_UNSUPPORTED'
  | 'CREDENTIAL_MASTER_PASSWORD_INVALID'
  | 'CREDENTIAL_REQUEST_INVALID'
  | 'CREDENTIAL_REQUEST_EXPIRED'
  | 'CREDENTIAL_REQUEST_REPLAYED'
  | 'CREDENTIAL_REQUEST_REVOKED'
  | 'CREDENTIAL_BROKER_UNAVAILABLE'
  | 'CREDENTIAL_COMMAND_FAILED'

export const CREDENTIAL_ENV_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u

export function defaultCredentialEnvironmentName(field: string): string {
  const value = field.replace(/[^A-Za-z0-9_]/gu, '_').toUpperCase()
  return `CREDENTIAL_${value || 'VALUE'}`
}

export function inferCredentialFieldMetadata(field: string): Required<CredentialFieldSemanticMetadata> {
  const normalized = field.trim().toLocaleLowerCase()
  if (normalized === 'username' || normalized === 'user' || normalized === 'login') {
    return { kind: 'username', usages: ['ssh.username', 'generic'] }
  }
  if (normalized === 'password' || normalized === 'pass' || normalized === 'pwd') {
    return { kind: 'password', usages: ['ssh.password', 'ssh.askpass', 'generic'] }
  }
  if (normalized === 'token' || normalized === 'access_token' || normalized === 'accesstoken') {
    return { kind: 'token', usages: ['http.authorization', 'generic'] }
  }
  if (normalized === 'apikey' || normalized === 'api_key' || normalized === 'api-key') {
    return { kind: 'api-key', usages: ['http.header', 'generic'] }
  }
  if (normalized === 'host' || normalized === 'hostname') return { kind: 'host', usages: ['generic'] }
  if (normalized === 'port') return { kind: 'port', usages: ['generic'] }
  if (normalized === 'privatekey' || normalized === 'private_key' || normalized === 'private-key') {
    return { kind: 'private-key', usages: ['generic'] }
  }
  return { kind: 'custom', usages: ['generic'] }
}

export interface CredentialBrokerBinding {
  readonly field: string
  readonly env: string
  readonly kind: CredentialFieldKind
  readonly usages: readonly CredentialFieldUsage[]
}

export interface CredentialBrokerIssueResult {
  readonly requestCode: string
  readonly label: string
  readonly expiresAt: string
  readonly bindings: readonly CredentialBrokerBinding[]
}

export interface CredentialBrokerDescription {
  readonly handle: string
  readonly label: string
  readonly expiresAt: string
  readonly bindings: readonly CredentialBrokerBinding[]
}

export interface CredentialBrokerProcessEnvironment {
  readonly endpoint: string
  readonly token: string
  readonly sessionId: string
  readonly path: string
}

export function isCredentialReference(value: unknown): value is CredentialReference {
  if (!isRecord(value) || typeof value.credentialId !== 'string' || !Array.isArray(value.bindings)) return false
  return value.bindings.every((binding) => isRecord(binding) && typeof binding.field === 'string' && typeof binding.env === 'string')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
