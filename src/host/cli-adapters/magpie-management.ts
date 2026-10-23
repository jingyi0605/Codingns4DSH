import type {
  MagpieAccountManagementUpdate,
  MagpieAccountManagementRecord,
  MagpieAccountWindow,
  MagpieManagementMutationResult,
  MagpieManagementSnapshot,
  MagpieProviderEndpoint,
  MagpieProviderEndpointField,
  MagpieProviderManagementRecord,
  MagpieProviderManagementUpdate,
  MagpieProviderModel,
  MagpieRoutingGroupManagementRecord,
  MagpieRoutingGroupManagementUpdate,
  MagpieRoutingGroupMember,
} from '../../shared/contracts/magpie-management.js'
import { MagpieWebService, type MagpieWebRequestOptions } from './magpie-web.js'

const MAX_PROVIDERS = 100
const MAX_GROUPS = 200
const MAX_ACCOUNTS = 500
const PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u
const GROUP_ID = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/u
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/+@-]{0,299}$/u
const ENDPOINT_FIELDS = ['chat', 'responses', 'anthropic', 'gemini'] as const satisfies readonly MagpieProviderEndpointField[]
const ENDPOINT_FIELD_SET = new Set<MagpieProviderEndpointField>(ENDPOINT_FIELDS)
const ROUTING_POLICIES = new Set(['smart', 'order', 'rotate', 'usage', 'pace', 'weight', 'manual'])
const STICKINESS_POLICIES = new Set(['auto', 'session', 'turn', 'off', 'strict'])
const ACCOUNT_AGENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u

const PROVIDER_VIEW_FIELDS = new Set([
  'host', 'key', 'keyList', 'balanceToken', 'account', 'ready', 'chosen', 'speaks', 'models', 'exposed', 'unlisted',
  'noModels', 'groups', 'off', 'agents', 'sponsored',
])
const PROVIDER_MUTABLE_FIELDS = new Set(['name', 'chat', 'responses', 'anthropic', 'gemini', 'models', 'chosen', 'off'])
const GROUP_VIEW_FIELDS = new Set(['id', 'ready', 'memberInfo', 'holds', 'offers', 'shared', 'patterns', 'ref'])
const GROUP_MUTABLE_FIELDS = new Set(['name', 'members', 'match', 'patterns', 'routing', 'affinity'])
const LOGIN_CONTAINER_FIELDS = new Set(['accounts', 'logins', 'data', 'users', 'usage', 'providers', 'items'])

export interface MagpieManagementServiceOptions {
  readonly webApi?: Pick<MagpieWebService, 'requestJson'>
  readonly now?: () => number
}

interface MagpieWebManagementState {
  readonly snapshot: MagpieManagementSnapshot
  readonly rawProviders: readonly Record<string, unknown>[] | null
  readonly providerWritesSafe: boolean
  readonly rawGroups: readonly Record<string, unknown>[] | null
}

type WebRead = { readonly ok: true; readonly value: unknown } | { readonly ok: false }

/** Provider, account, and routing-group panels use the authenticated Magpie Web API only. */
export class MagpieManagementService {
  private readonly webApi: MagpieManagementServiceOptions['webApi']
  private readonly now: () => number
  private mutationTail: Promise<void> = Promise.resolve()

  constructor(options: MagpieManagementServiceOptions = {}) {
    this.webApi = options.webApi
    this.now = options.now ?? Date.now
  }

  async readSnapshot(signal?: AbortSignal): Promise<MagpieManagementSnapshot> {
    return (await this.readWebState(signal)).snapshot
  }

  async updateProvider(input: unknown, signal?: AbortSignal): Promise<MagpieManagementMutationResult> {
    const update = readProviderUpdate(input)
    return this.enqueueMutation(async () => {
      const before = await this.readWebState(signal)
      const current = before.rawProviders?.find(item => item.id === update.id)
      const currentRecord = before.snapshot.providers.find(item => item.id === update.id)
      if (before.snapshot.providerStatus === 'unavailable' || !before.providerWritesSafe || current === undefined || currentRecord === undefined) {
        throw new Error('Magpie provider data is unavailable')
      }
      if (update.models !== undefined && !currentRecord.modelsEditable) {
        throw new TypeError('Magpie provider models contain entries this Host cannot safely edit')
      }
      if (update.on !== undefined && currentRecord.state === 'unknown') throw new Error('Magpie provider availability cannot be verified')
      if (update.endpointField !== undefined && !currentRecord.endpoints.some(endpoint => endpoint.field === update.endpointField && endpoint.editable)) {
        throw new TypeError('Only an endpoint already present on this provider can be edited')
      }

      const hasConfigChange = providerHasConfigChange(update, currentRecord)
      const hasStateChange = update.on !== undefined && currentRecord.state !== (update.on ? 'on' : 'off')
      if (!hasConfigChange && !hasStateChange) return { changed: 'provider', id: update.id, snapshot: before.snapshot }

      const protectedBefore = providerConfigFingerprint(current)
      if (hasConfigChange) {
        await this.requestApi('/api/provider/save', {
          method: 'POST', body: providerSavePayload(currentRecord, update), ...signalOption(signal),
        })
      }
      if (hasStateChange) {
        await this.requestApi(`/api/provider/${update.on ? 'on' : 'off'}`, {
          method: 'POST', body: { id: update.id }, ...signalOption(signal),
        })
      }

      const after = await this.readWebState(signal)
      const saved = after.snapshot.providers.find(item => item.id === update.id)
      const savedRaw = after.rawProviders?.find(item => item.id === update.id)
      if (saved === undefined || savedRaw === undefined || !providerUpdateMatches(update, saved)
        || !providerRecordMatchesUpdate(currentRecord, update, saved)
        || providerConfigFingerprint(savedRaw) !== protectedBefore
        || !otherProvidersUnchanged(before.rawProviders ?? [], after.rawProviders ?? [], update.id)) {
        throw new Error('Magpie provider update could not be verified without changing protected settings')
      }
      return { changed: 'provider', id: update.id, snapshot: after.snapshot }
    })
  }

