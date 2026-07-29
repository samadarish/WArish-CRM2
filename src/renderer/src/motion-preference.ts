export const MOTION_MS = { fast: 100, medium: 160, slow: 220 } as const
export const MOTION_DISTANCE = { short: 3, medium: 6, long: 10 } as const
export const MOTION_PREFERENCE_EVENT = 'warish-motion-preference-change'

export function prefersReducedMotion(): boolean {
  if (typeof document !== 'undefined' && document.documentElement.dataset.motion === 'reduced') return true
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

export function motionDuration(duration: number): number {
  return prefersReducedMotion() ? 0 : duration
}

export function notifyMotionPreferenceChanged(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(MOTION_PREFERENCE_EVENT))
}

export function subscribeToReducedMotion(callback: () => void): () => void {
  if (typeof window === 'undefined') return () => undefined
  const handleChange = (): void => { if (prefersReducedMotion()) callback() }
  const media = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-reduced-motion: reduce)') : undefined
  media?.addEventListener('change', handleChange)
  window.addEventListener(MOTION_PREFERENCE_EVENT, handleChange)
  return () => {
    media?.removeEventListener('change', handleChange)
    window.removeEventListener(MOTION_PREFERENCE_EVENT, handleChange)
  }
}
