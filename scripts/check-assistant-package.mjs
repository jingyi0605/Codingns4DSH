import assert from 'node:assert/strict'
import { readdir, readFile, realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// Verify that the base package no longer owns the global assistant surface.
// The standalone package is checked separately; this script only checks the donor.
const root = await realpath(resolve(process.argv[2] ?? fileURLToPath(new URL('../', import.meta.url))))
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
assert.equal(manifest.name, '@jingyi0605/codingns4dsh', 'target must be the CodingNS donor package')

const forbiddenInActiveFiles = [
  'globalVoiceAssistant',
  'assistantAvatarRuntime',
  'desktopAssistant',
  'assistantNotificationController',
  'codingnsAssistantNotifications',
  'AssistantChatCatalog',
  'AssistantConversationSnapshot',
  'AssistantIndexAnalysisRun',
  'AssistantLlmAdapter',
  'createAssistantLlmAdapter',
  'assistant-llm-adapter.ts',
  'sherpa-onnx-node',
  'assets/assistant-basics',
  'assets/desktop-assistant',
  'assets/voice/',
  'avatar-packages/',
]

const removedSourcePaths = [
  'src/client/avatar',
  'src/client/features/assistant-',
  'src/client/features/global-voice-assistant.ts',
  'src/client/features/voice-',
  'src/host/avatar',
  'src/host/desktop-assistant',
  'src/host/features/assistant-',
  'src/host/features/global-voice-',
  'src/host/features/voice-',
  'src/shared/assistant-avatar',
  'src/shared/contracts/assistant.ts',
  'src/shared/assistant-attachments.ts',
  'src/shared/assistant-notification',
  'src/shared/assistant-tts.ts',
  'src/shared/assistant-voice-',
  'src/shared/desktop-assistant.ts',
  'src/dsh-capabilities/host/assistant-llm-adapter.ts',
  'src/dsh-capabilities/host/assistant-attachment-adapter.ts',
  'src/shared/voice-',
  'src/typert.notifications-client.ts',
  'tsdown.desktop-assistant.config.ts',
]

const activeFiles = [
  'src/host/features/index.ts',
  'src/client/features/index.ts',
  'src/host/index.ts',
  'src/client/index.ts',
  'src/host/settings.ts',
  'src/host/rpc.ts',
  'src/shared/contracts/config.ts',
  'src/shared/index.ts',
  'src/dsh-capabilities/matrix.ts',
  'src/dsh-capabilities/host/llm-text-adapter.ts',
  'package.json',
]

for (const relativePath of activeFiles) {
  const content = await readFile(join(root, relativePath), 'utf8')
  for (const marker of forbiddenInActiveFiles) {
    if (relativePath === 'src/host/settings.ts' && marker === 'globalVoiceAssistant') continue
    assert.equal(content.includes(marker), false, `${relativePath} still owns ${marker}`)
  }
}

const sourceEntries = await readdir(join(root, 'src'), { recursive: true })
for (const relativePath of removedSourcePaths) {
  assert.equal(
    sourceEntries.some((entry) => `src/${entry}` === relativePath || `src/${entry}`.startsWith(relativePath)),
    false,
    `${relativePath} still exists in the donor`,
  )
}

for (const entry of sourceEntries.filter((path) => /\.(?:ts|tsx|js|jsx)$/u.test(path))) {
  const content = await readFile(join(root, 'src', entry), 'utf8')
  for (const marker of ['createAssistantAttachmentTool', 'AssistantAttachmentUpload', 'admitAssistantAttachments']) {
    assert.equal(content.includes(marker), false, `${entry} still contains retired assistant attachment code: ${marker}`)
  }
}

const files = Array.isArray(manifest.files) ? manifest.files : []
for (const marker of forbiddenInActiveFiles.slice(5)) {
  assert.equal(files.some((entry) => entry.includes(marker)), false, `package files still include ${marker}`)
}

const distRoot = join(root, 'data/build/dist')
const hostFeatureSource = await readFile(join(distRoot, 'host/features/index.js'), 'utf8')
const clientFeatureSource = await readFile(join(distRoot, 'client/features/index.js'), 'utf8')
for (const marker of forbiddenInActiveFiles.slice(0, 5)) {
  assert.equal(hostFeatureSource.includes(marker), false, `built Host feature index still contains ${marker}`)
  assert.equal(clientFeatureSource.includes(marker), false, `built Client feature index still contains ${marker}`)
}

console.log(JSON.stringify({
  package: manifest.name,
  version: manifest.version,
  hostFeatureIndex: 'assistant-free',
  clientFeatureIndex: 'assistant-free',
  assistantOwnership: 'removed',
}, null, 2))
