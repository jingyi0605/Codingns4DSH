import { lstat, mkdir, readdir, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { DshSessionHeaderLike, DshSessionPersistenceLike } from '../../dsh-capabilities/host/session-deletion-adapter.js'
import { SessionDeletionError } from '../../shared/contracts/session-deletion.js'

export interface VerifiedTargetLocation {
  readonly sessionId: string
  readonly header: DshSessionHeaderLike
  readonly revision: string
  readonly realRoot: string
  readonly rootDev: number | bigint
  readonly rootIno: number | bigint
  readonly projectDir: string
  readonly sessionDir: string
  readonly locationPath: string
  readonly stagingRoot: string
  readonly generationFiles: readonly string[]
}

export function encodeJsonlSegment(raw: string): string {
  if (raw.length === 0) throw new SessionDeletionError('SESSION_DELETION_INVALID_SESSION_ID', 'Session ID cannot be empty')
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch !== '~' && /^[A-Za-z0-9._-]$/u.test(ch)) {
      out += ch
    } else {
      out += `~${code.toString(16).toUpperCase().padStart(4, '0')}`
    }
  }
  return out
}

export function deriveJsonlProjectKey(cwd: string): string {
  if (cwd.length === 0) throw new SessionDeletionError('SESSION_DELETION_PATH_UNSAFE', 'Session cwd cannot be empty')
  let readable = ''
  let separatorRun = false
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/u.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += `~${code.toString(16).toUpperCase().padStart(4, '0')}`
      separatorRun = false
    }
  }
  const slug = readable.replace(/^-+/, '') || 'root'
  return `--${slug.slice(0, 251)}--`
}

export function deriveExpectedProjectSegment(cwd: string | undefined): string {
  return cwd === undefined ? '_no-cwd' : deriveJsonlProjectKey(cwd)
}

