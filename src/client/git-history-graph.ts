import type { GitHistoryItem, GitHistoryOrigin } from '../shared/contracts/git.js'

/**
 * 版本列表左侧提交图的泳道布局。
 *
 * 这里只做纯计算，不依赖 React 与 DOM，便于单独测试；渲染侧按
 * `lane * 泳道宽度` 定位，因此泳道索引在整个列表内必须保持稳定。
 *
 * 颜色有两条来源：
 * - 提交归属已知时，节点、从它出发的竖线与分叉线用归属色（`origin`），
 *   一眼就能看出哪些提交只在本地、哪些已经同步到远程；
 * - 归属未知（旧 Host）或只是别的分支路过本行的贯穿线，退回按泳道取色。
 */

/** 泳道配色：颜色表达分支拓扑，同一泳道在其生命周期内保持不变，索引回绕复用。 */
export const GRAPH_LANE_COLORS = ['#4f9cff', '#a56bff', '#e86aa6', '#3fbf8f', '#f0a13a', '#25b0c4', '#e2555c', '#93b82c'] as const

/** 未推送线段的固定色：不参与泳道配色，始终是这个蓝色。 */
export const GRAPH_UNPUSHED_COLOR = '#2b74d8'

/**
 * 未推送线段用固定蓝色虚线，而不是把整条线改成归属色：
 * 颜色继续表达分支拓扑（泳道配色），线型与固定蓝色表达「这段还没进任何远程」。
 */
export const GRAPH_DASH_ARRAY = '3 3'

/** 只存在于本地（当前分支或别的本地分支）的提交，它下方那一段连线算未推送。 */
export function isUnpushed(origin: GitHistoryOrigin | undefined): boolean {
  return origin === 'local' || origin === 'branch'
}

/** 与 historyRowMainStyle 的 min-height 保持一致，SVG 的纵坐标直接按行高计算。 */
export const GRAPH_ROW_HEIGHT = 28
/** 单条泳道的水平宽度。 */
export const GRAPH_LANE_WIDTH = 14

export interface GitGraphLane {
  readonly lane: number
  readonly color: number
  /** 该泳道当前这一段竖线所属提交的归属；缺省时按泳道取色。 */
  readonly origin?: GitHistoryOrigin
}

export interface GitGraphEdge extends GitGraphLane {
  /** 该连线是否在本行新建了泳道。 */
  readonly created: boolean
}

export interface GitGraphRow {
  /** 提交节点所在泳道。 */
  readonly lane: number
  readonly color: number
  /** 本提交的归属，决定节点与它这一段竖线的颜色。 */
  readonly origin?: GitHistoryOrigin
  /** 进入本节点的竖线归属（由上方提交决定），缺省时按泳道取色。 */
  readonly incomingOrigin?: GitHistoryOrigin
  /** 穿过本行、与节点无关的直线泳道。 */
  readonly through: readonly GitGraphLane[]
  /** 从上方并入节点的泳道。 */
  readonly merges: readonly GitGraphEdge[]
  /** 由节点向下分出的泳道，包含第一父提交的延续。 */
  readonly branches: readonly GitGraphEdge[]
  /** 本行上方已占用的泳道；日期分隔行用它绘制贯穿线。 */
  readonly top: readonly GitGraphLane[]
  /** 本行下方已占用的泳道；分支标签行用它延续竖线。 */
  readonly bottom: readonly GitGraphLane[]
}

export interface GitHistoryGraph {
  readonly rows: readonly GitGraphRow[]
  /** 整个列表需要的泳道数量，用于统一左侧栏宽度。 */
  readonly laneCount: number
}

type GraphInput = Pick<GitHistoryItem, 'commitHash'> & {
  readonly parents?: readonly string[] | undefined
  readonly origin?: GitHistoryOrigin | undefined
}

interface LaneState {
  hash: string | null
  color: number
  origin?: GitHistoryOrigin
}