  async updateGroup(input: unknown, signal?: AbortSignal): Promise<MagpieManagementMutationResult> {
    const update = readGroupUpdate(input)
    return this.enqueueMutation(async () => {
      const before = await this.readWebState(signal)
      if (before.snapshot.groupStatus !== 'available') throw new Error('Magpie routing-group data is unavailable')
      const current = before.rawGroups?.find(item => normalizeGroupId(item.id) === update.id)
      const currentRecord = before.snapshot.groups.find(item => item.id === update.id)
      if (current === undefined || currentRecord === undefined) throw new Error('Magpie routing group was not found')

      const protectedBefore = groupConfigFingerprint(current)
      await this.requestApi('/api/groups/save', {
        method: 'POST', body: groupSavePayload(current, currentRecord, update), ...signalOption(signal),
      })
      const after = await this.readWebState(signal)
      const saved = after.snapshot.groups.find(item => item.id === update.id)
      const savedRaw = after.rawGroups?.find(item => normalizeGroupId(item.id) === update.id)
      if (saved === undefined || savedRaw === undefined || !groupUpdateMatches(update, saved)
        || groupConfigFingerprint(savedRaw) !== protectedBefore
        || !otherGroupsUnchanged(before.rawGroups ?? [], after.rawGroups ?? [], update.id)) {
        throw new Error('Magpie routing-group update could not be verified without changing protected settings')
      }
      return { changed: 'group', id: update.id, snapshot: after.snapshot }
    })
  }

  async updateAccount(input: unknown, signal?: AbortSignal): Promise<MagpieManagementMutationResult> {
    const update = readAccountUpdate(input)
    return this.enqueueMutation(async () => {
      const before = await this.readWebState(signal)
      if (before.snapshot.accountStatus !== 'available') throw new Error('Magpie account data is unavailable')
      if (before.snapshot.accountApiStatus !== 'available') throw new Error('Magpie Web account API is unavailable')
      const current = findAccount(before.snapshot.accounts, update.agent, update.user)
      if (current === undefined) throw new Error('Magpie account was not found')
      if (current.on === null) throw new Error('Magpie account routing status cannot be verified')
      if (current.on === update.on) return { changed: 'account', id: `${update.agent}/${update.user}`, snapshot: before.snapshot }
      if (!update.on && before.snapshot.accounts.filter(account => account.agent.toLocaleLowerCase() === update.agent.toLocaleLowerCase() && account.on === true).length <= 1) {
        throw new Error('Magpie requires at least one account to remain in routing rotation')
      }

      await this.requestApi(`/api/login/${update.on ? 'on' : 'off'}`, {
        method: 'POST', body: { Agent: update.agent, User: update.user }, ...signalOption(signal),
      })
      const after = await this.readWebState(signal)
      const saved = findAccount(after.snapshot.accounts, update.agent, update.user)
      if (after.snapshot.accountStatus !== 'available' || saved?.on !== update.on
        || !otherAccountsUnchanged(before.snapshot.accounts, after.snapshot.accounts, update.agent, update.user)) {
        throw new Error('Magpie account change could not be verified after saving')
      }
      return { changed: 'account', id: `${update.agent}/${update.user}`, snapshot: after.snapshot }
    })
  }

  private enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.mutationTail.then(operation, operation)
    this.mutationTail = next.then(() => undefined, () => undefined)
    return next
  }

  private async readWebState(signal?: AbortSignal): Promise<MagpieWebManagementState> {
    signal?.throwIfAborted()
    const [providerResult, groupResult, quotaResult, loginUsageResult] = await Promise.all([
      this.readApi('/api/providers', signal),
      this.readApi('/api/groups', signal),
      this.readApi('/api/usage/quotas', signal),
      this.readApi('/api/login/usage', signal),
    ])
    const parsedProviders = providerResult.ok ? parseMagpieWebProviders(providerResult.value) : null
    const parsedGroups = groupResult.ok ? parseMagpieWebGroups(groupResult.value) : null
    const parsedAccounts = providerResult.ok || quotaResult.ok || loginUsageResult.ok
      ? parseMagpieWebAccounts(
        quotaResult.ok ? quotaResult.value : null,
        loginUsageResult.ok ? loginUsageResult.value : null,
        providerResult.ok ? providerResult.value : null,
      )
      : null
    const apiAvailable = providerResult.ok || groupResult.ok || quotaResult.ok || loginUsageResult.ok
    const snapshot: MagpieManagementSnapshot = {
      capturedAt: new Date(this.now()).toISOString(),
      availabilityIssue: apiAvailable ? null : 'web-api-unavailable',
      providerStatus: parsedProviders === null ? 'unavailable' : parsedProviders.partial ? 'partial' : 'available',
      providers: parsedProviders?.records ?? [],
      accountStatus: parsedAccounts === null ? 'unavailable' : 'available',
      accounts: parsedAccounts ?? [],
      accountApiStatus: loginUsageResult.ok ? 'available' : 'unavailable',
      groupStatus: parsedGroups === null ? 'unavailable' : 'available',
      groups: parsedGroups?.groups ?? [],
    }
    return {
      snapshot,
      rawProviders: parsedProviders?.raw ?? null,
      providerWritesSafe: parsedProviders?.writesSafe ?? false,
      rawGroups: parsedGroups?.raw ?? null,
    }
  }

  private async readApi(path: string, signal?: AbortSignal): Promise<WebRead> {
    if (this.webApi === undefined) return { ok: false }
    try {
      return { ok: true, value: await this.webApi.requestJson(path, { ...signalOption(signal) }) }
    } catch {
      signal?.throwIfAborted()
      return { ok: false }
    }
  }

  private async requestApi(path: string, options: MagpieWebRequestOptions): Promise<unknown> {
    if (this.webApi === undefined) throw new Error('Magpie Web API is unavailable')
    return this.webApi.requestJson(path, options)
  }
}