export async function locateAndVerifyTarget(input: {
  readonly persistence: DshSessionPersistenceLike
  readonly root: string
  readonly sessionId: string
  readonly stateDir?: string
  readonly signal?: AbortSignal
}): Promise<VerifiedTargetLocation> {
  const { persistence, root, sessionId, stateDir, signal } = input
  signal?.throwIfAborted()
  if (!isAbsolute(root)) {
    throw new SessionDeletionError('SESSION_DELETION_PATH_UNSAFE', 'Persistence root must be an absolute path')
  }
  const snapshot = await persistence.stat(sessionId, signal === undefined ? undefined : { signal })
  if (snapshot === undefined) {
    throw new SessionDeletionError('SESSION_DELETION_NOT_FOUND', `Session "${sessionId}" was not found`)
  }
  if (persistence.hasPendingSession?.(sessionId) === true || snapshot.location === undefined) {
    throw new SessionDeletionError(
      'SESSION_DELETION_UNMATERIALIZED',
      `Session "${sessionId}" has not been materialized to durable local storage`,
    )
  }
  if (snapshot.location.kind !== 'jsonl' || typeof snapshot.location.path !== 'string' || !isAbsolute(snapshot.location.path)) {
    throw new SessionDeletionError(
      'SESSION_DELETION_UNSUPPORTED_BACKEND',
      `Session "${sessionId}" is not backed by the local JSONL backend`,
    )
  }
  if (snapshot.header.id !== sessionId) {
    throw new SessionDeletionError(
      'SESSION_DELETION_PATH_UNSAFE',
      `Stored header ID "${snapshot.header.id}" does not match requested session "${sessionId}"`,
    )
  }

  const rootStat = await lstatStrict(root, 'Persistence root')
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new SessionDeletionError('SESSION_DELETION_PATH_UNSAFE', 'Persistence root must be a real directory')
  }
  const realRoot = await realpath(root)

  const projectSeg = deriveExpectedProjectSegment(snapshot.header.cwd)
  const sessionSeg = encodeJsonlSegment(sessionId)
  const expectedProjectDir = join(realRoot, projectSeg)
  const expectedSessionDir = join(expectedProjectDir, sessionSeg)

  const projectStat = await lstatStrict(expectedProjectDir, 'Project directory')
  if (projectStat.isSymbolicLink() || !projectStat.isDirectory()) {
    throw new SessionDeletionError('SESSION_DELETION_PATH_UNSAFE', 'Project directory is unsafe or is a symlink')
  }
  const realProjectDir = await realpath(expectedProjectDir)
  if (realProjectDir !== expectedProjectDir || !isStrictDescendant(realRoot, realProjectDir)) {
    throw new SessionDeletionError('SESSION_DELETION_PATH_UNSAFE', 'Project directory escaped persistence root')
  }

  const sessionStat = await lstatStrict(expectedSessionDir, 'Session directory')
  if (sessionStat.isSymbolicLink() || !sessionStat.isDirectory()) {
    throw new SessionDeletionError('SESSION_DELETION_PATH_UNSAFE', 'Session directory is unsafe or is a symlink')
  }
  const realSessionDir = await realpath(expectedSessionDir)
  if (realSessionDir !== expectedSessionDir || dirname(realSessionDir) !== realProjectDir) {
    throw new SessionDeletionError('SESSION_DELETION_PATH_UNSAFE', 'Session directory resolved outside its project directory')
  }

  // Verify the reported artifact location actually resides directly inside expectedSessionDir.
  const locationPath = snapshot.location.path
  const reportedDir = dirname(locationPath)
  const reportedDirStat = await lstatStrict(reportedDir, 'Artifact directory')
  if (reportedDirStat.isSymbolicLink() || !reportedDirStat.isDirectory()) {
    throw new SessionDeletionError('SESSION_DELETION_PATH_UNSAFE', 'Reported artifact directory is a symlink or not a directory')
  }
  if (await realpath(reportedDir) !== realSessionDir) {
    throw new SessionDeletionError('SESSION_DELETION_PATH_UNSAFE', 'Reported artifact location does not match verified session directory')
  }
  const locationStat = await lstatStrict(locationPath, 'Session log file')
  if (locationStat.isSymbolicLink() || !locationStat.isFile()) {
    throw new SessionDeletionError('SESSION_DELETION_PATH_UNSAFE', 'Session log artifact must be a regular non-symlink file')
  }
  if (await realpath(locationPath) !== join(realSessionDir, basename(locationPath))) {
    throw new SessionDeletionError('SESSION_DELETION_PATH_UNSAFE', 'Session log file alias mismatch')
  }

  // Scan persistence root for duplicate session directories across project directories.
  await assertNoDuplicateSessionDirectories(realRoot, realProjectDir, sessionSeg)

  // Verify every entry inside the session directory is safe (no symlinks/junctions or nested directory escapes).
  const generationFiles = await inspectSessionDirectoryEntries(realSessionDir)

  // Resolve and verify a private, same-filesystem staging root outside the DSH search root.
  const stagingRoot = await resolveSameFilesystemStagingRoot({
    realRoot,
    rootDev: rootStat.dev,
    ...(stateDir === undefined ? {} : { stateDir }),
  })

  return {
    sessionId,
    header: snapshot.header,
    revision: snapshot.revision,
    realRoot,
    rootDev: rootStat.dev,
    rootIno: rootStat.ino,
    projectDir: realProjectDir,
    sessionDir: realSessionDir,
    locationPath: join(realSessionDir, basename(locationPath)),
    stagingRoot,
    generationFiles,
  }
}

async function assertNoDuplicateSessionDirectories(
  realRoot: string,
  expectedProjectDir: string,
  sessionSeg: string,
): Promise<void> {
  const entries = await readdir(realRoot, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const projectCandidate = join(realRoot, entry.name)
    const projectStat = await lstatStrict(projectCandidate, 'Project candidate')
    if (projectStat.isSymbolicLink()) {
      throw new SessionDeletionError('SESSION_DELETION_PATH_UNSAFE', `Project entry "${entry.name}" is a symlink`)
    }
    if (!projectStat.isDirectory()) continue
    if (projectCandidate === expectedProjectDir) continue
    const duplicateCandidate = join(projectCandidate, sessionSeg)
    let dupStat
    try {
      dupStat = await lstat(duplicateCandidate)
    } catch (error) {
      if (isEnoent(error)) continue
      throw error
    }
    if (dupStat.isSymbolicLink()) {
      throw new SessionDeletionError('SESSION_DELETION_PATH_UNSAFE', 'Duplicate session directory entry is a symlink')
    }
    throw new SessionDeletionError(
      'SESSION_DELETION_DUPLICATE_LOCATION',
      `Duplicate session directory found at "${entry.name}/${sessionSeg}"`,
    )
  }
}