/** 泳道快照：对渲染侧只暴露 GitGraphLane，内部还要用 hash 判断它是否在等本提交。 */
interface LaneSnapshot extends GitGraphLane {
  readonly hash: string | null
}

/** exactOptionalPropertyTypes 下不能显式赋 undefined，缺省归属时不带这个字段。 */
function laneExpectation(hash: string, color: number, origin: GitHistoryOrigin | undefined): LaneState {
  return origin === undefined ? { hash, color } : { hash, color, origin }
}

/**
 * 按 `git log` 的先后顺序分配泳道：
 * 每条泳道记录“下一个将要出现的提交”，提交到达时复用等待它的泳道，
 * 第一父提交延续本泳道，其余父提交并入已有泳道或新开泳道。
 */
export function buildHistoryGraph(items: readonly GraphInput[]): GitHistoryGraph {
  const lanes: LaneState[] = []
  const rows: GitGraphRow[] = []
  const parentsAvailable = items.some((item) => item.parents !== undefined)
  const resolvedParents = items.map((item, index) => uniqueHashes(parentsAvailable ? item.parents ?? [] : fallbackParents(items, index)))
  const trunk = collectTrunk(items, resolvedParents)
  let colorCursor = 0
  let laneCount = 0
  const nextColor = (): number => {
    const color = colorCursor % GRAPH_LANE_COLORS.length
    colorCursor += 1
    return color
  }
  const firstFreeLane = (): number => lanes.findIndex((lane) => lane.hash === null)
  const snapshot = (): readonly LaneSnapshot[] => lanes
    .map((lane, laneIndex) => ({
      lane: laneIndex, color: lane.color, hash: lane.hash,
      ...(lane.hash === null || lane.origin === undefined ? {} : { origin: lane.origin }),
    }))
    .filter((_lane, laneIndex) => lanes[laneIndex]!.hash !== null)

  for (const [index, item] of items.entries()) {
    const parents = resolvedParents[index] ?? []
    let lane = lanes.findIndex((state) => state.hash === item.commitHash)
    const top = snapshot()
    const topLanes = new Set(top.map((state) => state.lane))
    if (lane < 0) {
      lane = firstFreeLane()
      if (lane < 0) {
        lanes.push({ hash: item.commitHash, color: nextColor() })
        lane = lanes.length - 1
      } else {
        const recycled = lanes[lane]!
        recycled.hash = item.commitHash
        recycled.color = nextColor()
        delete recycled.origin
      }
    }
    // 进入本节点的竖线沿用上一段所属提交的归属色，视觉上在节点处换色。
    const incomingOrigin = lane < 0 ? undefined : lanes[lane]!.origin
    // 等待同一提交的其他泳道在本行并入节点；正常情况下最多只有一条。
    const merges: GitGraphEdge[] = []
    for (const state of top) {
      if (state.lane === lane || state.hash !== item.commitHash) continue
      merges.push({ lane: state.lane, color: state.color, created: false, ...(state.origin === undefined ? {} : { origin: state.origin }) })
      lanes[state.lane]!.hash = null
    }
    const nodeColor = lanes[lane]!.color
    lanes[lane]!.hash = null
    if (item.origin === undefined) delete lanes[lane]!.origin
    else lanes[lane]!.origin = item.origin
    const branches: GitGraphEdge[] = []
    for (const [parentIndex, parent] of parents.entries()) {
      let target = lanes.findIndex((state) => state.hash === parent)
      let created = false
      if (target < 0) {
        if (trunk.has(parent)) {
          // 主干提交统一落在 0 号泳道：主干线还在等更早的提交时，这条连线先并入主干。
          if (lanes.length === 0) {
            lanes.push(laneExpectation(parent, nextColor(), item.origin))
            target = 0
          } else {
            const trunkLane = lanes[0]!
            if (trunkLane.hash === null) {
              trunkLane.hash = parent
              if (item.origin === undefined) delete trunkLane.origin
              else trunkLane.origin = item.origin
            }
            target = 0
          }
        } else if (parentIndex === 0) {
          lanes[lane] = laneExpectation(parent, nodeColor, item.origin)
          target = lane
        } else {
          target = firstFreeLane()
          if (target < 0) {
            lanes.push(laneExpectation(parent, nextColor(), item.origin))
            target = lanes.length - 1
          } else {
            lanes[target] = laneExpectation(parent, nextColor(), item.origin)
          }
          created = true
        }
      }
      const targetLane = lanes[target]!
      branches.push({ lane: target, color: targetLane.color, created, ...(targetLane.origin === undefined ? {} : { origin: targetLane.origin }) })
    }
    const bottom = snapshot()
    const consumed = new Set([lane, ...merges.map((merge) => merge.lane)])
    const createdLanes = new Set(branches.filter((branch) => branch.created).map((branch) => branch.lane))
    const through = bottom.filter((state) => state.lane !== lane && topLanes.has(state.lane) && !consumed.has(state.lane) && !createdLanes.has(state.lane))
    // 节点所在泳道可能比本行顶部和底部的泳道都靠右（例如只指向主干靠后提交的分支顶端）。
    laneCount = Math.max(laneCount, top.length, bottom.length, lane + 1)
    rows.push({
      lane, color: nodeColor, through, merges, branches, top, bottom,
      ...(item.origin === undefined ? {} : { origin: item.origin }),
      ...(incomingOrigin === undefined ? {} : { incomingOrigin }),
    })
  }
  return { rows, laneCount: Math.max(1, laneCount) }
}

