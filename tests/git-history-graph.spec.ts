import assert from 'node:assert/strict'
import test from 'node:test'
import { buildHistoryGraph, GRAPH_DASH_ARRAY, GRAPH_UNPUSHED_COLOR, isUnpushed, laneCenterX, laneColor, laneDashed, laneStroke, segmentStroke } from '../data/build/dist/client/git-history-graph.js'

test('提交图：线性历史只有一条泳道', () => {
  const graph = buildHistoryGraph([
    { commitHash: 'c', parents: ['b'] },
    { commitHash: 'b', parents: ['a'] },
    { commitHash: 'a', parents: [] },
  ])
  assert.equal(graph.laneCount, 1)
  assert.deepEqual(graph.rows.map((row) => row.lane), [0, 0, 0])
  assert.deepEqual(graph.rows.map((row) => row.branches.map((branch) => [branch.lane, branch.created])), [[[0, false]], [[0, false]], []])
  assert.deepEqual(graph.rows.map((row) => row.through.map((lane) => lane.lane)), [[], [], []])
  assert.deepEqual(graph.rows.map((row) => row.merges.map((lane) => lane.lane)), [[], [], []])
  assert.deepEqual(graph.rows.map((row) => row.top.map((lane) => lane.lane)), [[], [0], [0]])
  assert.deepEqual(graph.rows.map((row) => row.bottom.map((lane) => lane.lane)), [[0], [0], []])
})

test('提交图：合并提交分出泳道，第二父提交的连线并回主线', () => {
  const graph = buildHistoryGraph([
    { commitHash: 'm', parents: ['a', 'b'] },
    { commitHash: 'a', parents: ['c'] },
    { commitHash: 'b', parents: ['c'] },
    { commitHash: 'c', parents: [] },
  ])
  assert.equal(graph.laneCount, 2)
  assert.deepEqual(graph.rows.map((row) => row.lane), [0, 0, 1, 0])
  // 合并提交：第一父提交延续本泳道，第二父提交新开泳道。
  assert.deepEqual(graph.rows[0]?.branches.map((branch) => [branch.lane, branch.created]), [[0, false], [1, true]])
  // 主线继续贯穿特性分支所在泳道。
  assert.deepEqual(graph.rows[1]?.through.map((lane) => lane.lane), [1])
  // 特性分支提交：自己的泳道被回收，连线并回主线泳道。
  assert.deepEqual(graph.rows[2]?.through.map((lane) => lane.lane), [0])
  assert.deepEqual(graph.rows[2]?.branches.map((branch) => [branch.lane, branch.created]), [[0, false]])
  // 两条分支汇聚到同一个提交时，该提交回到主线泳道，且没有多余的并入连线。
  assert.equal(graph.rows[3]?.lane, 0)
  assert.deepEqual(graph.rows[3]?.merges, [])
  assert.deepEqual(graph.rows[3]?.bottom, [])
})

test('提交图：多父提交按需扩展泳道数量', () => {
  const graph = buildHistoryGraph([
    { commitHash: 'x', parents: ['p1', 'p2', 'p3'] },
    { commitHash: 'p1', parents: ['base'] },
    { commitHash: 'p2', parents: ['base'] },
    { commitHash: 'p3', parents: ['base'] },
    { commitHash: 'base', parents: [] },
  ])
  assert.equal(graph.laneCount, 3)
  assert.deepEqual(graph.rows.map((row) => row.lane), [0, 0, 1, 2, 0])
  assert.deepEqual(graph.rows[0]?.branches.map((branch) => branch.lane), [0, 1, 2])
  assert.deepEqual(graph.rows[2]?.through.map((lane) => lane.lane), [0, 2])
  assert.deepEqual(graph.rows[3]?.through.map((lane) => lane.lane), [0])
})

test('提交图：起点更早的分支并回主干，主干始终留在最左泳道', () => {
  const graph = buildHistoryGraph([
    { commitHash: 'm', parents: ['c', 'b'] },
    { commitHash: 'd', parents: ['a'] },
    { commitHash: 'b', parents: ['a'] },
    { commitHash: 'c', parents: ['a'] },
    { commitHash: 'a', parents: [] },
  ])
  assert.equal(graph.laneCount, 3)
  // d 直接指向主干中更靠后的 a：不新开泳道，连线并入 0 号主干泳道。
  assert.equal(graph.rows[1]?.lane, 2)
  assert.deepEqual(graph.rows[1]?.branches.map((branch) => [branch.lane, branch.created]), [[0, false]])
  assert.deepEqual(graph.rows[1]?.through.map((lane) => lane.lane), [0, 1])
  // 主干提交 a 仍然落在 0 号泳道，而不是被 d 顶到 2 号泳道。
  assert.equal(graph.rows[3]?.lane, 0)
  assert.equal(graph.rows[4]?.lane, 0)
  assert.deepEqual(graph.rows.map((row) => row.lane), [0, 2, 1, 0, 0])
})

