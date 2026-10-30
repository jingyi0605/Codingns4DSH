import { createElement } from 'react'
import type { ReactElement } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { UserTextRule } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { InputTriggerPick, InputTriggerSource } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import type { CredentialMetadata } from '../shared/contracts/credentials.js'
import { encodeCredentialCarrier } from '../shared/credential-carrier.js'
import { CODINGNS_RPC_CHANNEL } from '../shared/contracts/transport.js'
import type { CodingNsRpcClient } from './features/types.js'
import type { CodingNsLocale } from './locale.js'
import { bareSlashSpanAtCaret } from './command-token.js'

const CREDENTIAL_INPUT_SOURCE = 'codingns-credentials'
const CREDENTIAL_PAGE_SIZE = 32

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface UserTextDataMap {
    credential: { readonly label: string }
  }
}

interface InputTriggersService {
  registerSource(source: InputTriggerSource): () => void
}

interface CommandUiService {
  register(contribution: CredentialCommandContribution): () => void
}

interface CredentialCommandContribution {
  readonly name: string
  label?(): string
  description?(): string
  readonly icon?: unknown
  available(session: { readonly sessionId: string }): boolean
  readonly ui: {
    readonly kind: 'popupSelect'
    readonly searchMode?: 'substring' | 'fuzzy-label'
    searchLabels?(): { readonly placeholder: string; readonly empty: string; readonly noResults: string }
    options(session: { readonly sessionId: string }, signal: AbortSignal): Promise<readonly { readonly id: string; readonly label: string; readonly detail?: string }[]>
    onSelect(option: { readonly id: string; readonly label: string }, session: { readonly sessionId: string }): void | Promise<void>
  }
}

interface SessionsService {
  scope(id: string): Context | undefined
}

interface ConversationService {
  readonly input: { for(ctx: Context): CredentialSessionInput }
}

interface CredentialSessionInput {
  readonly state: { getSnapshot(): { readonly draft: string; readonly draftRev?: number } }
  caretSpan?(): { readonly start: number; readonly end: number; readonly draftRev?: number }
  insertReference?(reference: { readonly source: string; readonly ref: string; readonly label: string; readonly appearance: 'session'; readonly clipboardText: string }, span: { readonly start: number; readonly end: number; readonly draftRev: number }): boolean
  setDraft?(text: string): void
  notify?(level: 'info' | 'error', text: string): void
}

interface UiConversationService {
  readonly userText?: {
    register(rule: UserTextRule<'credential'>): () => void
  }
}

interface CredentialReferenceSelection {
  readonly credentialId: string
  readonly label: string
}

export function registerCredentialReferenceSource(ctx: Context, rpc: CodingNsRpcClient, locale: CodingNsLocale): () => void {
  const fiber = ctx.inject(['inputTriggers'], (scope) => {
    const inputTriggers = readService<InputTriggersService>(scope, 'inputTriggers')
    if (inputTriggers === undefined) return
    const source: InputTriggerSource = {
      trigger: '/',
      name: CREDENTIAL_INPUT_SOURCE,
      order: 1,
      showGroupTitle: false,
      async candidates(session, request) {
        const page = await listCredentials(rpc, request.query, request.signal)
        return page.items.map((item) => ({
          name: item.id,
          label: item.label,
          description: item.fields.map((field) => field.name).join(', '),
          value: encodeSelection({ credentialId: item.id, label: item.label }),
        }))
      },
      onPick(pick: InputTriggerPick) {
        const selection = decodeSelection(pick.candidate.value)
        if (selection === undefined) return { text: '' }
        return {
          insert: {
            source: CREDENTIAL_INPUT_SOURCE,
            ref: encodeSelection(selection),
            label: selection.label,
            appearance: 'session',
            clipboardText: `@${selection.label}`,
          },
        }
      },
      codec: {
        clipboardText(ref) {
          const selection = decodeSelection(ref)
          return selection === undefined ? '@credential' : `@${selection.label}`
        },
        async serialize(ref) {
          const selection = decodeSelection(ref)
          if (selection === undefined) throw new Error('Credential reference is invalid')
          return encodeCredentialCarrier(selection.credentialId, selection.label)
        },
      },
    }
    try {
      scope.effect(() => inputTriggers.registerSource(source), 'codingns: credential slash source')
    } catch {
      // Older DSH builds may expose a partial inputTriggers service.
    }
  })
  return () => { void fiber.dispose() }
}