/**
 * 从列表首条提交沿父提交链走出的主干（当前检出的分支）。
 * 主干固定占用 0 号泳道，其他分支从 1 号泳道向右侧展开，视觉上与 VS Code 的分支图一致。
 */
function collectTrunk(items: readonly GraphInput[], resolvedParents: readonly (readonly string[])[]): ReadonlySet<string> {
  const indexByHash = new Map(items.map((item, index) => [item.commitHash, index] as const))
  const trunk = new Set<string>()
  let current = items[0]?.commitHash
  while (current !== undefined && !trunk.has(current)) {
    trunk.add(current)
    const index = indexByHash.get(current)
    current = index === undefined ? undefined : resolvedParents[index]?.[0]
  }
  return trunk
}

/** 旧版 Host 不返回父提交时，用相邻提交拼出线性历史，至少保证竖线连续。 */
function fallbackParents(items: readonly GraphInput[], index: number): readonly string[] {
  const next = items[index + 1]
  return next === undefined ? [] : [next.commitHash]
}

function uniqueHashes(values: readonly string[]): readonly string[] {
  const result: string[] = []
  for (const value of values) {
    const hash = value.trim()
    if (hash !== '' && !result.includes(hash)) result.push(hash)
  }
  return result
}

export function laneColor(color: number): string {
  return GRAPH_LANE_COLORS[((color % GRAPH_LANE_COLORS.length) + GRAPH_LANE_COLORS.length) % GRAPH_LANE_COLORS.length]!
}

/** 一段线的颜色：默认是泳道色；未推送的段改用固定蓝色（配合虚线）。 */
export function segmentStroke(origin: GitHistoryOrigin | undefined, color: number): string {
  return isUnpushed(origin) ? GRAPH_UNPUSHED_COLOR : laneColor(color)
}

/** 泳道线（贯穿线、rails）的颜色：同样是「未推送换蓝」，其余用泳道色。 */
export function laneStroke(lane: GitGraphLane): string {
  return segmentStroke(lane.origin, lane.color)
}

/** 一段竖线是否画虚线。 */
export function laneDashed(lane: GitGraphLane): boolean {
  return isUnpushed(lane.origin)
}

export function laneCenterX(lane: number): number {
  return lane * GRAPH_LANE_WIDTH + GRAPH_LANE_WIDTH / 2
}
