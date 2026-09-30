import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizePeerHostColor, createVirtualWorkspaceId } from '../data/build/dist/shared/index.js'
import { resolvePeerHostColor } from '../data/build/dist/client/peer-host-color.js'
import {
  PEER_HOST_WORKSPACE_TAG_ATTRIBUTE,
  resolveWorkspaceIdFromRow,
  startPeerHostWorkspaceTag,
} from '../data/build/dist/client/peer-host-workspace-tag.js'

test('配色只接受 #rrggbb，其余一律回退到按名称推导', () => {
  assert.equal(normalizePeerHostColor('#1677FF'), '#1677ff')
  assert.equal(normalizePeerHostColor('  #abcdef '), '#abcdef')
  assert.equal(normalizePeerHostColor('#abc'), null)
  assert.equal(normalizePeerHostColor('red'), null)
  assert.equal(normalizePeerHostColor('#12345g'), null)
  // 颜色会被写进内联样式，CSS 注入串必须被拒绝。
  assert.equal(normalizePeerHostColor('red; background:url(x)'), null)
  assert.equal(normalizePeerHostColor(null), null)
  assert.equal(normalizePeerHostColor(42), null)
})

test('未配置颜色时按名称推导且结果稳定', () => {
  const first = resolvePeerHostColor(null, '开发机')
  const second = resolvePeerHostColor(undefined, '开发机')
  // 同一台机器在多次刷新、多个工作区之间必须保持同色，否则标签失去识别意义。
  assert.equal(first, second)
  assert.match(first, /^#[0-9a-f]{6}$/u)
  // 显式配置优先于推导。
  assert.equal(resolvePeerHostColor('#123456', '开发机'), '#123456')
  // 非法配置退回推导，而不是原样输出。
  assert.equal(resolvePeerHostColor('nonsense', '开发机'), first)
})

test('工作区行优先用 data-row-key 反查虚拟 ID', () => {
  const row = new FakeElement('div')
  row.setAttribute('data-row-key', 'workspace:codingns:peer-host:v1:workspace:peer-1:workspace-1')
  assert.equal(resolveWorkspaceIdFromRow(row), 'codingns:peer-host:v1:workspace:peer-1:workspace-1')

  // data-row-key 不是工作区行时退回 fiber。
  const fiberRow = new FakeElement('div')
  fiberRow.setAttribute('data-row-key', 'session:abc')
  Object.defineProperty(fiberRow, '__reactFiber$tag', {
    value: { memoizedProps: { group: { workspaceId: 'workspace-from-fiber' } } },
  })
  assert.equal(resolveWorkspaceIdFromRow(fiberRow), 'workspace-from-fiber')

  // 两条路径都拿不到时返回 undefined，而不是编造 ID。
  assert.equal(resolveWorkspaceIdFromRow(new FakeElement('div')), undefined)
})

test('只为远端工作区注入彩色标签，本地工作区不加标签', async () => {
  const localRow = workspaceRow('local-workspace')
  const remoteRow = workspaceRow('codingns:peer-host:v1:workspace:peer-1:workspace-1')
  const document = new FakeDocument([localRow, remoteRow])
  const controller = startPeerHostWorkspaceTag({ document, MutationObserver: undefined })

  controller.setAggregate([
    { hostId: 'local-host', targetHostId: null, hostLabel: '当前 Host', availability: 'ready', errorCode: null, workspaces: [workspace('local-workspace', '本机工作区')] },
    {
      hostId: 'local-host', targetHostId: 'peer-1', hostLabel: '开发机', hostColor: '#1677ff', availability: 'ready', errorCode: null,
      workspaces: [workspace('workspace-1', '远端工作区')],
    },
  ])
  await settle()

  assert.equal(localRow.querySelectorAll(`[${PEER_HOST_WORKSPACE_TAG_ATTRIBUTE}]`).length, 0)
  const tags = remoteRow.querySelectorAll(`[${PEER_HOST_WORKSPACE_TAG_ATTRIBUTE}]`)
  assert.equal(tags.length, 1)
  assert.equal(tags[0]?.textContent, '开发机')
  assert.equal(tags[0]?.dataset.codingnsPeerHostColor, '#1677ff')
  // 标签是纯展示：不能抢走行的点击。
  assert.equal(tags[0]?.style.pointerEvents, 'none')
  assert.equal(tags[0]?.getAttribute('aria-hidden'), 'true')
  // 必须与工作区名称同一行：projectText 是 flex column 容器，标签若是它的子节点
  // 就会掉到第二行（用户实测的"挤压"）。标签必须是 projectText 的兄弟节点。
  const projectText = remoteRow.children.find((child) => (child.getAttribute('class') ?? '').includes('_projectText'))
  assert.equal(tags[0]?.parentElement, remoteRow)
  assert.equal(projectText?.children.some((child) => child.getAttribute(PEER_HOST_WORKSPACE_TAG_ATTRIBUTE) !== null), false)
  // 靠右：标签排在 projectText 之后并作为行的最后一个子节点。
  // rowActions 只在 hover 显示（display:none 不占位），放它之前会让标签在 hover 时被顶开。
  assert.ok(remoteRow.children.indexOf(tags[0] as FakeElement) > remoteRow.children.indexOf(projectText as FakeElement))
  assert.equal(remoteRow.children.at(-1), tags[0])
  assert.equal(tags[0]?.style.marginLeft, 'auto')
  assert.equal(tags[0]?.style.flex, 'none')
  // Host 名过长时截断 Host 名，而不是挤压工作区名。
  assert.equal(tags[0]?.style.maxWidth, '50px')

  controller.dispose()
  assert.equal(remoteRow.querySelectorAll(`[${PEER_HOST_WORKSPACE_TAG_ATTRIBUTE}]`).length, 0)
})

test('聚合里消失的工作区会被移除标签，重复扫描不产生副本', async () => {
  const remoteRow = workspaceRow('codingns:peer-host:v1:workspace:peer-1:workspace-1')
  const document = new FakeDocument([remoteRow])
  const controller = startPeerHostWorkspaceTag({ document, MutationObserver: undefined })
  const aggregate = [{
    hostId: 'local-host', targetHostId: 'peer-1', hostLabel: '开发机', hostColor: '#1677ff', availability: 'ready' as const, errorCode: null,
    workspaces: [workspace('workspace-1', '远端工作区')],
  }]

  controller.setAggregate(aggregate)
  await settle()
  controller.setAggregate(aggregate)
  await settle()
  // 重复刷新不能堆积多个标签。
  assert.equal(remoteRow.querySelectorAll(`[${PEER_HOST_WORKSPACE_TAG_ATTRIBUTE}]`).length, 1)

  // 用户移除该可见工作区后标签必须消失，否则侧栏会留下无主的彩色标记。
  controller.setAggregate([{ ...aggregate[0]!, workspaces: [] }])
  await settle()
  assert.equal(remoteRow.querySelectorAll(`[${PEER_HOST_WORKSPACE_TAG_ATTRIBUTE}]`).length, 0)
  controller.dispose()
})

test('标签颜色变化会就地更新，不残留旧色', async () => {
  const remoteRow = workspaceRow('codingns:peer-host:v1:workspace:peer-1:workspace-1')
  const document = new FakeDocument([remoteRow])
  const controller = startPeerHostWorkspaceTag({ document, MutationObserver: undefined })
  const base = {
    hostId: 'local-host', targetHostId: 'peer-1', availability: 'ready' as const, errorCode: null,
    workspaces: [workspace('workspace-1', '远端工作区')],
  }

  controller.setAggregate([{ ...base, hostLabel: '开发机', hostColor: '#1677ff' }])
  await settle()
  controller.setAggregate([{ ...base, hostLabel: '构建机', hostColor: '#f5222d' }])
  await settle()
  const tags = remoteRow.querySelectorAll(`[${PEER_HOST_WORKSPACE_TAG_ATTRIBUTE}]`)
  assert.equal(tags.length, 1)
  assert.equal(tags[0]?.textContent, '构建机')
  assert.equal(tags[0]?.dataset.codingnsPeerHostColor, '#f5222d')
  controller.dispose()
})

test('没有标题容器时跳过该行，不做兜底猜测', async () => {
  // 只有 data-row-key，没有 projectText 容器：宁可不注入，也不猜一个位置。
  const row = new FakeElement('div')
  row.setAttribute('data-row-key', `workspace:${createVirtualWorkspaceId('peer-1', 'workspace-1')}`)
  const document = new FakeDocument([row])
  const controller = startPeerHostWorkspaceTag({ document, MutationObserver: undefined })
  controller.setAggregate([{
    hostId: 'local-host', targetHostId: 'peer-1', hostLabel: '开发机', hostColor: '#1677ff', availability: 'ready', errorCode: null,
    workspaces: [workspace('workspace-1', '远端工作区')],
  }])
  await settle()
  assert.equal(row.querySelectorAll(`[${PEER_HOST_WORKSPACE_TAG_ATTRIBUTE}]`).length, 0)
  controller.dispose()
})

/** 注入器按微任务批量扫描；测试必须等它跑完再断言。 */
function settle(): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, 0) })
}

