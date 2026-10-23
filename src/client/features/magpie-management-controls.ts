import { createElement, useEffect, useMemo, useState } from 'react'
import type { ReactElement } from 'react'
import type {
  MagpieAccountManagementUpdate,
  MagpieAccountManagementRecord,
  MagpieManagementSnapshot,
  MagpieProviderManagementRecord,
  MagpieProviderManagementUpdate,
  MagpieRoutingGroupManagementRecord,
  MagpieRoutingGroupManagementUpdate,
} from '../../shared/contracts/magpie-management.js'
import { MagpieProviderLogo } from './magpie-provider-logo.js'

type Translate = (key: string, params?: Record<string, string | number>) => string

interface SelectOption {
  readonly value: string
  readonly label: string
}

/** Magpie's own names for routing-group policies; a value it does not name stays as returned. */
const ROUTING_POLICY_LABELS: Readonly<Record<string, string>> = {
  smart: 'magpie.management.routing.smart',
  order: 'magpie.management.routing.order',
  rotate: 'magpie.management.routing.rotate',
  usage: 'magpie.management.routing.usage',
  pace: 'magpie.management.routing.pace',
  weight: 'magpie.management.routing.weight',
  manual: 'magpie.management.routing.manual',
  free: 'magpie.management.routing.free',
}
const STAYS_POLICY_LABELS: Readonly<Record<string, string>> = {
  auto: 'magpie.management.stays.auto',
  session: 'magpie.management.stays.session',
  turn: 'magpie.management.stays.turn',
  off: 'magpie.management.stays.off',
  strict: 'magpie.management.stays.strict',
}
/**
 * The policies a group save may write.
 *
 * `free` is read (a newer Magpie, or Magpie's own editor, can set it) and shown by its business
 * name, but is not offered here: this Host's write allowlist has only verified the ones below.
 */
const ROUTING_POLICY_VALUES = ['smart', 'order', 'rotate', 'usage', 'pace', 'weight', 'manual'] as const
const MANUAL_ROUTING = 'manual'
const STAYS_POLICY_VALUES = ['auto', 'session', 'turn', 'off', 'strict'] as const

/** Show a policy by Magpie's business name while the Host keeps the raw value for writes. */
export function magpiePolicyLabel(kind: 'routing' | 'stays', value: string, t: Translate): string {
  const key = (kind === 'routing' ? ROUTING_POLICY_LABELS : STAYS_POLICY_LABELS)[value]
  return key === undefined ? value : t(key)
}

function policyOptions(kind: 'routing' | 'stays', values: readonly string[], current: string, t: Translate): readonly SelectOption[] {
  const options = values.map(value => ({ value, label: magpiePolicyLabel(kind, value, t) }))
  // Keep a policy this Host does not offer visible rather than blanking the select:
  // a newer Magpie mode or a gateway plugin's routing must still read back.
  return values.includes(current) ? options : [...options, { value: current, label: magpiePolicyLabel(kind, current, t) }]
}

export function MagpieProvidersPage({ snapshot, t, onUpdate, onAccountUpdate, writing }: {
  readonly snapshot: MagpieManagementSnapshot | null
  readonly t: Translate
  readonly onUpdate: (update: MagpieProviderManagementUpdate) => Promise<void>
  readonly onAccountUpdate: (update: MagpieAccountManagementUpdate) => Promise<void>
  readonly writing: boolean
}): ReactElement {
  const providers = snapshot?.providers ?? []
  const [selectedId, setSelectedId] = useState<string | null>(providers[0]?.id ?? null)
  const selected = providers.find(provider => provider.id === selectedId) ?? providers[0] ?? null
  const unlinkedAccounts = snapshot?.accountStatus === 'available'
    ? snapshot.accounts.filter(account => !providers.some(provider => accountBelongsToProvider(account, provider)))
    : []
  useEffect(() => {
    if (selected !== null && selected.id !== selectedId) setSelectedId(selected.id)
  }, [selected, selectedId])

  return createElement('div', { className: 'codingns-magpie-view' },
    snapshot?.providerStatus === 'unavailable'
      ? createElement(PanelEmpty, { message: t('magpie.management.providersUnavailable') })
      : providers.length === 0
        ? createElement(PanelEmpty, { message: t('magpie.management.noProviders') })
        : createElement('div', { className: 'codingns-magpie-management-grid' },
      createElement('nav', { className: 'codingns-magpie-panel codingns-magpie-management-list', 'aria-label': t('magpie.management.providers') },
        ...providers.map(provider => createElement('button', {
          key: provider.id,
          type: 'button',
          className: `codingns-magpie-management-row${provider.id === selected?.id ? ' is-active' : ''}`,
          'aria-pressed': provider.id === selected?.id,
          onClick: () => setSelectedId(provider.id),
        },
          createElement(MagpieProviderLogo, { identities: [provider.accountAgent, provider.id, provider.name], logoDataUrl: provider.logoDataUrl, size: 24, className: 'codingns-magpie-provider-logo codingns-magpie-provider-logo-compact' }),
          createElement('span', { className: 'codingns-magpie-management-row-main' },
            createElement('strong', undefined, provider.name),
            createElement('small', undefined, provider.id),
          ),
          createElement(StateBadge, { state: provider.state === 'on' ? 'on' : provider.state === 'off' ? 'off' : 'unknown', t }),
        )),
      ),
      selected === null
        ? createElement(PanelEmpty, { message: t('magpie.management.noProviders') })
        : createElement(ProviderEditor, { provider: selected, snapshot, t, onUpdate, onAccountUpdate, writing }),
    ),
    unlinkedAccounts.length > 0 && createElement('section', { className: 'codingns-magpie-panel codingns-magpie-management-editor' },
      createElement('div', { className: 'codingns-magpie-panel-head' }, createElement('div', undefined,
        createElement('h2', undefined, t('magpie.management.unlinkedAccounts')),
        createElement('p', undefined, t('magpie.management.unlinkedAccountsNote')),
      )),
      createElement(AccountGrid, {
        accounts: unlinkedAccounts,
        allAccounts: snapshot?.accounts ?? [],
        accountApiStatus: snapshot?.accountApiStatus ?? 'unavailable',
        writing,
        t,
        onUpdate: onAccountUpdate,
      }),
    ),
  )
}