async function inspectSessionDirectoryEntries(sessionDir: string): Promise<string[]> {
  const entries = await readdir(sessionDir, { withFileTypes: true })
  const generationFiles: string[] = []
  for (const entry of entries) {
    const fullPath = join(sessionDir, entry.name)
    const stat = await lstatStrict(fullPath, `Session entry "${entry.name}"`)
    if (stat.isSymbolicLink()) {
      throw new SessionDeletionError('SESSION_DELETION_PATH_UNSAFE', `Session entry "${entry.name}" cannot be a symlink`)
    }
    if (stat.isDirectory()) {
      throw new SessionDeletionError('SESSION_DELETION_PATH_UNSAFE', `Session directory contains unexpected subdirectory "${entry.name}"`)
    }
    if (!stat.isFile()) {
      throw new SessionDeletionError('SESSION_DELETION_PATH_UNSAFE', `Session entry "${entry.name}" is not a regular file`)
    }
    if (isGenerationLogFilename(entry.name)) {
      generationFiles.push(entry.name)
    }
  }
  return generationFiles.sort()
}

export async function resolveSameFilesystemStagingRoot(input: {
  readonly realRoot: string
  readonly rootDev: number | bigint
  readonly stateDir?: string
}): Promise<string> {
  const candidates: string[] = []
  if (input.stateDir !== undefined && input.stateDir.trim() !== '') {
    candidates.push(join(resolve(input.stateDir), 'session-deletion-staging'))
  }
  const rootParent = dirname(input.realRoot)
  if (rootParent !== input.realRoot) {
    candidates.push(join(rootParent, '.codingns-session-deletion-staging'))
  }

  for (const candidate of candidates) {
    if (isPathOverlapping(input.realRoot, candidate)) continue
    try {
      const ancestor = await findNearestExistingAncestor(dirname(candidate))
      if (ancestor === undefined) continue
      const ancStat = await lstat(ancestor)
      if (ancStat.isSymbolicLink() || ancStat.dev !== input.rootDev) continue
      await mkdir(candidate, { recursive: true, mode: 0o700 })
      const stagingStat = await lstat(candidate)
      if (stagingStat.isSymbolicLink() || !stagingStat.isDirectory() || stagingStat.dev !== input.rootDev) continue
      const realStaging = await realpath(candidate)
      if (isPathOverlapping(input.realRoot, realStaging)) continue
      return realStaging
    } catch {
      // Try next candidate; if none pass, fail closed below.
    }
  }

  throw new SessionDeletionError(
    'SESSION_DELETION_STAGING_UNAVAILABLE',
    'Unable to prepare a private same-filesystem staging directory outside the DSH search root',
  )
}

async function findNearestExistingAncestor(dir: string): Promise<string | undefined> {
  let current = resolve(dir)
  for (;;) {
    try {
      await lstat(current)
      return current
    } catch (error) {
      if (!isEnoent(error)) throw error
      const parent = dirname(current)
      if (parent === current) return undefined
      current = parent
    }
  }
}

export function isGenerationLogFilename(filename: string): boolean {
  return /^session(?:\.v(?:[1-9]\d*))?\.jsonl(?:\.zstd)?$/u.test(filename)
}

export function isStrictDescendant(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

export function isPathOverlapping(root: string, candidate: string): boolean {
  const normalizedRoot = resolve(root)
  const normalizedCandidate = resolve(candidate)
  if (normalizedRoot === normalizedCandidate) return true
  const rootPrefix = normalizedRoot.endsWith(sep) ? normalizedRoot : `${normalizedRoot}${sep}`
  const candPrefix = normalizedCandidate.endsWith(sep) ? normalizedCandidate : `${normalizedCandidate}${sep}`
  return normalizedCandidate.startsWith(rootPrefix) || normalizedRoot.startsWith(candPrefix)
}

async function lstatStrict(targetPath: string, label: string) {
  try {
    return await lstat(targetPath)
  } catch (error) {
    if (isEnoent(error)) {
      throw new SessionDeletionError('SESSION_DELETION_PATH_UNSAFE', `${label} does not exist: ${targetPath}`)
    }
    throw error
  }
}

export function isEnoent(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === 'ENOENT'
}