export function parseMagpieWebProviders(value: unknown): {
  readonly records: readonly MagpieProviderManagementRecord[]
  readonly raw: readonly Record<string, unknown>[]
  readonly partial: boolean
  readonly writesSafe: boolean
} | null {
  const root = asRecord(value)
  if (root === null || !Array.isArray(root.providers) || root.providers.length > MAX_PROVIDERS) return null
  const raw: Record<string, unknown>[] = []
  const records: MagpieProviderManagementRecord[] = []
  let partial = false
  let writesSafe = true
  for (const item of root.providers) {
    const record = asRecord(item)
    if (record === null) {
      partial = true
      writesSafe = false
      continue
    }
    raw.push(record)
    const parsed = readWebProvider(record)
    if (parsed === null) {
      partial = true
      writesSafe = false
      continue
    }
    records.push(parsed.record)
    partial ||= parsed.partial
  }
  if (new Set(records.map(record => record.id)).size !== records.length) return null
  return { records, raw, partial, writesSafe }
}

export function parseMagpieWebGroups(value: unknown): {
  readonly groups: readonly MagpieRoutingGroupManagementRecord[]
  readonly raw: readonly Record<string, unknown>[]
} | null {
  const root = asRecord(value)
  if (root === null || !Array.isArray(root.groups) || root.groups.length > MAX_GROUPS) return null
  const raw: Record<string, unknown>[] = []
  const groups: MagpieRoutingGroupManagementRecord[] = []
  for (const item of root.groups) {
    const record = asRecord(item)
    const parsed = record === null ? null : readWebGroup(record)
    if (record === null || parsed === null) return null
    raw.push(record)
    groups.push(parsed)
  }
  if (new Set(groups.map(group => group.id)).size !== groups.length) return null
  return { groups, raw }
}

export function parseMagpieWebAccounts(
  quotaValue: unknown,
  loginUsageValue: unknown,
  providerValue: unknown = null,
): readonly MagpieAccountManagementRecord[] | null {
  const quotaRows = quotaValue === null ? null : readWebRows(quotaValue, MAX_ACCOUNTS)
  const loginRows = loginUsageValue === null ? null : readLoginUsageRecords(loginUsageValue)
  const providerRows = providerValue === null ? null : readProviderAccountRecords(providerValue)
  if (quotaRows === null && loginRows === null && providerRows === null) return null

  const accounts = new Map<string, MagpieAccountManagementRecord>()
  for (const record of [...(providerRows ?? []), ...(loginRows ?? []), ...(quotaRows ?? [])]) {
    const account = readWebAccount(record)
    if (account === null) continue
    const key = `${account.agent.toLocaleLowerCase()}\u0000${account.user.toLocaleLowerCase()}`
    const before = accounts.get(key)
    accounts.set(key, before === undefined ? account : mergeAccount(before, account))
    if (accounts.size > MAX_ACCOUNTS) return null
  }
  return [...accounts.values()]
}

export function readProviderUpdate(value: unknown): MagpieProviderManagementUpdate {
  const record = asRecord(value)
  if (record === null || typeof record.id !== 'string' || !PROVIDER_ID.test(record.id)) throw new TypeError('Invalid Magpie provider update')
  assertAllowedKeys(record, ['id', 'name', 'endpointField', 'endpointUrl', 'models', 'on'])
  const name = optionalUpdateText(record.name, 80, 'provider name')
  const endpointField = record.endpointField
  const endpointUrl = optionalUpdateUrl(record.endpointUrl)
  const on = optionalUpdateBoolean(record.on, 'provider availability')
  if (endpointField !== undefined && (typeof endpointField !== 'string' || !ENDPOINT_FIELD_SET.has(endpointField as MagpieProviderEndpointField))) {
    throw new TypeError('Invalid Magpie endpoint field')
  }
  const canonicalEndpointUrl = endpointField === 'anthropic' && endpointUrl?.endsWith('/v1') === true
    ? endpointUrl.slice(0, -3)
    : endpointUrl
  if ((endpointField === undefined) !== (canonicalEndpointUrl === undefined)) throw new TypeError('Endpoint field and URL must be updated together')
  const models = record.models === undefined ? undefined : readModelList(record.models, record.id, false)
  if (name === undefined && endpointUrl === undefined && models === undefined && on === undefined) throw new TypeError('Provider update has no changes')
  return {
    id: record.id,
    ...(name === undefined ? {} : { name }),
    ...(endpointField === undefined || canonicalEndpointUrl === undefined ? {} : { endpointField: endpointField as MagpieProviderEndpointField, endpointUrl: canonicalEndpointUrl }),
    ...(models === undefined ? {} : { models }),
    ...(on === undefined ? {} : { on }),
  }
}

