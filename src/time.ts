// Short English relative times. Orca's RelativeTime follows the app language, so the panel
// formats its own to stay in English. A no-break space keeps "16 h" on one line.
const NBSP = '\u00a0'

/** "5 s", "3 min", "16 h", "2 d": for the narrow column on the right of a row. */
export function short(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000))
  if (s < 60) return `${s}${NBSP}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}${NBSP}min`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}${NBSP}h`
  return `${Math.floor(h / 24)}${NBSP}d`
}

/** "5 s ago", "3 min ago". */
export function ago(at: number, now: number): string {
  return `${short(at, now)} ago`
}
