/** Shared appearance for chat actions and hover-only native interaction markers. */
export const TRANSLATION_GLYPH_SIZE = 16
export const TRANSLATION_GLYPH_PATHS = [
  'M3.5 5.5h10M8.5 3.5v2M12.5 5.5c0 4.4-3.3 7.2-8 9',
  'M5.5 8.5c1.4 2 3.4 3.7 6 4.8M14.5 19.5l3-8 3 8M15.7 17h3.6',
] as const

export const TRANSLATION_STATUS_BADGE_STYLE = {
  position: 'absolute',
  top: '1px',
  right: '1px',
  display: 'grid',
  placeItems: 'center',
  width: '10px',
  height: '10px',
  zIndex: '1',
  boxSizing: 'border-box',
  border: '1.5px solid var(--dsw-alias-bg-base, Canvas)',
  borderRadius: '50%',
  color: '#fff',
  fontSize: '6px',
  fontWeight: '700',
  lineHeight: '1',
} as const

export const TRANSLATION_PENDING_BADGE_STYLE = {
  border: '1.5px solid var(--dsw-alias-button-info-fill, #1677ff)',
  borderTopColor: 'transparent',
  background: 'transparent',
} as const