function ProviderEditor({ provider, snapshot, t, onUpdate, onAccountUpdate, writing }: {
  readonly provider: MagpieProviderManagementRecord
  readonly snapshot: MagpieManagementSnapshot | null
  readonly t: Translate
  readonly onUpdate: (update: MagpieProviderManagementUpdate) => Promise<void>
  readonly onAccountUpdate: (update: MagpieAccountManagementUpdate) => Promise<void>
  readonly writing: boolean
}): ReactElement {
  const editableEndpoints = provider.endpoints.filter(endpoint => endpoint.editable)
  const endpointKey = editableEndpoints.map(endpoint => `${endpoint.field}:${endpoint.url}`).join('|')
  const modelsKey = provider.models.map(model => `${model.id}:${model.exposed ? 'on' : 'off'}`).join('|')
  const [name, setName] = useState(provider.name)
  const [endpointField, setEndpointField] = useState(editableEndpoints[0]?.field ?? '')
  const [endpointUrl, setEndpointUrl] = useState(editableEndpoints[0]?.url ?? '')
  const [enabledModelIds, setEnabledModelIds] = useState<readonly string[]>(() => provider.models.filter(model => model.exposed).map(model => model.id))
  const [review, setReview] = useState<MagpieProviderManagementUpdate | null>(null)
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState('')
  useEffect(() => {
    setName(provider.name)
    setEndpointField(editableEndpoints[0]?.field ?? '')
    setEndpointUrl(editableEndpoints[0]?.url ?? '')
    setEnabledModelIds(provider.models.filter(model => model.exposed).map(model => model.id))
    setReview(null)
  }, [provider.id, provider.name, endpointKey, modelsKey])

  const endpoint = editableEndpoints.find(item => item.field === endpointField)
  const proposed = (): MagpieProviderManagementUpdate | null => {
    const models = provider.models.filter(model => enabledModelIds.includes(model.id)).map(model => model.id)
    const currentModels = provider.models.filter(model => model.exposed).map(model => model.id)
    const update: MagpieProviderManagementUpdate = {
      id: provider.id,
      ...(name.trim() === provider.name ? {} : { name: name.trim() }),
      ...(endpoint === undefined || endpointUrl.trim() === endpoint.url ? {} : { endpointField: endpoint.field, endpointUrl: endpointUrl.trim() }),
      ...(provider.modelsEditable && models.join('\n') !== currentModels.join('\n') ? { models } : {}),
    }
    return Object.keys(update).length === 1 ? null : update
  }
  const requestReview = (): void => {
    setNotice('')
    setReview(proposed())
  }
  const apply = async (): Promise<void> => {
    if (review === null) return
    setSaving(true)
    setNotice('')
    try {
      await onUpdate(review)
      setReview(null)
      setNotice(t('magpie.management.saved'))
    } catch {
      setNotice(t('magpie.management.saveFailed'))
    } finally {
      setSaving(false)
    }
  }
  const modelControlsDisabled = !provider.modelsEditable || saving || writing
  const toggleModel = (id: string, enabled: boolean): void => {
    setEnabledModelIds(current => enabled
      ? current.includes(id) ? current : [...current, id]
      : current.filter(item => item !== id))
  }
  const setAllModels = (enabled: boolean): void => {
    setEnabledModelIds(enabled ? provider.models.map(model => model.id) : [])
  }

  return createElement('section', { className: 'codingns-magpie-panel codingns-magpie-management-editor' },
    createElement('div', { className: 'codingns-magpie-panel-head' }, createElement('div', undefined,
      createElement('div', { className: 'codingns-magpie-provider-heading' },
        createElement(MagpieProviderLogo, { identities: [provider.accountAgent, provider.id, provider.name], logoDataUrl: provider.logoDataUrl, size: 30, className: 'codingns-magpie-provider-logo' }),
        createElement('h2', undefined, provider.name),
      ),
      createElement('p', undefined, provider.id),
    )),
    createElement('div', { className: 'codingns-magpie-management-statusline' },
      createElement(StateBadge, { state: provider.state === 'on' ? 'on' : provider.state === 'off' ? 'off' : 'unknown', t }),
      provider.state !== 'unknown' && createElement('button', {
        type: 'button',
        className: 'codingns-magpie-text-button',
        disabled: saving || writing,
        onClick: () => {
          setNotice('')
          setReview({ id: provider.id, on: provider.state === 'off' })
        },
      }, t(provider.state === 'on' ? 'magpie.management.turnProviderOff' : 'magpie.management.turnProviderOn')),
      provider.account !== null && createElement('span', undefined, t('magpie.management.providerAccount', { account: provider.account })),
      createElement('span', undefined, provider.modelCount === null ? t('magpie.management.modelCountUnknown') : t('magpie.management.modelCounts', { exposed: provider.exposedModelCount ?? provider.models.length, total: provider.modelCount })),
    ),
    createElement(ProviderAccounts, { provider, snapshot, t, onUpdate: onAccountUpdate, writing }),
    createElement('label', { className: 'codingns-magpie-field' },
      createElement('span', undefined, t('magpie.management.providerName')),
      createElement('input', { value: name, maxLength: 80, onChange: (event: { currentTarget: { value: string } }) => setName(event.currentTarget.value) }),
    ),
    editableEndpoints.length > 0 && createElement('div', { className: 'codingns-magpie-field-row' },
      createElement('label', { className: 'codingns-magpie-field' },
        createElement('span', undefined, t('magpie.management.endpointType')),
        createElement('select', {
          value: endpointField,
          onChange: (event: { currentTarget: { value: string } }) => {
            const next = provider.endpoints.find(item => item.field === event.currentTarget.value)
            if (next !== undefined) {
              setEndpointField(next.field)
              setEndpointUrl(next.url)
            }
          },
        }, ...editableEndpoints.map(item => createElement('option', { key: item.field, value: item.field }, item.field))),
      ),
      createElement('label', { className: 'codingns-magpie-field' },
        createElement('span', undefined, t('magpie.management.endpointUrl')),
        createElement('input', { value: endpointUrl, maxLength: 2048, onChange: (event: { currentTarget: { value: string } }) => setEndpointUrl(event.currentTarget.value), spellCheck: false }),
      ),
    ),
    createElement('div', { className: 'codingns-magpie-field' },
      createElement('span', undefined, t('magpie.management.exposedModels')),
      createElement('small', undefined, t(provider.modelsEditable ? 'magpie.management.providerModelsHint' : 'magpie.management.providerModelsUnavailable')),
      provider.models.length === 0
        ? createElement('div', { className: 'codingns-magpie-inline-empty' }, t('magpie.management.noProviderModels'))
        : createElement('div', { className: 'codingns-magpie-model-editor', role: 'group', 'aria-label': t('magpie.management.exposedModels') },
          createElement('div', { className: 'codingns-magpie-model-actions' },
            createElement('button', { type: 'button', disabled: modelControlsDisabled, onClick: () => setAllModels(true) }, t('magpie.management.enableAllModels')),
            createElement('button', { type: 'button', disabled: modelControlsDisabled, onClick: () => setAllModels(false) }, t('magpie.management.disableAllModels')),
          ),
          ...provider.models.map(model => createElement('label', { key: model.id, className: `codingns-magpie-model-option${model.exposed ? ' is-exposed' : ''}`, 'data-model-id': model.id },
            createElement('input', {
              type: 'checkbox',
              checked: enabledModelIds.includes(model.id),
              disabled: modelControlsDisabled,
              'aria-label': model.id,
              onChange: (event: { currentTarget: { checked: boolean } }) => toggleModel(model.id, event.currentTarget.checked),
            }),
            createElement('span', { className: 'codingns-magpie-model-option-copy' },
              createElement('strong', { className: 'codingns-magpie-model-name', title: model.name ?? model.id }, model.name ?? model.id),
              createElement('code', { className: 'codingns-magpie-model-id', title: model.id }, model.id),
            ),
          )),
        ),
    ),
    review !== null && createElement('div', { className: 'codingns-magpie-confirm' },
      createElement('strong', undefined, t('magpie.management.reviewProvider')),
      createElement('span', undefined, summarizeProviderUpdate(review, t)),
      createElement('div', { className: 'codingns-magpie-management-actions' },
        createElement('button', { type: 'button', disabled: saving || writing, onClick: () => setReview(null) }, t('magpie.management.cancel')),
        createElement('button', { type: 'button', className: 'is-primary', disabled: saving || writing, onClick: () => void apply() }, saving || writing ? t('magpie.management.saving') : t('magpie.management.apply')),
      ),
    ),
    notice !== '' && createElement('div', { className: 'codingns-magpie-management-message', role: 'status' }, notice),
    review === null && createElement('div', { className: 'codingns-magpie-management-actions' },
      createElement('button', { type: 'button', disabled: writing, onClick: () => { setName(provider.name); setEndpointUrl(editableEndpoints.find(item => item.field === endpointField)?.url ?? ''); setEnabledModelIds(provider.models.filter(model => model.exposed).map(model => model.id)); setNotice('') } }, t('magpie.management.reset')),
      createElement('button', { type: 'button', className: 'is-primary', disabled: writing || proposed() === null, onClick: requestReview }, t('magpie.management.reviewChanges')),
    ),
  )
}

