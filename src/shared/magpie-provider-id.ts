/**
 * Magpie's own spelling of a provider ID (`provider.Slug`): lower-case letters and digits, every
 * run of anything else folded into one dash, and no dash at either end.
 *
 * Magpie accepts a provider only under an ID it spells this way, so a rename has to be written in
 * this form; the Host refuses anything else and the editor shows what would be stored. One rule,
 * both sides.
 */
export function magpieProviderId(value: string): string {
  return value.toLocaleLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '')
}

/** Whether `value` is already spelled the one way Magpie writes a provider ID. */
export function isMagpieProviderId(value: string): boolean {
  return value !== '' && value === magpieProviderId(value)
}
