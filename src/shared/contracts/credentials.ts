export const CREDENTIALS_FEATURE_NAME = 'credentials'

export interface CredentialFieldMetadata {
  readonly name: string
  readonly hasValue: boolean
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

export const CREDENTIAL_ENV_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u

export function defaultCredentialEnvironmentName(field: string): string {
  const value = field.replace(/[^A-Za-z0-9_]/gu, '_').toUpperCase()
  return `CREDENTIAL_${value || 'VALUE'}`
}

export function isCredentialReference(value: unknown): value is CredentialReference {
  if (!isRecord(value) || typeof value.credentialId !== 'string' || !Array.isArray(value.bindings)) return false
  return value.bindings.every((binding) => isRecord(binding) && typeof binding.field === 'string' && typeof binding.env === 'string')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