function ProviderAccounts({ provider, snapshot, t, onUpdate, writing }: {
  readonly provider: MagpieProviderManagementRecord
  readonly snapshot: MagpieManagementSnapshot | null
  readonly t: Translate
  readonly onUpdate: (update: MagpieAccountManagementUpdate) => Promise<void>
  readonly writing: boolean
}): ReactElement {
  if (snapshot?.accountStatus !== 'available') {
    return createElement(PanelEmpty, { message: t('magpie.management.accountsUnavailable') })
  }
  const accounts = snapshot.accounts.filter(account => accountBelongsToProvider(account, provider))
  return createElement('section', undefined,
    createElement('div', { className: 'codingns-magpie-panel-head' }, createElement('div', undefined,
      createElement('h3', undefined, t('magpie.management.accounts')),
      createElement('p', undefined, t('magpie.management.accountRoleNote')),
    )),
    accounts.length === 0
      ? createElement('div', { className: 'codingns-magpie-inline-empty' }, t('magpie.management.noLinkedAccounts'))
      : createElement(AccountGrid, {
        accounts,
        allAccounts: snapshot.accounts,
        accountApiStatus: snapshot.accountApiStatus,
        writing,
        t,
        onUpdate,
      }),
  )
}

function AccountGrid({ accounts, allAccounts, accountApiStatus, writing, t, onUpdate }: {
  readonly accounts: readonly MagpieAccountManagementRecord[]
  readonly allAccounts: readonly MagpieAccountManagementRecord[]
  readonly accountApiStatus: MagpieManagementSnapshot['accountApiStatus']
  readonly writing: boolean
  readonly t: Translate
  readonly onUpdate: (update: MagpieAccountManagementUpdate) => Promise<void>
}): ReactElement {
  const sorted = [...accounts].sort((left, right) => Number(right.active === true) - Number(left.active === true))
  return createElement('div', { className: 'codingns-magpie-management-account-grid' }, ...sorted.map(account => createElement(AccountCard, {
    key: `${account.agent}:${account.user}`,
    account,
    siblingAccounts: allAccounts.filter(item => item.agent.toLocaleLowerCase() === account.agent.toLocaleLowerCase()),
    accountApiStatus,
    writing,
    t,
    onUpdate,
  })))
}

function AccountCard({ account, siblingAccounts, accountApiStatus, writing, t, onUpdate }: {
  readonly account: MagpieAccountManagementRecord
  readonly siblingAccounts: readonly MagpieAccountManagementRecord[]
  readonly accountApiStatus: MagpieManagementSnapshot['accountApiStatus']
  readonly writing: boolean
  readonly t: Translate
  readonly onUpdate: (update: MagpieAccountManagementUpdate) => Promise<void>
}): ReactElement {
  const [reviewOn, setReviewOn] = useState<boolean | null>(null)
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState('')
  const roleKey = account.active === true ? 'magpie.management.primaryAccount' : account.active === false ? 'magpie.management.secondaryAccount' : 'magpie.management.unknown'
  const stateKey = account.on === true
    ? 'magpie.management.inRotation'
    : account.active === true
      ? 'magpie.management.primaryPaused'
      : account.on === false
        ? 'magpie.management.outOfRotation'
        : 'magpie.management.unknown'
  const activeInRotation = siblingAccounts.filter(item => item.on === true).length
  const isLastInRotation = account.on === true && activeInRotation <= 1
  const apply = async (): Promise<void> => {
    if (reviewOn === null) return
    setSaving(true)
    setNotice('')
    try {
      await onUpdate({ agent: account.agent, user: account.user, on: reviewOn })
      setReviewOn(null)
      setNotice(t('magpie.management.saved'))
    } catch {
      setNotice(t('magpie.management.accountSaveFailed'))
    } finally {
      setSaving(false)
    }
  }

  return createElement('article', { className: 'codingns-magpie-panel codingns-magpie-management-account' },
    createElement('div', { className: 'codingns-magpie-quota-topline' },
      createElement(MagpieProviderLogo, { identities: [account.agent], size: 34, className: 'codingns-magpie-quota-icon codingns-magpie-provider-logo' }),
      createElement('div', undefined, createElement('h2', undefined, account.alias ?? account.user), createElement('p', undefined, `${account.agent}${account.plan ? ` · ${account.plan}` : ''}`)),
    ),
    createElement('div', { className: 'codingns-magpie-management-statusline' },
      createElement(StateBadge, { state: account.active === true ? 'on' : account.active === false ? 'off' : 'unknown', label: t(roleKey), t }),
      createElement(StateBadge, { state: account.on === true ? 'on' : account.on === false ? 'off' : 'unknown', label: t(stateKey), t }),
    ),
    createElement('div', { className: 'codingns-magpie-management-actions' },
      createElement('button', {
        type: 'button',
        className: 'codingns-magpie-text-button',
        disabled: accountApiStatus !== 'available' || account.on === null || saving || writing || isLastInRotation,
        title: accountApiStatus === 'available' ? undefined : t('magpie.management.accountApiRequired'),
        onClick: () => {
          setNotice('')
          setReviewOn(account.on !== true)
        },
      }, t(account.on === true ? account.active === true ? 'magpie.management.pausePrimary' : 'magpie.management.removeFromRotation' : 'magpie.management.addToRotation')),
      isLastInRotation && createElement('small', undefined, t('magpie.management.lastAccountInRotation')),
    ),
    account.balance !== null && createElement('div', { className: 'codingns-magpie-management-balance' }, account.balance),
    account.windows.length === 0
      ? createElement('div', { className: 'codingns-magpie-inline-empty' }, t('magpie.management.noAccountWindows'))
      : account.windows.map(window => createElement('div', { key: window.name, className: 'codingns-magpie-management-window' },
        createElement('div', { className: 'codingns-magpie-quota-window-head' }, createElement('strong', undefined, window.name), createElement('span', undefined, window.display ?? (window.remaining === null ? '—' : t('magpie.remaining', { percent: Math.round(window.remaining) })))),
        window.used !== null && window.remaining !== null && createElement('div', { className: 'codingns-magpie-track quota-track' }, createElement('span', { style: { width: `${Math.max(0, Math.min(100, window.used))}%` } })),
        window.resetsAt !== null && createElement('small', undefined, t('magpie.resets', { time: window.resetsAt })),
      )),
    account.readAt !== null && createElement('small', { className: 'codingns-magpie-management-readat' }, t('magpie.management.readAt', { time: account.readAt })),
    reviewOn !== null && createElement('div', { className: 'codingns-magpie-confirm' },
      createElement('strong', undefined, t('magpie.management.reviewAccount')),
      createElement('span', undefined, t(reviewOn ? 'magpie.management.reviewAccountOn' : 'magpie.management.reviewAccountOff', { account: account.alias ?? account.user })),
      createElement('div', { className: 'codingns-magpie-management-actions' },
        createElement('button', { type: 'button', disabled: saving || writing, onClick: () => setReviewOn(null) }, t('magpie.management.cancel')),
        createElement('button', { type: 'button', className: 'is-primary', disabled: saving || writing, onClick: () => void apply() }, saving || writing ? t('magpie.management.saving') : t('magpie.management.apply')),
      ),
    ),
    notice !== '' && createElement('div', { className: 'codingns-magpie-management-message', role: 'status' }, notice),
  )
}

