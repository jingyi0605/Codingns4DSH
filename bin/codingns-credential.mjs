#!/usr/bin/env node

import net from 'node:net'

const args = process.argv.slice(2)
const action = args.shift()
const json = takeFlag(args, '--json')
const code = takeOption(args, '--code')
const handle = takeOption(args, '--handle')
const separator = args.indexOf('--')
const argv = separator < 0 ? [] : args.slice(separator + 1)

if (action !== 'describe' && action !== 'exec') fail('usage: codingns-credential describe|exec --code <code> [--json] [-- command ...]')
if (code === undefined && handle === undefined) fail('a request code or handle is required')
if (action === 'exec' && argv.length === 0) fail('exec requires a command after --')

const endpoint = process.env.CODINGNS_CREDENTIAL_BROKER_ENDPOINT
const token = process.env.CODINGNS_CREDENTIAL_BROKER_TOKEN
if (!endpoint || !token) fail('credential broker environment is unavailable')

const response = await request(endpoint, {
  action,
  token,
  ...(code === undefined ? {} : { code }),
  ...(handle === undefined ? {} : { handle }),
  ...(action === 'exec' ? { argv } : {}),
})

if (response.ok !== true) fail(response.error?.message ?? 'credential broker request failed')
if (action === 'describe') {
  process.stdout.write(`${JSON.stringify(response.value)}\n`)
} else {
  const value = response.value
  if (!isRecord(value)) fail('credential command response is invalid')
  if (json) process.stdout.write(`${JSON.stringify(value)}\n`)
  else {
    if (typeof value.stdout === 'string') process.stdout.write(value.stdout)
    if (typeof value.stderr === 'string' && value.stderr !== '') process.stderr.write(value.stderr)
  }
  process.exitCode = typeof value.exitCode === 'number' ? value.exitCode : 1
}

function takeFlag(values, name) {
  const index = values.indexOf(name)
  if (index < 0) return false
  values.splice(index, 1)
  return true
}

function takeOption(values, name) {
  const index = values.indexOf(name)
  if (index < 0) return undefined
  const value = values[index + 1]
  values.splice(index, 2)
  return value
}

function request(value, payload) {
  return new Promise((resolve, reject) => {
    const socket = value.startsWith('unix:')
      ? net.createConnection(value.slice('unix:'.length))
      : net.createConnection({
          host: value.slice('tcp://'.length).split(':')[0],
          port: Number(value.slice('tcp://'.length).split(':').at(-1)),
        })
    let buffer = ''
    socket.setEncoding('utf8')
    socket.once('error', reject)
    socket.on('data', (chunk) => {
      buffer += chunk
      const newline = buffer.indexOf('\n')
      if (newline < 0) return
      try {
        resolve(JSON.parse(buffer.slice(0, newline)))
      } catch {
        reject(new Error('credential broker response is invalid'))
      } finally {
        socket.destroy()
      }
    })
    socket.once('connect', () => socket.end(`${JSON.stringify(payload)}\n`))
  })
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function fail(message) {
  console.error(`codingns-credential: ${message}`)
  process.exit(2)
}