export function registerCredentialCommand(ctx: Context, rpc: CodingNsRpcClient, locale: CodingNsLocale): () => void {
  const fiber = ctx.inject(['commandUi'], (scope) => {
    const commandUi = readService<CommandUiService>(scope, 'commandUi')
    if (commandUi === undefined || typeof commandUi.register !== 'function') return
    const t = locale.bind('codingns')
    scope.effect(() => commandUi.register({
      name: 'credentials',
      label: () => t('credentials.commandLabel'),
      description: () => t('credentials.commandDescription'),
      icon: CredentialIcon,
      available: () => true,
      ui: {
        kind: 'popupSelect',
        searchMode: 'fuzzy-label',
        searchLabels: () => ({
          placeholder: t('credentials.referenceSearch'),
          empty: t('credentials.referenceEmpty'),
          noResults: t('credentials.referenceEmpty'),
        }),
        async options(_session, signal) {
          const items = await listAllCredentials(rpc, signal)
          return items.map((item) => ({
            id: item.id,
            label: item.label,
            detail: item.fields.map((field) => field.name).join(', '),
          }))
        },
        onSelect(option, session) {
          const sessions = readService<SessionsService>(scope, 'sessions')
          const conversation = readService<ConversationService>(scope, 'conversation')
          const sessionContext = sessions?.scope(session.sessionId)
          const input = sessionContext === undefined ? undefined : conversation?.input.for(sessionContext)
          if (input === undefined) return
          const snapshot = input.state.getSnapshot()
          const selection = input.caretSpan?.()
          const span = bareSlashSpanAtCaret(snapshot.draft, snapshot.draftRev ?? selection?.draftRev ?? 0, selection)
            ?? (selection !== undefined && snapshot.draftRev !== undefined
              ? { start: selection.start, end: selection.end, draftRev: snapshot.draftRev }
              : { start: snapshot.draft.length, end: snapshot.draft.length, draftRev: snapshot.draftRev ?? 0 })
          const reference = {
            source: CREDENTIAL_INPUT_SOURCE,
            ref: encodeSelection({ credentialId: option.id, label: option.label }),
            label: option.label,
            appearance: 'session' as const,
            clipboardText: `@${option.label}`,
          }
          if (input.insertReference?.(reference, span) === true) return
          if (input.setDraft !== undefined) input.setDraft(`${snapshot.draft.slice(0, span.start)}${encodeCredentialCarrier(option.id, option.label)}${snapshot.draft.slice(span.end)}`)
          else input.notify?.('error', t('credentials.commandUnavailable'))
        },
      },
    }), 'codingns: credential add command')
  })
  return () => { void fiber.dispose() }
}

function CredentialIcon({ size = 16 }: { readonly size?: number }): ReactElement {
  return createElement('svg', {
    width: size,
    height: size,
    viewBox: '0 0 16 16',
    fill: 'none',
    'aria-hidden': true,
    focusable: false,
    stroke: 'currentColor',
    strokeWidth: 1.2,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
  },
  createElement('circle', { cx: 5.1, cy: 8.1, r: 2.7 }),
  createElement('path', { d: 'M7.5 6.3 14 2.9l-.8 2 1.5.7-1.4 1.2.9 1.5-2.1-.2-1 1.7-.9-1.8-2.2.4' }),
  )
}

export function registerCredentialUserTextRule(ctx: Context): () => void {
  const fiber = ctx.inject(['uiConversation'], (scope) => {
    const conversation = readService<UiConversationService>(scope, 'uiConversation')
    const userText = conversation?.userText
    if (userText === undefined || typeof userText.register !== 'function') return
    scope.effect(() => userText.register({
      id: 'credential',
      order: 12,
      match(text, from) {
        const pattern = /@\[([^\]\n]*)\]\(codingns-credential:([^\)\s]+)\)/gu
        pattern.lastIndex = from
        const match = pattern.exec(text)
        if (match === null || match[1] === undefined) return undefined
        let label = match[1]
        try { label = decodeURIComponent(label) } catch { /* keep the visible fallback */ }
        return {
          id: 'credential',
          start: match.index,
          end: match.index + match[0].length,
          data: { label },
        }
      },
    }), 'codingns: credential user-text rule')
  })
  return () => { void fiber.dispose() }
}

async function listCredentials(
  rpc: CodingNsRpcClient,
  query: string,
  signal: AbortSignal | undefined,
  cursor?: string,
): Promise<{ readonly items: readonly CredentialMetadata[]; readonly nextCursor?: string }> {
  const result = await rpc.call(CODINGNS_RPC_CHANNEL, 'credentials/list', {
    query,
    limit: CREDENTIAL_PAGE_SIZE,
    ...(cursor === undefined ? {} : { cursor }),
  }, signal)
  if (!result.ok || !isRecord(result.value) || !Array.isArray(result.value.items)) {
    throw new Error('Credential list failed')
  }
  return {
    items: result.value.items.filter(isCredentialMetadata),
    ...(typeof result.value.nextCursor === 'string' ? { nextCursor: result.value.nextCursor } : {}),
  }
}

async function listAllCredentials(rpc: CodingNsRpcClient, signal: AbortSignal): Promise<readonly CredentialMetadata[]> {
  const items: CredentialMetadata[] = []
  let cursor: string | undefined
  do {
    signal.throwIfAborted()
    const page = await listCredentials(rpc, '', signal, cursor)
    items.push(...page.items)
    cursor = page.nextCursor
  } while (cursor !== undefined)
  return items
}

function encodeSelection(selection: CredentialReferenceSelection): string {
  return encodeURIComponent(`${selection.credentialId}\u0000${selection.label}`)
}

function decodeSelection(value: string | undefined): CredentialReferenceSelection | undefined {
  if (typeof value !== 'string') return undefined
  let decoded: string
  try { decoded = decodeURIComponent(value) } catch { return undefined }
  const separator = decoded.indexOf('\u0000')
  if (separator <= 0) return undefined
  const credentialId = decoded.slice(0, separator).trim()
  const label = decoded.slice(separator + 1).trim()
  return credentialId === '' || label === '' ? undefined : { credentialId, label }
}

function isCredentialMetadata(value: unknown): value is CredentialMetadata {
  return isRecord(value)
    && typeof value.id === 'string'
    && typeof value.label === 'string'
    && Array.isArray(value.fields)
    && value.fields.every((field) => isRecord(field) && typeof field.name === 'string' && typeof field.hasValue === 'boolean')
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readService<T>(ctx: Context, name: string): T | undefined {
  try { return ctx.get(name) as T | undefined } catch { return undefined }
}