interface GroupDraft {
  readonly name: string
  readonly models: readonly string[]
  readonly routing: string
  readonly stays: string
  /** The member a manual group sends every request to, as a member id. */
  readonly pick: string
  readonly unlists: boolean
  readonly fast: readonly string[]
  /** `0` for the largest member's window, `-1` for the smallest, or that many tokens. */
  readonly context: number
  /** The levels to offer; empty means the levels every member shares. */
  readonly levels: readonly string[]
  /** `'auto'` picks each turn's level with a classifier; empty leaves it to the Agent. */
  readonly effort: string
  readonly classifier: string
}

/** Magpie's `provider.MemberEfforts`, in the order its editor lists them. */
const MEMBER_LEVELS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
const GROUP_EFFORT_AUTO = 'auto'
const CONTEXT_LARGEST = 0
const CONTEXT_SMALLEST = -1

export interface GroupModelCandidate {
  readonly id: string
  readonly name: string | null
  readonly provider: string | null
  readonly providerName: string | null
  readonly providerAgent?: string | null
  readonly kind: 'model' | 'group' | 'pattern'
  /** Magpie can send this model in its vendor's fast mode (`memberInfo.canFast`). */
  readonly canFast?: boolean
}

export function MagpieGroupsPage({ snapshot, t, onUpdate }: {
  readonly snapshot: MagpieManagementSnapshot | null
  readonly t: Translate
  readonly onUpdate: (update: MagpieRoutingGroupManagementUpdate) => Promise<void>
}): ReactElement {
  const groups = snapshot?.groups ?? []
  const [selectedId, setSelectedId] = useState<string | null>(groups[0]?.id ?? null)
  const selected = groups.find(group => group.id === selectedId) ?? groups[0] ?? null
  useEffect(() => {
    if (selected !== null && selected.id !== selectedId) setSelectedId(selected.id)
  }, [selected, selectedId])
  if (snapshot?.groupStatus !== 'available') return createElement(PanelEmpty, { message: t('magpie.management.groupsUnavailable') })
  if (groups.length === 0) return createElement(PanelEmpty, { message: t('magpie.management.noGroups') })
  return createElement('div', { className: 'codingns-magpie-view' },
    createElement('div', { className: 'codingns-magpie-management-grid' },
      createElement('nav', { className: 'codingns-magpie-panel codingns-magpie-management-list', 'aria-label': t('magpie.management.groups') },
        ...groups.map(group => createElement('button', {
          key: group.id,
          type: 'button',
          className: `codingns-magpie-management-row${group.id === selected?.id ? ' is-active' : ''}`,
          'aria-pressed': group.id === selected?.id,
          onClick: () => setSelectedId(group.id),
        }, createElement('span', { className: 'codingns-magpie-management-row-main' },
          createElement('strong', undefined, group.name),
          createElement('small', undefined, `group/${group.id}`),
        ), createElement('span', { className: 'codingns-magpie-management-policy' }, group.routing === null ? '—' : magpiePolicyLabel('routing', group.routing, t)))),
      ),
      selected === null
        ? createElement(PanelEmpty, { message: t('magpie.management.noGroups') })
        : createElement(GroupEditor, { group: selected, candidates: groupModelCandidates(snapshot, selected), snapshot, t, onUpdate }),
    ),
  )
}