function workspace(workspaceId: string, displayName: string): Record<string, unknown> {
  return {
    key: `peer-1:${workspaceId}`,
    hostId: 'local-host',
    targetHostId: 'peer-1',
    workspaceId,
    displayName,
    path: `/Users/dev/${workspaceId}`,
    hostLabel: '开发机',
    availability: 'ready',
    sessions: [],
  }
}

function workspaceRow(workspaceId: string): FakeElement {
  const row = new FakeElement('div')
  row.setAttribute('role', 'treeitem')
  row.setAttribute('aria-expanded', 'true')
  row.setAttribute('data-row-key', `workspace:${workspaceId}`)
  const container = new FakeElement('span')
  container.setAttribute('class', 'YDXeBa_projectText')
  const title = new FakeElement('span')
  title.setAttribute('class', 'YDXeBa_title')
  container.appendChild(title)
  // 真实工作区行顺序：folder / chevron / projectText / rowActions。
  const actions = new FakeElement('span')
  actions.setAttribute('class', 'YDXeBa_rowActions')
  row.append(container, actions)
  return row
}

class FakeElement {
  tagName: string
  children: FakeElement[] = []
  parentElement: FakeElement | null = null
  attributes = new Map<string, string>()
  style: Record<string, string> = {}
  dataset: Record<string, string> = {}
  textContent = ''