export function readGroupUpdate(value: unknown): MagpieRoutingGroupManagementUpdate {
  const record = asRecord(value)
  if (record === null || typeof record.id !== 'string' || !GROUP_ID.test(record.id)) throw new TypeError('Invalid Magpie routing-group update')
  assertAllowedKeys(record, ['id', 'name', 'models', 'routing', 'stays'])
  const name = optionalUpdateText(record.name, 120, 'group name')
  const models = record.models === undefined ? undefined : readModelList(record.models, null, true)
  const routing = optionalEnum(record.routing, ROUTING_POLICIES, 'routing policy')
  const stays = optionalEnum(record.stays, STICKINESS_POLICIES, 'stickiness policy')
  if ([name, models, routing, stays].every(item => item === undefined)) throw new TypeError('Routing-group update has no changes')
  return {
    id: record.id,
    ...(name === undefined ? {} : { name }),
    ...(models === undefined ? {} : { models }),
    ...(routing === undefined ? {} : { routing }),
    ...(stays === undefined ? {} : { stays }),
  }
}

export function readAccountUpdate(value: unknown): MagpieAccountManagementUpdate {
  const record = asRecord(value)
  if (record === null) throw new TypeError('Invalid Magpie account update')
  assertAllowedKeys(record, ['agent', 'user', 'on'])
  const agent = safeText(record.agent, 64)
  const user = safeText(record.user, 180)
  if (agent === null || !ACCOUNT_AGENT.test(agent) || user === null || typeof record.on !== 'boolean') {
    throw new TypeError('Invalid Magpie account update')
  }
  return { agent, user, on: record.on }
}

function readWebProvider(record: Record<string, unknown>): { readonly record: MagpieProviderManagementRecord; readonly partial: boolean } | null {
  const id = safeText(record.id, 64)
  if (id === null || !PROVIDER_ID.test(id)) return null
  let partial = false
  const name = safeText(record.name, 180) ?? id
  if (record.name !== name) partial = true
  const endpoints: MagpieProviderEndpoint[] = []
  for (const field of ENDPOINT_FIELDS) {
    const value = record[field]
    if (typeof value !== 'string' || value.trim() === '') continue
    const url = safeEndpoint(value)
    if (url === null) {
      partial = true
      continue
    }
    endpoints.push({ field, url, editable: isPlainEndpoint(value) })
  }
  const chosen = readStringList(record.chosen, 2_000)
  let modelsEditable = Array.isArray(record.models) && record.models.length <= 10_000
  if (record.models !== undefined && !Array.isArray(record.models)) {
    modelsEditable = false
    partial = true
  }
  if (Array.isArray(record.models) && record.models.length > 10_000) {
    modelsEditable = false
    partial = true
  }
  if (record.models === undefined) partial = true
  if (record.chosen !== undefined && chosen === null) {
    modelsEditable = false
    partial = true
  }
  const chosenSet = chosen === null ? null : new Set(chosen)
  const rawModels = Array.isArray(record.models) && record.models.length <= 10_000 ? record.models : []
  const models: MagpieProviderModel[] = []
  for (const value of rawModels) {
    const model = asRecord(value)
    const localId = safeText(model?.id, 300)
    if (model === null || localId === null || !MODEL_ID.test(localId)) {
      modelsEditable = false
      partial = true
      continue
    }
    const fullId = localId.startsWith(`${id}/`) ? localId : `${id}/${localId}`
    const exposed = chosenSet === null
      ? model.given === true || model.on === true
      : chosenSet.has(localId) || chosenSet.has(fullId)
    models.push({ id: fullId, name: optionalSafeText(model.name, 200), exposed })
  }
  const status = typeof record.off === 'boolean' ? record.off ? 'off' : 'on' : 'unknown'
  const key = asRecord(record.key)
  const parsedFallback = readStringList(record.fallback, 100)
  if (record.fallback !== undefined && parsedFallback === null) partial = true
  const accountRecord = asRecord(record.account)
  const rawAccountAgent = accountRecord?.agent ?? accountRecord?.Agent
  const accountAgentText = safeText(rawAccountAgent, 64)
  const accountAgent = accountAgentText !== null && ACCOUNT_AGENT.test(accountAgentText) ? accountAgentText : null
  if (rawAccountAgent !== undefined && rawAccountAgent !== null && accountAgent === null) partial = true
  const normalized: MagpieProviderManagementRecord = {
    id,
    name,
    accountAgent,
    preset: optionalSafeText(record.preset, 100),
    protocol: endpoints[0]?.field ?? null,
    host: safeHost(optionalSafeText(record.host, 300)),
    website: safeWebUrl(record.website),
    state: status,
    account: optionalSafeText(record.account, 180)
      ?? optionalSafeText(accountRecord?.name ?? accountRecord?.Name, 180)
      ?? accountAgent,
    keyMasked: optionalSafeText(key?.masked, 80),
    endpoints,
    models,
    modelsEditable,
    modelCount: Array.isArray(record.models) && record.models.length <= 10_000 ? optionalInteger(rawModels.length) : null,
    exposedModelCount: optionalInteger(record.exposed) ?? optionalInteger(chosen?.length ?? null),
    fallback: parsedFallback ?? [],
    routing: optionalSafeText(record.routing, 64),
    affinity: optionalSafeText(record.affinity, 64),
    maxConcurrency: optionalNumber(record.maxConcurrency),
  }
  return { record: normalized, partial }
}