function GroupEditor({ group, candidates, snapshot, t, onUpdate }: {
  readonly group: MagpieRoutingGroupManagementRecord
  readonly candidates: readonly GroupModelCandidate[]
  readonly snapshot: MagpieManagementSnapshot | null
  readonly t: Translate
  readonly onUpdate: (update: MagpieRoutingGroupManagementUpdate) => Promise<void>
}): ReactElement {
  const [draft, setDraft] = useState<GroupDraft>(() => groupDraft(group))
  // The context input keeps what was typed ("200k"), because 200000 would read back as "200K"
  // under the caret on every keystroke.
  const [contextText, setContextText] = useState(() => group.context > 0 ? formatContextTokens(group.context) : '')
  const [review, setReview] = useState<MagpieRoutingGroupManagementUpdate | null>(null)
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState('')
  const key = JSON.stringify(group)
  useEffect(() => {
    setDraft(groupDraft(group))
    setContextText(group.context > 0 ? formatContextTokens(group.context) : '')
    setReview(null)
  }, [group.id, key])
  const setText = (field: 'name' | 'routing' | 'stays' | 'pick' | 'effort' | 'classifier', value: string): void => setDraft(current => ({ ...current, [field]: value }))
  // `fast` is kept in step with the members: a model taken out of the group takes its fast
  // mode with it, so a later save cannot fast-mode a model the group no longer names.
  const setModels = (models: readonly string[]): void => setDraft(current => ({ ...current, models, fast: current.fast.filter(model => models.includes(model)) }))
  const baseline = groupDraft(group)
  const manual = draft.routing === MANUAL_ROUTING
  const fast = draft.models.filter(model => draft.fast.includes(model))
  // A manual group with nothing to send to is not saveable here: this Host refuses that write,
  // and Magpie would otherwise keep whichever member came first.
  const missingPick = manual && draft.pick === ''
  // Picking each turn's level is a classifier's job: without one Magpie refuses the save, so
  // the review button waits until the model that rates a turn is chosen.
  const missingClassifier = draft.effort === GROUP_EFFORT_AUTO && draft.classifier === ''
  const update = (): MagpieRoutingGroupManagementUpdate | null => {
    if (missingPick || missingClassifier) return null
    const result: MagpieRoutingGroupManagementUpdate = {
      id: group.id,
      ...(draft.name.trim() === baseline.name ? {} : { name: draft.name.trim() }),
      ...(sameStringOrder(draft.models, baseline.models) ? {} : { models: [...draft.models] }),
      ...(draft.routing === baseline.routing ? {} : { routing: draft.routing }),
      ...(draft.stays === baseline.stays ? {} : { stays: draft.stays }),
      ...(!manual || draft.pick === baseline.pick ? {} : { pick: draft.pick }),
      ...(draft.unlists === baseline.unlists ? {} : { unlists: draft.unlists }),
      ...(sameStringSet(fast, baseline.fast) ? {} : { fast }),
      ...(draft.context === baseline.context ? {} : { context: draft.context }),
      ...(sameStringSet(draft.levels, baseline.levels) ? {} : { levels: [...draft.levels] }),
      ...(draft.effort === baseline.effort ? {} : { effort: draft.effort }),
      ...(draft.classifier === baseline.classifier ? {} : { classifier: draft.classifier }),
    }
    return Object.keys(result).length === 1 ? null : result
  }
  const apply = async (): Promise<void> => {
    if (review === null) return
    setSaving(true)
    setNotice('')
    try {
      await onUpdate(review)
      setReview(null)
      setNotice(t('magpie.management.saved'))
    } catch {
      setNotice(t('magpie.management.saveFailed'))
    } finally {
      setSaving(false)
    }
  }
  const updateField = update()
  const routingOptions = policyOptions('routing', ROUTING_POLICY_VALUES, draft.routing, t)
  const staysOptions = policyOptions('stays', STAYS_POLICY_VALUES, draft.stays, t)
  // Magpie's editor offers a member's fast mode only where the model has one
  // (provider.CanFast); `canFast` is the only per-model field it brings for this.
  const fastCapable = draft.models.flatMap(id => {
    const candidate = candidates.find(model => model.id === id)
    return candidate?.canFast === true ? [candidate] : []
  })
  const contextMode = draft.context === CONTEXT_SMALLEST ? 'smallest' : draft.context > 0 ? 'custom' : 'largest'
  // Typed text that is not a token count stays on screen with the error, rather than being
  // rewritten to the last value that parsed.
  const contextError = contextMode === 'custom' && parseContextTokens(contextText) === null
  // A group that picks each turn's level needs a model to rate the turn: the members first,
  // then every model the snapshot knows, so a small classifier outside the group can be picked.
  const classifierOptions = uniqueBy([
    ...draft.models.map(id => ({ value: id, label: id })),
    ...(snapshot?.providers ?? []).flatMap(provider => provider.models.map(model => ({ value: model.id, label: model.id }))),
  ], option => option.value)

  return createElement('section', { className: 'codingns-magpie-panel codingns-magpie-management-editor' },
    createElement('div', { className: 'codingns-magpie-panel-head' }, createElement('div', undefined,
      createElement('h2', undefined, group.name),
      createElement('p', undefined, `group/${group.id}`),
    )),
    createElement('div', { className: 'codingns-magpie-management-statusline' },
      createElement('span', undefined, t('magpie.management.membersCount', { count: group.members.length })),
      group.usedBy.length > 0 && createElement('span', undefined, t('magpie.management.usedBy', { agents: group.usedBy.join(', ') })),
    ),
    group.members.length > 0 && createElement('div', { className: 'codingns-magpie-management-members' },
      ...group.members.map(member => createElement('span', { key: member.id, className: `codingns-magpie-member-chip${member.ready === false ? ' is-muted' : ''}`, title: member.name ?? member.id }, member.id)),
    ),
    createElement('label', { className: 'codingns-magpie-field' }, createElement('span', undefined, t('magpie.management.groupName')),
      createElement('input', { value: draft.name, maxLength: 120, onChange: (event: { currentTarget: { value: string } }) => setText('name', event.currentTarget.value) })),
    createElement('div', { className: 'codingns-magpie-field' }, createElement('span', undefined, t('magpie.management.groupModels')),
      createElement('small', undefined, t('magpie.management.groupModelsHint')),
      createElement(GroupModelEditor, {
        key: group.id,
        value: draft.models,
        candidates,
        t,
        onChange: setModels,
      })),
    createElement('div', { className: 'codingns-magpie-field-row' },
      createElement(SelectField, { label: t('magpie.management.routing'), hint: t('magpie.management.routingHint'), value: draft.routing, options: routingOptions, onChange: value => setText('routing', value) }),
      createElement(SelectField, { label: t('magpie.management.stays'), hint: t('magpie.management.staysHint'), value: draft.stays, options: staysOptions, onChange: value => setText('stays', value) }),
    ),
    manual && (draft.models.length === 0
      ? createElement('p', { className: 'codingns-magpie-management-hint' }, t('magpie.management.noSelectedGroupModels'))
      : createElement(SelectField, {
        label: t('magpie.management.manualPick'),
        hint: t('magpie.management.manualPickHint'),
        value: draft.pick,
        options: [{ value: '', label: t('magpie.management.manualPickEmpty') }, ...draft.models.map(model => ({ value: model, label: model }))],
        onChange: value => setText('pick', value),
      })),
    fastCapable.length > 0 && createElement('div', { className: 'codingns-magpie-field' },
      createElement('span', undefined, t('magpie.management.fastMode')),
      createElement('small', undefined, t('magpie.management.fastModeHint', { model: fastCapable[0]?.id ?? '' })),
      createElement(CheckboxList, {
        label: t('magpie.management.fastMode'),
        options: fastCapable.map(model => ({ id: model.id, label: model.id })),
        value: fast,
        disabled: saving,
        onChange: (id, checked) => setDraft(current => ({
          ...current,
          fast: checked ? uniqueStrings([...current.fast, id]) : current.fast.filter(model => model !== id),
        })),
      }),
    ),
    createElement('label', { className: 'codingns-magpie-checkbox' },
      createElement('input', {
        type: 'checkbox',
        checked: draft.unlists,
        disabled: saving,
        onChange: (event: { currentTarget: { checked: boolean } }) => setDraft(current => ({ ...current, unlists: event.currentTarget.checked })),
      }),
      createElement('span', undefined, t('magpie.management.unlists')),
    ),
    createElement('div', { className: 'codingns-magpie-field' },
      createElement('span', undefined, t('magpie.management.context')),
      createElement('small', undefined, t('magpie.management.contextHint')),
      createElement(Segmented, {
        label: t('magpie.management.context'),
        value: contextMode,
        options: [
          { value: 'largest', label: t('magpie.management.contextLargest') },
          { value: 'smallest', label: t('magpie.management.contextSmallest') },
          { value: 'custom', label: t('magpie.management.contextCustom') },
        ],
        onChange: mode => {
          const tokens = mode === 'custom' && draft.context <= 0 ? 200_000 : null
          if (tokens !== null) {
            setContextText(formatContextTokens(tokens))
            setDraft(current => ({ ...current, context: tokens }))
            return
          }
          if (mode === 'custom') setContextText(formatContextTokens(draft.context))
          setDraft(current => ({
            ...current,
            context: mode === 'smallest' ? CONTEXT_SMALLEST : mode === 'largest' ? CONTEXT_LARGEST : current.context,
          }))
        },
      }),
      contextMode === 'custom' && createElement('input', {
        className: 'codingns-magpie-context-input',
        value: contextText,
        maxLength: 12,
        inputMode: 'text',
        placeholder: '200k',
        'aria-label': t('magpie.management.contextCustom'),
        'aria-invalid': contextError,
        onChange: (event: { currentTarget: { value: string } }) => {
          const tokens = parseContextTokens(event.currentTarget.value)
          setContextText(event.currentTarget.value)
          if (tokens !== null) setDraft(current => ({ ...current, context: tokens }))
        },
      }),
      contextError && createElement('small', { className: 'codingns-magpie-field-error', role: 'alert' }, t('magpie.management.contextInvalid')),
    ),
    createElement('div', { className: 'codingns-magpie-field' },
      createElement('span', undefined, t('magpie.management.levels')),
      createElement('small', undefined, t(draft.levels.length === 0
        ? 'magpie.management.levelsSharedHint'
        : 'magpie.management.levelsNamedHint', group.sharedLevels.length === 0 ? {} : { levels: group.sharedLevels.join(', ') })),
      createElement(Segmented, {
        label: t('magpie.management.levels'),
        value: draft.levels.length === 0 ? 'shared' : 'named',
        options: [
          { value: 'shared', label: t('magpie.management.levelsShared') },
          { value: 'named', label: t('magpie.management.levelsNamed') },
        ],
        onChange: mode => setDraft(current => ({
          ...current,
          levels: mode === 'shared' ? [] : current.levels.length > 0 ? current.levels : defaultLevels(group.sharedLevels),
        })),
      }),
      draft.levels.length > 0 && createElement('div', { className: 'codingns-magpie-levels', role: 'group', 'aria-label': t('magpie.management.levels') },
        ...MEMBER_LEVELS.map(level => createElement('button', {
          key: level,
          type: 'button',
          className: `codingns-magpie-level${draft.levels.includes(level) ? ' is-on' : ''}`,
          'aria-pressed': draft.levels.includes(level),
          onClick: () => setDraft(current => ({
            ...current,
            // Magpie keeps the levels in its own order, so a chip toggles in place.
            levels: current.levels.includes(level)
              ? current.levels.filter(item => item !== level)
              : MEMBER_LEVELS.filter(item => item === level || current.levels.includes(item)),
          })),
        }, level)),
      ),
    ),
    createElement('div', { className: 'codingns-magpie-field' },
      createElement('span', undefined, t('magpie.management.effort')),
      createElement('small', undefined, t(draft.effort === GROUP_EFFORT_AUTO ? 'magpie.management.effortAutoHint' : 'magpie.management.effortAgentHint')),
      createElement(Segmented, {
        label: t('magpie.management.effort'),
        value: draft.effort === GROUP_EFFORT_AUTO ? GROUP_EFFORT_AUTO : 'agent',
        options: [
          { value: 'agent', label: t('magpie.management.effortAgent') },
          { value: GROUP_EFFORT_AUTO, label: t('magpie.management.effortAuto') },
        ],
        onChange: mode => setDraft(current => ({
          ...current,
          effort: mode === GROUP_EFFORT_AUTO ? GROUP_EFFORT_AUTO : '',
          // Magpie needs a classifier the moment a turn's level is picked, and clears it again
          // when the effort goes back to the Agent's own.
          classifier: mode === GROUP_EFFORT_AUTO ? current.classifier : '',
        })),
      }),
      draft.effort === GROUP_EFFORT_AUTO && (classifierOptions.length === 0
        ? createElement('small', { className: 'codingns-magpie-field-error', role: 'alert' }, t('magpie.management.effortNeedsClassifier'))
        : createElement(SelectField, {
          label: t('magpie.management.classifier'),
          hint: t('magpie.management.classifierHint'),
          value: draft.classifier,
          options: [{ value: '', label: t('magpie.management.classifierEmpty') }, ...classifierOptions],
          onChange: value => setText('classifier', value),
        })),
    ),
    createElement('p', { className: 'codingns-magpie-management-hint' }, t('magpie.management.unlistsHint')),
    fastCapable.length === 0 && draft.models.length > 0 && createElement('p', { className: 'codingns-magpie-management-hint' }, t('magpie.management.noFastModels')),
    review !== null && createElement('div', { className: 'codingns-magpie-confirm' },
      createElement('strong', undefined, t('magpie.management.reviewGroup')),
      createElement('span', undefined, summarizeGroupUpdate(review, t)),
      createElement('div', { className: 'codingns-magpie-management-actions' },
        createElement('button', { type: 'button', disabled: saving, onClick: () => setReview(null) }, t('magpie.management.cancel')),
        createElement('button', { type: 'button', className: 'is-primary', disabled: saving, onClick: () => void apply() }, saving ? t('magpie.management.saving') : t('magpie.management.apply')),
      ),
    ),
    notice !== '' && createElement('div', { className: 'codingns-magpie-management-message', role: 'status' }, notice),
    review === null && createElement('div', { className: 'codingns-magpie-management-actions' },
      createElement('button', { type: 'button', onClick: () => { setDraft(groupDraft(group)); setNotice('') } }, t('magpie.management.reset')),
      createElement('button', { type: 'button', className: 'is-primary', disabled: updateField === null, onClick: () => { setNotice(''); setReview(updateField) } }, t('magpie.management.reviewChanges')),
    ),
  )
}

