export interface CodingNsThemeService<T = unknown> {
  getTheme(): T
  subscribe(listener: () => void): () => void
}

export function createThemeService<T>(runtime: CodingNsThemeService<T>): CodingNsThemeService<T> {
  return runtime
}