  constructor(tagName: string) {
    this.tagName = tagName.toUpperCase()
  }

  setAttribute(name: string, value: string): void { this.attributes.set(name, value) }
  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null }
  appendChild(child: FakeElement): FakeElement { child.parentElement = this; this.children.push(child); return child }
  append(...children: FakeElement[]): void { for (const child of children) this.appendChild(child) }
  insertBefore(child: FakeElement, before: FakeElement | null): FakeElement {
    child.parentElement = this
    const index = before === null ? -1 : this.children.indexOf(before)
    if (index < 0) this.children.push(child)
    else this.children.splice(index, 0, child)
    return child
  }

  querySelectorAll(selector: string): FakeElement[] {
    const nodes = collect(this)
    if (selector === `[${PEER_HOST_WORKSPACE_TAG_ATTRIBUTE}]`) {
      return nodes.filter((node) => node.getAttribute(PEER_HOST_WORKSPACE_TAG_ATTRIBUTE) !== null)
    }
    if (selector === '[class*="_projectText"]') {
      return nodes.filter((node) => (node.getAttribute('class') ?? '').includes('_projectText'))
    }
    if (selector === '[role="treeitem"][aria-expanded]') {
      return nodes.filter((node) => node.getAttribute('role') === 'treeitem' && node.getAttribute('aria-expanded') !== null)
    }
    return []
  }

  querySelector(selector: string): FakeElement | null { return this.querySelectorAll(selector)[0] ?? null }

  remove(): void {
    if (this.parentElement === null) return
    const index = this.parentElement.children.indexOf(this)
    if (index >= 0) this.parentElement.children.splice(index, 1)
    this.parentElement = null
  }
}

class FakeDocument {
  body = new FakeElement('body')
  documentElement = new FakeElement('html')

  constructor(roots: FakeElement[]) {
    for (const root of roots) this.body.appendChild(root)
  }

  createElement(tagName: string): FakeElement { return new FakeElement(tagName) }
  querySelectorAll(selector: string): FakeElement[] { return this.body.querySelectorAll(selector) }
}

function collect(root: FakeElement): FakeElement[] {
  return [root, ...root.children.flatMap((child) => collect(child))]
}