function groupDraft(group: MagpieRoutingGroupManagementRecord): GroupDraft {
  return {
    name: group.name,
    models: uniqueStrings([
      ...group.members.filter(member => !member.byPattern).map(member => member.id),
      ...group.patterns,
    ]),
    // An empty policy is Magpie's Smart and its Auto, as its own editor shows them.
    routing: group.routing === null || group.routing === '' ? 'smart' : group.routing,
    stays: group.stays === null || group.stays === '' ? 'auto' : group.stays,
    pick: group.pick ?? '',
    unlists: group.unlists === true,
    fast: group.fast,
    context: group.context,
    levels: group.levels,
    effort: group.effort === null || group.effort === undefined ? '' : group.effort,
    classifier: group.classifier ?? '',
  }
}

export function reorderModels(models: readonly string[], sourceId: string, targetId: string): readonly string[] {
  if (sourceId === targetId) return [...models]
  const sourceIndex = models.indexOf(sourceId)
  const targetIndex = models.indexOf(targetId)
  if (sourceIndex < 0 || targetIndex < 0) return [...models]
  const next = [...models]
  const [moved] = next.splice(sourceIndex, 1)
  if (moved === undefined) return [...models]
  next.splice(sourceIndex < targetIndex ? targetIndex - 1 : targetIndex, 0, moved)
  return next
}

function uniqueStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values)]
}

function sameStringOrder(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every(value => right.includes(value))
}

/**
 * Read a context window the way Magpie's own editor does: a token count, optionally written
 * with a `k` or `m` suffix ("200k", "1m"). Returns null for anything else, which keeps the
 * previous value and shows the error instead of silently saving a wrong window.
 */
export function parseContextTokens(value: string): number | null {
  const match = value.trim().toLocaleLowerCase().replace(/_/gu, '').match(/^(\d+(?:\.\d+)?)\s*([km]?)$/u)
  if (match === null) return null
  const suffix = match[2] ?? ''
  const scale = suffix === 'k' ? 1_000 : suffix === 'm' ? 1_000_000 : 1
  const tokens = Math.round(Number(match[1]) * scale)
  return Number.isSafeInteger(tokens) && tokens > 0 ? tokens : null
}

/** The inverse, so a stored window reads back as Magpie writes it. */
export function formatContextTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${Number((tokens / 1_000_000).toFixed(1))}m`
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`
  return String(tokens)
}

/** The levels Magpie starts a "named" list with: those the members share, or its usual three. */
function defaultLevels(shared: readonly string[]): readonly string[] {
  const seed = shared.length > 0 ? shared : ['low', 'medium', 'high']
  return MEMBER_LEVELS.filter(level => seed.includes(level))
}