function readWebGroup(record: Record<string, unknown>): MagpieRoutingGroupManagementRecord | null {
  const rawId = safeText(record.id, 128)
  const id = rawId === null ? null : normalizeGroupId(rawId)
  const name = safeText(record.name, 120)
  if (id === null || !GROUP_ID.test(id) || name === null) return null
  const membersValue = record.members === undefined ? [] : record.members
  if (!Array.isArray(membersValue) || membersValue.length > 2_000) return null
  const memberInfo = Array.isArray(record.memberInfo) && record.memberInfo.length <= 2_000
    ? record.memberInfo.flatMap(value => {
      const item = asRecord(value)
      const itemId = safeText(item?.id ?? item?.of, 512)
      return item === null || itemId === null ? [] : [[itemId, item] as const]
    })
    : []
  const infoById = new Map(memberInfo)
  const members: MagpieRoutingGroupMember[] = []
  for (const value of membersValue) {
    const memberId = safeText(value, 512)
    if (memberId === null || !(MODEL_ID.test(memberId) || memberId.startsWith('group/'))) return null
    const info = infoById.get(memberId)
    members.push({
      id: memberId,
      provider: optionalSafeText(info?.provider, 64) ?? providerFromModelId(memberId),
      name: optionalSafeText(info?.name, 180),
      model: optionalSafeText(info?.model, 300) ?? modelFromMemberId(memberId),
      on: readBooleanOrCount(info?.on),
      ready: optionalBoolean(info?.ready),
      byPattern: false,
    })
  }
  const patterns = readGroupPatterns(record.match, record.patterns)
  if (patterns === null) return null
  const usedBy = readStringList(record.usedBy ?? record.agents, 500)
  if (record.usedBy !== undefined || record.agents !== undefined) {
    if (usedBy === null) return null
  }
  return {
    id,
    name,
    routing: optionalSafeText(record.routing, 64),
    stays: optionalSafeText(record.affinity ?? record.stays, 64),
    members,
    usedBy: usedBy ?? [],
    patterns,
  }
}

function readWebAccount(record: Record<string, unknown>, fallbackAgent?: string): MagpieAccountManagementRecord | null {
  const agent = safeText(record.agent ?? record.Agent ?? record.provider ?? record.Provider ?? fallbackAgent, 64)
  const user = safeText(record.user ?? record.User ?? record.email ?? record.account, 180)
  if (agent === null || !ACCOUNT_AGENT.test(agent) || user === null) return null
  const windows = readAccountWindows(record.windows ?? record.Windows)
  if (windows === null) return null
  return {
    agent,
    user,
    alias: optionalSafeText(record.alias, 180),
    plan: optionalSafeText(record.plan, 120),
    active: optionalBoolean(record.active ?? record.Active),
    on: optionalBoolean(record.on ?? record.On),
    balance: optionalSafeText(record.balance, 180),
    windows,
    asOf: optionalSafeText(record.asOf ?? record.as_of, 64),
    readAt: optionalSafeText(record.readAt ?? record.read_at, 64),
  }
}

function readLoginUsageRecords(value: unknown): readonly Record<string, unknown>[] | null {
  if (!Array.isArray(value) && asRecord(value) === null) return null
  const rows: Record<string, unknown>[] = []
  const visit = (item: unknown, inheritedAgent: string | undefined, depth: number): void => {
    if (depth > 5 || rows.length > MAX_ACCOUNTS) return
    if (Array.isArray(item)) {
      for (const child of item) visit(child, inheritedAgent, depth + 1)
      return
    }
    const record = asRecord(item)
    if (record === null) return
    if (safeText(record.user ?? record.User ?? record.email ?? record.account, 180) !== null) {
      rows.push(inheritedAgent === undefined || record.agent !== undefined || record.Agent !== undefined || record.provider !== undefined
        ? record
        : { ...record, agent: inheritedAgent })
      return
    }
    for (const [key, child] of Object.entries(record)) {
      const agent = ACCOUNT_AGENT.test(key) ? key : inheritedAgent
      if (LOGIN_CONTAINER_FIELDS.has(key) || asRecord(child) !== null || Array.isArray(child)) visit(child, agent, depth + 1)
    }
  }
  visit(value, undefined, 0)
  return rows.length > MAX_ACCOUNTS ? null : rows
}

function readProviderAccountRecords(value: unknown): readonly Record<string, unknown>[] | null {
  const root = asRecord(value)
  if (root === null || !Array.isArray(root.providers) || root.providers.length > MAX_PROVIDERS) return null
  const rows: Record<string, unknown>[] = []
  for (const value of root.providers) {
    const provider = asRecord(value)
    const providerId = safeText(provider?.id, 64)
    if (provider === null || providerId === null) continue
    const account = asRecord(provider.account)
    if (account === null || account.logins === undefined || account.logins === null) continue
    const agent = safeText(account.agent ?? account.Agent, 64) ?? providerId
    if (!ACCOUNT_AGENT.test(agent)) continue
    const logins = readLoginUsageRecords({ [agent]: account.logins })
    if (logins === null) return null
    for (const login of logins) {
      rows.push(login)
      if (rows.length > MAX_ACCOUNTS) return null
    }
  }
  return rows
}

