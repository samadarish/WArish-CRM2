import { flushSync } from 'react-dom'
import { MOTION_PREFERENCE_EVENT, prefersReducedMotion } from './motion-preference'

export type SurfaceTransitionKey = 'session' | 'workspace' | 'chat' | 'crm' | 'settings'

interface ActiveSurfaceTransition {
  key: SurfaceTransitionKey
  update?: () => void
  committed: boolean
  skipped: boolean
  transition?: ViewTransition
}

let activeSurfaceTransition: ActiveSurfaceTransition | undefined
let motionPreferenceListenerInstalled = false
let motionMedia: MediaQueryList | undefined

function commit(record: ActiveSurfaceTransition): void {
  if (record.committed) return
  record.committed = true
  const update = record.update
  record.update = undefined
  if (update) flushSync(update)
}

function skip(record: ActiveSurfaceTransition): void {
  if (record.skipped) return
  record.skipped = true
  clearSurfaceTransitionKey(record)
  try { record.transition?.skipTransition() }
  catch { /* The transition may finish before its completion promise settles. */ }
}

function clearSurfaceTransitionKey(record: ActiveSurfaceTransition): void {
  if (typeof document === 'undefined') return
  if (document.documentElement.dataset.surfaceTransition === record.key) {
    delete document.documentElement.dataset.surfaceTransition
  }
}

const finishForReducedMotion = (): void => {
  if (!prefersReducedMotion() || !activeSurfaceTransition) return
  skip(activeSurfaceTransition)
  commit(activeSurfaceTransition)
}

function ensureMotionPreferenceListeners(): void {
  if (typeof window === 'undefined') return
  if (!motionPreferenceListenerInstalled) {
    window.addEventListener(MOTION_PREFERENCE_EVENT, finishForReducedMotion)
    motionPreferenceListenerInstalled = true
  }
  if (typeof window.matchMedia !== 'function') return
  const nextMedia = window.matchMedia('(prefers-reduced-motion: reduce)')
  if (nextMedia === motionMedia) return
  motionMedia?.removeEventListener('change', finishForReducedMotion)
  motionMedia = nextMedia
  motionMedia.addEventListener('change', finishForReducedMotion)
}

export function runSurfaceTransition(key: SurfaceTransitionKey, update: () => void): void {
  ensureMotionPreferenceListeners()
  const active = activeSurfaceTransition
  if (active) {
    skip(active)
    const pendingUpdate = !active.committed && active.key !== key ? active.update : undefined
    active.committed = true
    active.update = undefined
    flushSync(() => {
      pendingUpdate?.()
      update()
    })
    return
  }
  if (prefersReducedMotion() || typeof document === 'undefined' || typeof document.startViewTransition !== 'function') {
    update()
    return
  }

  const record: ActiveSurfaceTransition = { key, update, committed: false, skipped: false }
  activeSurfaceTransition = record
  document.documentElement.dataset.surfaceTransition = key
  try {
    const transition = document.startViewTransition(() => commit(record))
    record.transition = transition
    if (record.skipped) {
      try { transition.skipTransition() }
      catch { /* A synchronous update may finish before the transition object is returned. */ }
    }
    void transition.finished.finally(() => {
      clearSurfaceTransitionKey(record)
      if (activeSurfaceTransition === record) activeSurfaceTransition = undefined
    }).catch(() => { /* Skipped transitions reject in some Chromium versions. */ })
  } catch {
    clearSurfaceTransitionKey(record)
    if (activeSurfaceTransition === record) activeSurfaceTransition = undefined
    commit(record)
  }
}