function uniqueBy<T>(items: readonly T[], keyOf: (item: T) => string): readonly T[] {
  const seen = new Set<string>()
  return items.filter(item => {
    const key = keyOf(item)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** A small set of exclusive choices, drawn as buttons rather than a select. */
function Segmented({ label, value, options, onChange }: {
  readonly label: string
  readonly value: string
  readonly options: readonly SelectOption[]
  readonly onChange: (value: string) => void
}): ReactElement {
  return createElement('div', { className: 'codingns-magpie-segmented', role: 'group', 'aria-label': label },
    ...options.map(option => createElement('button', {
      key: option.value,
      type: 'button',
      className: option.value === value ? 'is-active' : '',
      'aria-pressed': option.value === value,
      onClick: () => onChange(option.value),
    }, option.label)),
  )
}

/** One checkbox per option, for the few per-model switches a save carries. */
function CheckboxList({ label, options, value, disabled, onChange }: {
  readonly label: string
  readonly options: readonly { readonly id: string; readonly label: string }[]
  readonly value: readonly string[]
  readonly disabled: boolean
  readonly onChange: (id: string, checked: boolean) => void
}): ReactElement {
  return createElement('div', { className: 'codingns-magpie-checkbox-list', role: 'group', 'aria-label': label },
    ...options.map(option => createElement('label', { key: option.id, className: 'codingns-magpie-model-option' },
      createElement('input', {
        type: 'checkbox',
        checked: value.includes(option.id),
        disabled,
        'aria-label': option.id,
        onChange: (event: { currentTarget: { checked: boolean } }) => onChange(option.id, event.currentTarget.checked),
      }),
      createElement('span', { className: 'codingns-magpie-model-option-copy' },
        createElement('code', { className: 'codingns-magpie-model-id', title: option.id }, option.label),
      ),
    )),
  )
}

function groupModelCandidates(snapshot: MagpieManagementSnapshot | null, group: MagpieRoutingGroupManagementRecord): readonly GroupModelCandidate[] {
  const candidates = new Map<string, GroupModelCandidate>()
  const providerNames = new Map((snapshot?.providers ?? []).map(provider => [provider.id, provider.name]))
  const providerAgents = new Map((snapshot?.providers ?? []).map(provider => [provider.id, provider.accountAgent]))
  for (const provider of snapshot?.providers ?? []) {
    for (const model of provider.models) {
      if (!candidates.has(model.id)) candidates.set(model.id, { id: model.id, name: model.name, provider: provider.id, providerName: provider.name, providerAgent: provider.accountAgent, kind: 'model' })
    }
  }
  for (const member of group.members) {
    if (!candidates.has(member.id)) candidates.set(member.id, {
      id: member.id,
      name: member.name,
      provider: member.provider,
      providerName: member.provider === null ? null : providerNames.get(member.provider) ?? null,
      providerAgent: member.provider === null ? null : providerAgents.get(member.provider) ?? null,
      kind: member.id.startsWith('group/') ? 'group' : 'model',
      canFast: member.canFast === true,
    })
  }
  for (const pattern of group.patterns) {
    if (!candidates.has(pattern)) candidates.set(pattern, { id: pattern, name: null, provider: null, providerName: null, kind: 'pattern' })
  }
  return [...candidates.values()]
}

function GroupModelEditor({ value, candidates, t, onChange }: {
  readonly value: readonly string[]
  readonly candidates: readonly GroupModelCandidate[]
  readonly t: Translate
  readonly onChange: (models: readonly string[]) => void
}): ReactElement {
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const candidateById = new Map(candidates.map(candidate => [candidate.id, candidate]))
  const fallback = (id: string): GroupModelCandidate => ({
    id,
    name: null,
    provider: null,
    providerName: null,
    providerAgent: null,
    kind: id.startsWith('group/') ? 'group' : id.includes('*') || id.startsWith('re:') ? 'pattern' : 'model',
  })
  const selected = value.map(id => candidateById.get(id) ?? fallback(id))
  const unselected = candidates.filter(candidate => !value.includes(candidate.id))
  const [pickerOpen, setPickerOpen] = useState(false)
  const [pickerQuery, setPickerQuery] = useState('')
  const move = (id: string, delta: -1 | 1): void => {
    const index = value.indexOf(id)
    const targetIndex = index + delta
    if (index < 0 || targetIndex < 0 || targetIndex >= value.length) return
    const targetId = value[targetIndex]
    if (targetId !== undefined) onChange(reorderModels(value, id, targetId))
  }
  const drop = (event: { preventDefault: () => void; dataTransfer?: { getData: (type: string) => string } }, targetId: string): void => {
    event.preventDefault()
    const sourceId = draggingId ?? event.dataTransfer?.getData('text/plain') ?? ''
    if (sourceId !== '') onChange(reorderModels(value, sourceId, targetId))
    setDraggingId(null)
  }
  const renderOption = (candidate: GroupModelCandidate, enabled: boolean, index: number): ReactElement => createElement('div', {
    key: candidate.id,
    className: `codingns-magpie-group-model-option${enabled ? ' is-selected' : ''}${draggingId === candidate.id ? ' is-dragging' : ''}`,
    draggable: enabled && candidate.kind !== 'pattern',
    'data-model-id': candidate.id,
    onDragStart: enabled && candidate.kind !== 'pattern' ? (event: { dataTransfer?: { setData: (type: string, value: string) => void; effectAllowed?: string } }) => {
      setDraggingId(candidate.id)
      event.dataTransfer?.setData('text/plain', candidate.id)
      if (event.dataTransfer !== undefined) event.dataTransfer.effectAllowed = 'move'
    } : undefined,
    onDragEnd: () => setDraggingId(null),
    onDragOver: enabled && candidate.kind !== 'pattern' ? (event: { preventDefault: () => void; dataTransfer?: { dropEffect?: string } }) => {
      event.preventDefault()
      if (event.dataTransfer !== undefined) event.dataTransfer.dropEffect = 'move'
    } : undefined,
    onDrop: enabled && candidate.kind !== 'pattern' ? (event: { preventDefault: () => void; dataTransfer?: { getData: (type: string) => string } }) => drop(event, candidate.id) : undefined,
  },
    createElement('label', { className: 'codingns-magpie-group-model-check' },
      createElement('input', {
        type: 'checkbox',
        checked: value.includes(candidate.id),
        'aria-label': candidate.id,
        onChange: (event: { currentTarget: { checked: boolean } }) => onChange(event.currentTarget.checked ? addGroupModel(value, candidate, candidateById) : value.filter(id => id !== candidate.id)),
      }),
      createElement('span', { className: 'codingns-magpie-group-model-order', 'aria-hidden': true }, String(index + 1)),
      createElement(MagpieProviderLogo, { identities: [candidate.providerAgent, candidate.provider, candidate.providerName], size: 20, className: 'codingns-magpie-provider-logo codingns-magpie-provider-logo-compact', fallback: 'none' }),
      createElement('span', { className: 'codingns-magpie-model-option-copy' },
        createElement('strong', { className: 'codingns-magpie-model-name', title: candidate.name ?? candidate.id }, candidate.name ?? candidate.id),
        createElement('span', { className: 'codingns-magpie-model-meta' },
          candidate.provider !== null && createElement('span', { className: 'codingns-magpie-model-provider', title: candidate.provider }, candidate.provider),
          createElement('code', { className: 'codingns-magpie-model-id', title: candidate.id }, candidate.id),
        ),
      ),
    ),
    enabled && candidate.kind !== 'pattern' && createElement('div', { className: 'codingns-magpie-group-model-actions' },
      createElement('button', { type: 'button', disabled: index === 0, 'aria-label': t('magpie.management.moveModelUp', { model: candidate.id }), onClick: () => move(candidate.id, -1) }, '↑'),
      createElement('button', { type: 'button', disabled: index === value.length - 1, 'aria-label': t('magpie.management.moveModelDown', { model: candidate.id }), onClick: () => move(candidate.id, 1) }, '↓'),
    ),
  )

  return createElement('div', { className: 'codingns-magpie-group-model-editor', role: 'list' },
    selected.length === 0 && createElement('div', { className: 'codingns-magpie-inline-empty' }, t('magpie.management.noSelectedGroupModels')),
    ...selected.map((candidate, index) => renderOption(candidate, true, index)),
    unselected.length > 0 && createElement('div', { className: 'codingns-magpie-group-model-add' },
      createElement('button', {
        type: 'button',
        className: 'codingns-magpie-group-model-add-button',
        'aria-label': t('magpie.management.addGroupModel'),
        'aria-expanded': pickerOpen,
        'aria-controls': 'codingns-magpie-group-model-picker',
        onClick: () => setPickerOpen(open => !open),
      }, createElement('span', { className: 'codingns-magpie-group-model-add-icon', 'aria-hidden': true }, '+'), t('magpie.management.addGroupModel')),
      pickerOpen && createElement(GroupModelPicker, {
        candidates: unselected,
        value,
        query: pickerQuery,
        t,
        onQueryChange: setPickerQuery,
        onSelect: candidate => {
          onChange(addGroupModel(value, candidate, candidateById))
          setPickerOpen(false)
          setPickerQuery('')
        },
      }),
    ),
  )
}

export function GroupModelPicker({ candidates, value, query, t, onQueryChange, onSelect }: {
  readonly candidates: readonly GroupModelCandidate[]
  readonly value: readonly string[]
  readonly query: string
  readonly t: Translate
  readonly onQueryChange: (value: string) => void
  readonly onSelect: (candidate: GroupModelCandidate) => void
}): ReactElement {
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const filtered = candidates.filter(candidate => [candidate.name, candidate.id, candidate.provider, candidate.providerName]
    .some(value => value?.toLocaleLowerCase().includes(normalizedQuery) === true))
  const groups = new Map<string, { readonly label: string; readonly candidates: GroupModelCandidate[] }>()
  for (const candidate of filtered) {
    const key = candidate.provider ?? 'other'
    const group = groups.get(key)
    if (group !== undefined) group.candidates.push(candidate)
    else groups.set(key, { label: candidate.providerName ?? candidate.provider ?? t('magpie.management.otherGroupModels'), candidates: [candidate] })
  }
  return createElement('div', { id: 'codingns-magpie-group-model-picker', className: 'codingns-magpie-group-model-picker', role: 'dialog', 'aria-label': t('magpie.management.addGroupModel') },
    createElement('div', { className: 'codingns-magpie-group-model-picker-search' },
      createElement('span', { 'aria-hidden': true }, '⌕'),
      createElement('input', {
        type: 'search',
        value: query,
        autoFocus: true,
        placeholder: t('magpie.management.searchGroupModels'),
        'aria-label': t('magpie.management.searchGroupModels'),
        onChange: (event: { currentTarget: { value: string } }) => onQueryChange(event.currentTarget.value),
      }),
    ),
    createElement('div', { className: 'codingns-magpie-group-model-picker-list', role: 'listbox' },
      groups.size === 0
        ? createElement('div', { className: 'codingns-magpie-inline-empty' }, t('magpie.management.noMatchingGroupModels'))
        : [...groups.entries()].map(([key, group]) => createElement('section', { key, className: 'codingns-magpie-group-model-picker-group' },
          createElement('h4', { className: 'codingns-magpie-group-model-picker-heading' }, group.label),
          ...group.candidates.map(candidate => createElement('button', {
            key: candidate.id,
            type: 'button',
            className: 'codingns-magpie-group-model-picker-option',
            role: 'option',
            'aria-selected': value.includes(candidate.id),
            onClick: () => onSelect(candidate),
          },
            createElement(MagpieProviderLogo, { identities: [candidate.providerAgent, candidate.provider, candidate.providerName], size: 24, className: 'codingns-magpie-provider-logo codingns-magpie-provider-logo-compact', fallback: 'none' }),
            createElement('span', { className: 'codingns-magpie-model-option-copy' },
              createElement('strong', { className: 'codingns-magpie-model-name', title: candidate.name ?? candidate.id }, candidate.name ?? candidate.id),
              createElement('span', { className: 'codingns-magpie-model-meta' },
                candidate.provider !== null && createElement('span', { className: 'codingns-magpie-model-provider', title: candidate.provider }, candidate.provider),
                createElement('code', { className: 'codingns-magpie-model-id', title: candidate.id }, candidate.id),
              ),
            ),
          )),
        )),
    ),
  )
}

function addGroupModel(value: readonly string[], candidate: GroupModelCandidate, candidateById: ReadonlyMap<string, GroupModelCandidate>): readonly string[] {
  if (value.includes(candidate.id)) return [...value]
  if (candidate.kind === 'pattern') return [...value, candidate.id]
  const firstPattern = value.findIndex(id => candidateById.get(id)?.kind === 'pattern' || id.includes('*') || id.startsWith('re:'))
  if (firstPattern < 0) return [...value, candidate.id]
  return [...value.slice(0, firstPattern), candidate.id, ...value.slice(firstPattern)]
}

function accountBelongsToProvider(account: MagpieAccountManagementRecord, provider: MagpieProviderManagementRecord): boolean {
  const providerAgent = (provider.accountAgent ?? provider.id).toLocaleLowerCase()
  return account.agent.toLocaleLowerCase() === providerAgent
}

function SelectField({ label, hint, value, options, onChange }: {
  readonly label: string
  readonly hint?: string
  readonly value: string
  readonly options: readonly SelectOption[]
  readonly onChange: (value: string) => void
}): ReactElement {
  return createElement('label', { className: 'codingns-magpie-field' }, createElement('span', undefined, label),
    hint !== undefined && createElement('small', undefined, hint),
    createElement('select', { value, onChange: (event: { currentTarget: { value: string } }) => onChange(event.currentTarget.value) }, ...options.map(option => createElement('option', { key: option.value, value: option.value }, option.label))),
  )
}

function StateBadge({ state, label, t }: { readonly state: 'on' | 'off' | 'unknown'; readonly label?: string; readonly t: Translate }): ReactElement {
  return createElement('span', { className: `codingns-magpie-state is-${state}` }, label ?? t(state === 'on' ? 'magpie.management.on' : state === 'off' ? 'magpie.management.off' : 'magpie.management.unknown'))
}

function PanelEmpty({ message }: { readonly message: string }): ReactElement {
  return createElement('div', { className: 'codingns-magpie-panel codingns-magpie-management-empty', role: 'note' }, message)
}

function summarizeProviderUpdate(update: MagpieProviderManagementUpdate, t: Translate): string {
  const changes: string[] = []
  if (update.name !== undefined) changes.push(t('magpie.management.reviewName', { value: update.name }))
  if (update.endpointUrl !== undefined) changes.push(t('magpie.management.reviewEndpoint', { field: update.endpointField ?? '', value: update.endpointUrl }))
  if (update.models !== undefined) changes.push(t('magpie.management.reviewModels', { count: update.models.length }))
  if (update.on !== undefined) changes.push(t('magpie.management.reviewProviderStatus', { value: t(update.on ? 'magpie.management.on' : 'magpie.management.off') }))
  return changes.join(' · ')
}

function summarizeGroupUpdate(update: MagpieRoutingGroupManagementUpdate, t: Translate): string {
  const changes: string[] = []
  if (update.name !== undefined) changes.push(t('magpie.management.reviewName', { value: update.name }))
  if (update.models !== undefined) changes.push(t('magpie.management.reviewModels', { count: update.models.length }))
  if (update.routing !== undefined) changes.push(t('magpie.management.reviewRouting', { value: magpiePolicyLabel('routing', update.routing, t) }))
  if (update.stays !== undefined) changes.push(t('magpie.management.reviewStays', { value: magpiePolicyLabel('stays', update.stays, t) }))
  if (update.pick !== undefined) changes.push(t('magpie.management.reviewPick', { value: update.pick }))
  if (update.unlists !== undefined) changes.push(t('magpie.management.reviewUnlists', { value: t(update.unlists ? 'magpie.management.on' : 'magpie.management.off') }))
  if (update.fast !== undefined) changes.push(t('magpie.management.reviewFast', { count: update.fast.length }))
  if (update.context !== undefined) {
    changes.push(t('magpie.management.reviewContext', {
      value: update.context === CONTEXT_SMALLEST
        ? t('magpie.management.contextSmallest')
        : update.context > 0 ? formatContextTokens(update.context) : t('magpie.management.contextLargest'),
    }))
  }
  if (update.levels !== undefined) {
    changes.push(t('magpie.management.reviewLevels', {
      value: update.levels.length === 0 ? t('magpie.management.levelsShared') : update.levels.join(', '),
    }))
  }
  if (update.effort !== undefined) {
    changes.push(t('magpie.management.reviewEffort', {
      value: update.effort === GROUP_EFFORT_AUTO
        ? t('magpie.management.reviewEffortAuto', { model: update.classifier ?? '' })
        : t('magpie.management.effortAgent'),
    }))
  }
  return changes.join(' · ')
}