test('提交图：缺少父提交字段时退化为连续竖线', () => {
  const graph = buildHistoryGraph([
    { commitHash: 'c' },
    { commitHash: 'b' },
    { commitHash: 'a' },
  ])
  assert.equal(graph.laneCount, 1)
  assert.deepEqual(graph.rows.map((row) => row.lane), [0, 0, 0])
  assert.deepEqual(graph.rows.map((row) => row.branches.length), [1, 1, 0])
  assert.deepEqual(graph.rows[0]?.branches.map((branch) => branch.lane), [0])
})

test('提交图：泳道坐标与配色稳定', () => {
  assert.equal(laneCenterX(0), 7)
  assert.equal(laneCenterX(2), 35)
  assert.equal(laneColor(0), laneColor(8))
  assert.notEqual(laneColor(0), laneColor(1))
})

test('提交图：归属不影响泳道配色，只决定是否换成蓝色虚线', () => {
  const graph = buildHistoryGraph([
    { commitHash: 'c', parents: ['b'], origin: 'local' },
    { commitHash: 'b', parents: ['a'], origin: 'synced' },
    { commitHash: 'a', parents: [], origin: 'synced' },
  ])
  assert.equal(graph.rows[0]?.origin, 'local')
  assert.equal(graph.rows[0]?.incomingOrigin, undefined)
  assert.equal(graph.rows[1]?.incomingOrigin, 'local')
  assert.equal(graph.rows[1]?.origin, 'synced')
  // 未推送的段：固定蓝色 + 虚线，但泳道本身仍记录原来的颜色。
  const unpushed = graph.rows[0]!.branches[0]!
  assert.equal(unpushed.origin, 'local')
  assert.equal(laneStroke(unpushed), GRAPH_UNPUSHED_COLOR)
  assert.equal(laneColor(unpushed.color), laneColor(graph.rows[0]!.color))
  // 已同步的段：回到泳道彩色实线。
  const synced = graph.rows[1]!.branches[0]!
  assert.equal(laneStroke(synced), laneColor(synced.color))
  assert.notEqual(laneStroke(synced), GRAPH_UNPUSHED_COLOR)
})

test('提交图：新泳道继承创建者的未推送状态', () => {
  const graph = buildHistoryGraph([
    { commitHash: 'm', parents: ['c', 'b'], origin: 'local' },
    { commitHash: 'b', parents: ['a'], origin: 'branch' },
    { commitHash: 'c', parents: ['a'], origin: 'branch' },
    { commitHash: 'a', parents: [], origin: 'synced' },
  ])
  const created = graph.rows[0]!.branches.find((branch) => branch.created)
  assert.equal(created?.origin, 'local')
  assert.equal(laneStroke(created!), GRAPH_UNPUSHED_COLOR)
  assert.equal(laneDashed(created!), true)
  // 主干段在 a 处回到已同步，用泳道彩色实线。
  assert.equal(graph.rows[3]?.origin, 'synced')
  assert.equal(laneDashed(graph.rows[3]!.branches[0] ?? { lane: 0, color: 0 }), false)
})

test('提交图：缺少归属时保持泳道彩色实线', () => {
  const graph = buildHistoryGraph([
    { commitHash: 'b', parents: ['a'] },
    { commitHash: 'a', parents: [] },
  ])
  assert.equal(graph.rows[0]?.origin, undefined)
  assert.equal(graph.rows[0]!.branches[0]?.origin, undefined)
  assert.equal(laneStroke(graph.rows[0]!.branches[0]!), laneColor(graph.rows[0]!.branches[0]!.color))
  assert.equal(laneDashed(graph.rows[0]!.branches[0]!), false)
})

test('提交图：未推送色固定为蓝色，与泳道配色无关', () => {
  assert.equal(GRAPH_UNPUSHED_COLOR, '#2b74d8')
  for (let color = 0; color < 8; color += 1) {
    assert.equal(segmentStroke('local', color), GRAPH_UNPUSHED_COLOR)
    assert.equal(segmentStroke('branch', color), GRAPH_UNPUSHED_COLOR)
    assert.equal(segmentStroke('synced', color), laneColor(color))
    assert.equal(segmentStroke('remote', color), laneColor(color))
    assert.equal(segmentStroke(undefined, color), laneColor(color))
  }
})

test('提交图：只有其他本地分支的提交同样算未推送', () => {
  const graph = buildHistoryGraph([
    { commitHash: 'm', parents: ['c'], origin: 'synced' },
    { commitHash: 'c', parents: ['a'], origin: 'branch' },
    { commitHash: 'a', parents: [], origin: 'synced' },
  ])
  assert.equal(laneDashed(graph.rows[1]!.branches[0]!), true)
})
