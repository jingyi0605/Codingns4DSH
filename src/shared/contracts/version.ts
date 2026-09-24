/** DSH 与 CodingNS 插件共同遵循的发布版本。 */
export const DSH_VERSION = '0.1.6-alpha.2' as const

/** 插件版本跟随 DSH 版本，避免 Bundle 与宿主版本错配。 */
export const CODINGNS_VERSION = DSH_VERSION
