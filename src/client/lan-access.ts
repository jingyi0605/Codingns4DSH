/**
 * 局域网访问兼容模块。
 *
 * 非 HTTPS 页面通常仍然暴露 `crypto.getRandomValues`，但部分浏览器不会
 * 暴露只在安全上下文提供的 `crypto.randomUUID`。DSH 页面依赖后者生成会话
 * 标识，因此在 Client 入口加载时补齐一个 RFC 4122 v4 实现。
 */

export interface LanAccessCrypto {
  randomUUID?: () => string
  getRandomValues?: (array: Uint8Array) => Uint8Array
}

export interface LanAccessGlobal {
  crypto?: LanAccessCrypto
}

export interface CryptoRandomUUIDInstallResult {
  /** 安装调用结束后，目标是否拥有可调用的 randomUUID。 */
  readonly available: boolean
  /** 本次调用是否新增了 randomUUID 实现。 */
  readonly installed: boolean
}

/**
 * 确保目标页面拥有 `crypto.randomUUID`。
 *
 * 该函数幂等且可注入目标对象，便于在浏览器和测试环境中复用。无法修改
 * 浏览器原生 crypto 时返回 available=false，不会阻止 DSH 继续启动。
 */
export function ensureCryptoRandomUUID(
  target: LanAccessGlobal = globalThis,
): CryptoRandomUUIDInstallResult {
  const cryptoObject = target.crypto
  if (cryptoObject === undefined) return { available: false, installed: false }
  if (typeof cryptoObject.randomUUID === 'function') return { available: true, installed: false }

  const getRandomValues = typeof cryptoObject.getRandomValues === 'function'
    ? cryptoObject.getRandomValues.bind(cryptoObject)
    : undefined
  const randomUUID = () => createUuidV4(getRandomValues)

  try {
    Object.defineProperty(cryptoObject, 'randomUUID', {
      configurable: true,
      enumerable: false,
      value: randomUUID,
      writable: true,
    })
  } catch {
    try {
      cryptoObject.randomUUID = randomUUID
    } catch {
      return { available: false, installed: false }
    }
  }

  return typeof cryptoObject.randomUUID === 'function'
    ? { available: true, installed: true }
    : { available: false, installed: false }
}

function createUuidV4(getRandomValues: ((array: Uint8Array) => Uint8Array) | undefined): string {
  const bytes = new Uint8Array(16)
  if (getRandomValues !== undefined) {
    try {
      getRandomValues(bytes)
    } catch {
      fillWithMathRandom(bytes)
    }
  } else {
    fillWithMathRandom(bytes)
  }

  // RFC 4122: version 4 and the variant used by the standard UUID string form.
  bytes[6] = (bytes[6]! & 0x0f) | 0x40
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function fillWithMathRandom(bytes: Uint8Array): void {
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Math.floor(Math.random() * 256)
  }
}

