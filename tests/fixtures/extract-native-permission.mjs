import { open, mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

// Export only the public UI component and locale from a locally installed DSH.
// No profiles, session stores, account files or credentials are read.
const [archive, destination] = process.argv.slice(2)
if (!archive || !destination) throw new Error('Usage: node tests/fixtures/extract-native-permission.mjs <app.asar> <output.js>')
const file = await open(archive, 'r')
try {
  const header = Buffer.alloc(16)
  await file.read(header, 0, 16, 0)
  const bytes = Buffer.alloc(header.readUInt32LE(12))
  await file.read(bytes, 0, bytes.length, 16)
  const tree = JSON.parse(bytes.toString('utf8'))
  const path = 'dsh/node_modules/@deepseek-ai/dsh-client-ui-permission-presets/lib/client.js'
  let entry = tree
  for (const part of path.split('/')) entry = entry?.files?.[part]
  if (!entry || entry.unpacked || entry.link) throw new Error('This DSH archive does not contain the expected permission UI bundle')
  const sourceBytes = Buffer.alloc(entry.size)
  await file.read(sourceBytes, 0, sourceBytes.length, 8 + header.readUInt32LE(4) + Number(entry.offset))
  const source = sourceBytes.toString('utf8')
  if (!source.includes('function PermissionSelect(') || !source.includes('exports.apply=apply;')) throw new Error('Permission UI exports changed; update the fixture for this DSH version')
  const output = resolve(destination)
  await mkdir(dirname(output), { recursive: true })
  await writeFile(output, source.replace('exports.apply=apply;', 'exports.PermissionSelect=PermissionSelect;exports.accessZh=accessZh;exports.apply=apply;'), { flag: 'wx' })
} finally { await file.close() }
