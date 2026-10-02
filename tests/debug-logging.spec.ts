import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CODINGNS4DSH_DEBUG_ENV,
  CODINGNS4DSH_DEBUG_LEVEL_ENV,
  debugInfo,
  debugWarn,
  resolveCodingNsDebugEnabled,
  resolveCodingNsDebugLevel,
} from '../data/build/dist/shared/debug.js'

test('调试日志默认关闭', () => {
  const previous = process.env[CODINGNS4DSH_DEBUG_ENV]
  delete process.env[CODINGNS4DSH_DEBUG_ENV]
  try {
    assert.equal(resolveCodingNsDebugEnabled(), false)
    const records: unknown[][] = []
    const info = console.info
    const warn = console.warn
    console.info = (...args: unknown[]) => records.push(args)
    console.warn = (...args: unknown[]) => records.push(args)
    try {
      debugInfo('hidden')
      debugWarn('hidden')
    } finally {
      console.info = info
      console.warn = warn
    }
    assert.deepEqual(records, [])
  } finally {
    if (previous === undefined) delete process.env[CODINGNS4DSH_DEBUG_ENV]
    else process.env[CODINGNS4DSH_DEBUG_ENV] = previous
  }
})

test('CODINGNS4DSH_DEBUG=1 才允许调试日志输出', () => {
  const previous = process.env[CODINGNS4DSH_DEBUG_ENV]
  process.env[CODINGNS4DSH_DEBUG_ENV] = '1'
  try {
    assert.equal(resolveCodingNsDebugEnabled(), true)
    const records: unknown[][] = []
    const info = console.info
    console.info = (...args: unknown[]) => records.push(args)
    try {
      debugInfo('visible', { endpoint: 'host/status' })
    } finally {
      console.info = info
    }
    assert.deepEqual(records, [['visible', { endpoint: 'host/status' }]])
  } finally {
    if (previous === undefined) delete process.env[CODINGNS4DSH_DEBUG_ENV]
    else process.env[CODINGNS4DSH_DEBUG_ENV] = previous
  }
})

test('CODINGNS4DSH_DEBUG_LEVEL=warn 只输出警告，不输出普通调试信息', () => {
  const previousDebug = process.env[CODINGNS4DSH_DEBUG_ENV]
  const previousLevel = process.env[CODINGNS4DSH_DEBUG_LEVEL_ENV]
  delete process.env[CODINGNS4DSH_DEBUG_ENV]
  process.env[CODINGNS4DSH_DEBUG_LEVEL_ENV] = 'warn'
  try {
    assert.equal(resolveCodingNsDebugEnabled(), true)
    assert.equal(resolveCodingNsDebugLevel(), 'warn')
    const infoRecords: unknown[][] = []
    const warnRecords: unknown[][] = []
    const info = console.info
    const warn = console.warn
    console.info = (...args: unknown[]) => infoRecords.push(args)
    console.warn = (...args: unknown[]) => warnRecords.push(args)
    try {
      debugInfo('hidden')
      debugWarn('visible')
    } finally {
      console.info = info
      console.warn = warn
    }
    assert.deepEqual(infoRecords, [])
    assert.deepEqual(warnRecords, [['visible']])
  } finally {
    if (previousDebug === undefined) delete process.env[CODINGNS4DSH_DEBUG_ENV]
    else process.env[CODINGNS4DSH_DEBUG_ENV] = previousDebug
    if (previousLevel === undefined) delete process.env[CODINGNS4DSH_DEBUG_LEVEL_ENV]
    else process.env[CODINGNS4DSH_DEBUG_LEVEL_ENV] = previousLevel
  }
})

test('CODINGNS4DSH_DEBUG=warn 可作为警告模式简写', () => {
  const previous = process.env[CODINGNS4DSH_DEBUG_ENV]
  process.env[CODINGNS4DSH_DEBUG_ENV] = 'warn'
  try {
    assert.equal(resolveCodingNsDebugLevel(), 'warn')
    assert.equal(resolveCodingNsDebugEnabled(), true)
  } finally {
    if (previous === undefined) delete process.env[CODINGNS4DSH_DEBUG_ENV]
    else process.env[CODINGNS4DSH_DEBUG_ENV] = previous
  }
})
