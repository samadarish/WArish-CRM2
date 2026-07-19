export function motionDuration(duration: number): number {
  if (typeof document !== 'undefined' && document.documentElement.dataset.motion === 'reduced') return 0
  const reducedBySystem = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  return reducedBySystem ? 0 : duration
}