function readWebRows(value: unknown, limit: number): readonly Record<string, unknown>[] | null {
  const root = asRecord(value)
  const rows = Array.isArray(value) ? value : Array.isArray(root?.data) ? root.data : null
  if (rows === null || rows.length > limit) return null
  const records = rows.map(asRecord)
  return records.some(record => record === null) ? null : records as Record<string, unknown>[]
}

function readAccountWindows(value: unknown): readonly MagpieAccountWindow[] | null {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value) || value.length > 100) return null
  const windows: MagpieAccountWindow[] = []
  for (const item of value) {
    const record = asRecord(item)
    const name = safeText(record?.name ?? record?.Name, 100)
    if (record === null || name === null) return null
    windows.push({
      name,
      used: optionalNumber(record.used ?? record.Used),
      remaining: optionalNumber(record.remaining ?? record.Remaining),
      resetsAt: optionalSafeText(record.resetsAt ?? record.resets_at, 64),
      display: optionalSafeText(record.display, 120),
    })
  }
  return windows
}

function mergeAccount(left: MagpieAccountManagementRecord, right: MagpieAccountManagementRecord): MagpieAccountManagementRecord {
  return {
    agent: left.agent,
    user: left.user,
    alias: right.alias ?? left.alias,
    plan: right.plan ?? left.plan,
    active: right.active ?? left.active,
    on: right.on ?? left.on,
    balance: right.balance ?? left.balance,
    windows: right.windows.length > 0 ? right.windows : left.windows,
    asOf: right.asOf ?? left.asOf,
    readAt: right.readAt ?? left.readAt,
  }
}

function providerHasConfigChange(update: MagpieProviderManagementUpdate, current: MagpieProviderManagementRecord): boolean {
  return update.name !== undefined && update.name !== current.name
    || update.endpointField !== undefined && update.endpointUrl !== undefined
      && current.endpoints.find(item => item.field === update.endpointField)?.url !== update.endpointUrl
    || update.models !== undefined && !sameStringOrder(update.models, current.models.filter(model => model.exposed).map(model => model.id))
}

function providerSavePayload(current: MagpieProviderManagementRecord, update: MagpieProviderManagementUpdate): Record<string, unknown> {
  const payload: Record<string, unknown> = { id: current.id }
  if (update.name !== undefined) payload.name = update.name
  if (update.endpointField !== undefined && update.endpointUrl !== undefined) {
    payload[update.endpointField] = update.endpointUrl
  }
  if (update.models !== undefined) {
    payload.models = update.models.map(model => localModelId(current.id, model))
  }
  return payload
}

function groupSavePayload(
  raw: Record<string, unknown>,
  current: MagpieRoutingGroupManagementRecord,
  update: MagpieRoutingGroupManagementUpdate,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (GROUP_VIEW_FIELDS.has(key) || GROUP_MUTABLE_FIELDS.has(key)) continue
    const clone = safeJsonClone(value)
    if (clone !== undefined) payload[key] = clone
  }
  const models = update.models ?? editableGroupModels(current)
  payload.id = current.id
  payload.name = update.name ?? current.name
  payload.members = models.filter(model => !isGroupPattern(model))
  payload.match = models.filter(isGroupPattern)
  payload.routing = update.routing ?? current.routing ?? 'smart'
  payload.affinity = update.stays ?? current.stays ?? 'auto'
  return payload
}

function providerConfigFingerprint(record: Record<string, unknown>): string {
  const viewOrMutable = new Set([...PROVIDER_VIEW_FIELDS, ...PROVIDER_MUTABLE_FIELDS])
  const preserved = Object.fromEntries(Object.entries(record).filter(([key]) => !viewOrMutable.has(key)))
  const key = asRecord(record.key)
  const keyList = Array.isArray(record.keyList)
    ? record.keyList.flatMap(value => {
      const item = asRecord(value)
      return item === null ? [] : [{ id: item.id, masked: item.masked, active: item.active, on: item.on }]
    })
    : record.keyList
  return stableJson({
    preserved,
    key: key === null ? null : { set: key.set, masked: key.masked, optional: key.optional },
    keyList,
    balanceToken: safeBalanceTokenStatus(record.balanceToken),
  })
}

function groupConfigFingerprint(record: Record<string, unknown>): string {
  const viewOrMutable = new Set([...GROUP_VIEW_FIELDS, ...GROUP_MUTABLE_FIELDS])
  return stableJson(Object.fromEntries(Object.entries(record).filter(([key]) => !viewOrMutable.has(key))))
}

function providerRecordFingerprint(record: Record<string, unknown>): string {
  const parsed = readWebProvider(record)
  return stableJson({ record: parsed?.record ?? null, protected: providerConfigFingerprint(record) })
}

function groupRecordFingerprint(record: Record<string, unknown>): string {
  const parsed = readWebGroup(record)
  return stableJson({ record: parsed, protected: groupConfigFingerprint(record) })
}

function otherProvidersUnchanged(before: readonly Record<string, unknown>[], after: readonly Record<string, unknown>[], id: string): boolean {
  const beforeOthers = before.filter(item => item.id !== id)
  const afterOthers = after.filter(item => item.id !== id)
  if (beforeOthers.length !== afterOthers.length) return false
  const afterById = new Map(afterOthers.map(item => [String(item.id), item]))
  return beforeOthers.every(item => {
    const saved = afterById.get(String(item.id))
    return saved !== undefined && providerRecordFingerprint(item) === providerRecordFingerprint(saved)
  })
}

function otherGroupsUnchanged(before: readonly Record<string, unknown>[], after: readonly Record<string, unknown>[], id: string): boolean {
  const beforeOthers = before.filter(item => normalizeGroupId(item.id) !== id)
  const afterOthers = after.filter(item => normalizeGroupId(item.id) !== id)
  if (beforeOthers.length !== afterOthers.length) return false
  const afterById = new Map(afterOthers.map(item => [normalizeGroupId(item.id), item]))
  return beforeOthers.every(item => {
    const saved = afterById.get(normalizeGroupId(item.id))
    return saved !== undefined && groupRecordFingerprint(item) === groupRecordFingerprint(saved)
  })
}

function otherAccountsUnchanged(
  before: readonly MagpieAccountManagementRecord[],
  after: readonly MagpieAccountManagementRecord[],
  agent: string,
  user: string,
): boolean {
  const accountKey = (account: MagpieAccountManagementRecord): string => `${account.agent.toLocaleLowerCase()}\u0000${account.user.toLocaleLowerCase()}`
  const target = `${agent.toLocaleLowerCase()}\u0000${user.toLocaleLowerCase()}`
  const previous = new Map(before.filter(account => accountKey(account) !== target).map(account => [accountKey(account), stableJson(account)]))
  const current = new Map(after.filter(account => accountKey(account) !== target).map(account => [accountKey(account), stableJson(account)]))
  return previous.size === current.size && [...previous].every(([key, value]) => current.get(key) === value)
}

function providerUpdateMatches(update: MagpieProviderManagementUpdate, saved: MagpieProviderManagementRecord): boolean {
  if (update.name !== undefined && update.name !== saved.name) return false
  if (update.on !== undefined && (update.on ? 'on' : 'off') !== saved.state) return false
  if (update.endpointField !== undefined && update.endpointUrl !== undefined
    && saved.endpoints.find(item => item.field === update.endpointField)?.url !== update.endpointUrl) return false
  if (update.models !== undefined && !sameStringOrder(update.models, saved.models.filter(model => model.exposed).map(model => model.id))) return false
  return true
}

function providerRecordMatchesUpdate(
  before: MagpieProviderManagementRecord,
  update: MagpieProviderManagementUpdate,
  saved: MagpieProviderManagementRecord,
): boolean {
  if (saved.name !== (update.name ?? before.name)) return false
  if (saved.state !== (update.on === undefined ? before.state : update.on ? 'on' : 'off')) return false
  const models = update.models ?? before.models.filter(model => model.exposed).map(model => model.id)
  if (!sameStringOrder(models, saved.models.filter(model => model.exposed).map(model => model.id))) return false
  return ENDPOINT_FIELDS.every(field => {
    const expected = field === update.endpointField && update.endpointUrl !== undefined
      ? update.endpointUrl
      : before.endpoints.find(endpoint => endpoint.field === field)?.url
    return expected === saved.endpoints.find(endpoint => endpoint.field === field)?.url
  })
}

function groupUpdateMatches(update: MagpieRoutingGroupManagementUpdate, saved: MagpieRoutingGroupManagementRecord): boolean {
  if (update.name !== undefined && update.name !== saved.name) return false
  if (update.models !== undefined && !sameStringOrder(update.models, editableGroupModels(saved))) return false
  for (const key of ['routing', 'stays'] as const) {
    if (update[key] !== undefined && update[key] !== saved[key]) return false
  }
  return true
}

function editableGroupModels(group: MagpieRoutingGroupManagementRecord): readonly string[] {
  return [...group.members.filter(member => !member.byPattern).map(member => member.id), ...group.patterns]
}

function findAccount(accounts: readonly MagpieAccountManagementRecord[], agent: string, user: string): MagpieAccountManagementRecord | undefined {
  return accounts.find(account => account.agent.toLocaleLowerCase() === agent.toLocaleLowerCase()
    && account.user.toLocaleLowerCase() === user.toLocaleLowerCase())
}

function readGroupPatterns(matchValue: unknown, patternsValue: unknown): readonly string[] | null {
  if (matchValue !== undefined) {
    const values = readStringList(matchValue, 500)
    if (values === null) return null
    return validatePatterns(values)
  }
  if (patternsValue === undefined) return []
  if (!Array.isArray(patternsValue) || patternsValue.length > 500) return null
  const patterns = patternsValue.flatMap(value => {
    if (typeof value === 'string') return [value]
    const record = asRecord(value)
    const pattern = safeText(record?.pattern, 300)
    return pattern === null ? [] : [pattern]
  })
  if (patterns.length !== patternsValue.length) return null
  return validatePatterns(patterns)
}

function validatePatterns(values: readonly string[]): readonly string[] | null {
  const unique: string[] = []
  for (const value of values) {
    if (!isGroupPattern(value)) return null
    if (!unique.includes(value)) unique.push(value)
  }
  return unique
}

function isGroupPattern(value: string): boolean {
  return (value.includes('*') || value.startsWith('re:'))
    && /^[A-Za-z0-9_*./:+|()\[\]{}?^-]+$/u.test(value)
    && value.includes('/')
}

function normalizeGroupId(value: unknown): string {
  const id = typeof value === 'string' ? value : ''
  return id.startsWith('group/') ? id.slice('group/'.length) : id
}

function safeEndpoint(value: string): string | null {
  if (value.length > 2_048 || /[\u0000-\u001f\u007f]/u.test(value)) return null
  try {
    const url = new URL(value)
    if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.hostname === '') return null
    url.username = ''
    url.password = ''
    url.search = ''
    url.hash = ''
    return `${url.origin}${url.pathname.replace(/\/$/u, '')}`
  } catch {
    return null
  }
}

function safeWebUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2_048) return null
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.origin : null
  } catch {
    return null
  }
}

function isPlainEndpoint(value: string): boolean {
  try {
    const url = new URL(value)
    return url.username === '' && url.password === '' && url.search === '' && url.hash === ''
  } catch {
    return false
  }
}

function safeHost(value: string | null): string | null {
  if (value === null || value.length > 300 || /[\u0000-\u001f\u007f]/u.test(value)) return null
  try {
    const url = new URL(value.includes('://') ? value : `https://${value}`)
    return `${url.hostname}${url.port === '' ? '' : `:${url.port}`}`
  } catch {
    return safeText(value, 300)
  }
}

function safeBalanceTokenStatus(value: unknown): unknown {
  const record = asRecord(value)
  return record === null ? null : { takes: record.takes, set: record.set }
}

function readModelList(value: unknown, providerId: string | null, allowPatterns: boolean): readonly string[] {
  if (!Array.isArray(value) || value.length > 200) throw new TypeError('Model list must be an array of at most 200 items')
  const models: string[] = []
  for (const item of value) {
    if (typeof item !== 'string' || item.length > 300 || /[\u0000-\u0020\u007f,]/u.test(item)) throw new TypeError('Invalid Magpie model id')
    const isPattern = allowPatterns && isGroupPattern(item)
    if (isPattern) {
      if (!item.includes('/')) throw new TypeError('Invalid routing-group model pattern')
    } else if (!MODEL_ID.test(item) || !item.includes('/') || providerId !== null && !item.startsWith(`${providerId}/`)) {
      throw new TypeError('Magpie model id is outside the allowed provider')
    }
    if (!models.includes(item)) models.push(item)
  }
  if (allowPatterns && models.length === 0) throw new TypeError('Routing groups need at least one model or pattern')
  return models
}

function localModelId(providerId: string, value: string): string {
  return value.startsWith(`${providerId}/`) ? value.slice(providerId.length + 1) : value
}

function providerFromModelId(value: string): string | null {
  if (value.startsWith('group/')) return null
  const separator = value.indexOf('/')
  return separator <= 0 ? null : value.slice(0, separator)
}

function modelFromMemberId(value: string): string {
  return value.startsWith('group/') ? value.slice('group/'.length) : value.slice(value.indexOf('/') + 1)
}

function optionalUpdateText(value: unknown, maxLength: number, label: string): string | undefined {
  if (value === undefined) return undefined
  const text = safeText(value, maxLength)
  if (text === null) throw new TypeError(`Invalid ${label}`)
  return text
}

function optionalUpdateBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') throw new TypeError(`Invalid ${label}`)
  return value
}

function optionalUpdateUrl(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length > 2_048 || /[\u0000-\u0020\u007f]/u.test(value)) throw new TypeError('Invalid provider endpoint URL')
  const safe = safeEndpoint(value)
  if (safe === null || safe !== value.replace(/\/$/u, '')) throw new TypeError('Provider endpoint must be an HTTP(S) URL without credentials, query, or fragment')
  return value.replace(/\/$/u, '')
}

function optionalEnum(value: unknown, allowed: ReadonlySet<string>, label: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !allowed.has(value)) throw new TypeError(`Invalid ${label}`)
  return value
}

function sameStringOrder(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index])
}

function assertAllowedKeys(record: Record<string, unknown>, allowed: readonly string[]): void {
  const permitted = new Set(allowed)
  if (Object.keys(record).some(key => !permitted.has(key))) throw new TypeError('Magpie management update contains an unsupported field')
}

function readStringList(value: unknown, limit: number): readonly string[] | null {
  if (!Array.isArray(value) || value.length > limit) return null
  const items = value.map(item => safeText(item, 512))
  return items.some(item => item === null) ? null : items as string[]
}

function safeJsonClone(value: unknown, depth = 0): unknown {
  if (depth > 8) return undefined
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value
  if (typeof value === 'string') return value.length <= 8_192 ? value : undefined
  if (Array.isArray(value)) {
    if (value.length > 2_000) return undefined
    const values = value.map(item => safeJsonClone(item, depth + 1))
    return values.some(item => item === undefined) ? undefined : values
  }
  const record = asRecord(value)
  if (record === null || Object.keys(record).length > 200) return undefined
  const result: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(record)) {
    if (key.length > 128) return undefined
    const cloned = safeJsonClone(item, depth + 1)
    if (cloned === undefined) return undefined
    result[key] = cloned
  }
  return result
}

function stableJson(value: unknown): string {
  const normalize = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(normalize)
    const record = asRecord(item)
    return record === null ? item : Object.fromEntries(Object.keys(record).sort().map(key => [key, normalize(record[key])]))
  }
  return JSON.stringify(normalize(value))
}

function safeText(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null
  const text = value.trim()
  return text !== '' && text.length <= maxLength && !/[\u0000-\u001f\u007f]/u.test(text) ? text : null
}

function optionalSafeText(value: unknown, maxLength: number): string | null {
  return value === undefined || value === null ? null : safeText(value, maxLength)
}

function optionalBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

function readBooleanOrCount(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value
  return typeof value === 'number' && Number.isFinite(value) ? value > 0 : null
}

function optionalNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function optionalInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

function signalOption(signal?: AbortSignal): Pick<MagpieWebRequestOptions, 'signal'> | Record<string, never> {
  return signal === undefined ? {} : { signal }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null
}
