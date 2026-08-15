import { useEffect, useRef, useState, type ReactNode } from 'react'
import { MotionPhaseContext, type MotionPhase } from './motion-context'
import { MOTION_MS, motionDuration, prefersReducedMotion, subscribeToReducedMotion } from './motion-preference'

type PresenceState = {
  show: boolean
  content: ReactNode
  phase: MotionPhase
}

export function MotionPresence({ show, children, exitMs = MOTION_MS.slow }: {
  show: boolean
  children: ReactNode
  exitMs?: number
}): React.JSX.Element | null {
  const [presence, setPresence] = useState<PresenceState>(() => ({
    show,
    content: show ? children : undefined,
    phase: show && motionDuration(1) > 0 ? 'entering' : 'entered'
  }))
  const frameRef = useRef<number | undefined>(undefined)
  const timerRef = useRef<number | undefined>(undefined)

  if (show !== presence.show || (show && children !== presence.content)) {
    const motionEnabled = motionDuration(1) > 0
    setPresence({
      show,
      content: show ? children : motionEnabled ? presence.content : undefined,
      phase: !motionEnabled ? 'entered' : show ? (presence.show ? presence.phase : 'entering')
        : presence.content === undefined ? 'entered' : 'exiting'
    })
  }

  useEffect(() => {
    if (presence.phase === 'entering') {
      frameRef.current = window.requestAnimationFrame(() => {
        frameRef.current = undefined
        setPresence((current) => current.phase === 'entering' ? { ...current, phase: 'entered' } : current)
      })
    } else if (presence.phase === 'exiting') {
      timerRef.current = window.setTimeout(() => {
        timerRef.current = undefined
        setPresence((current) => current.phase === 'exiting' && !current.show
          ? { ...current, content: undefined, phase: 'entered' } : current)
      }, exitMs)
    }

    return () => {
      if (frameRef.current !== undefined) window.cancelAnimationFrame(frameRef.current)
      if (timerRef.current !== undefined) window.clearTimeout(timerRef.current)
      frameRef.current = undefined
      timerRef.current = undefined
    }
  }, [exitMs, presence.phase])

  useEffect(() => subscribeToReducedMotion(() => {
    if (!prefersReducedMotion()) return
    if (frameRef.current !== undefined) window.cancelAnimationFrame(frameRef.current)
    if (timerRef.current !== undefined) window.clearTimeout(timerRef.current)
    frameRef.current = undefined
    timerRef.current = undefined
    setPresence((current) => current.phase === 'exiting'
      ? { ...current, content: undefined, phase: 'entered' }
      : current.phase === 'entering' ? { ...current, phase: 'entered' } : current)
  }), [])

  if (presence.content === undefined) return null
  return <MotionPhaseContext.Provider value={presence.phase}>
    <div className="motion-presence" data-motion-state={presence.phase}
      aria-hidden={presence.phase === 'exiting' ? true : undefined}
      inert={presence.phase === 'exiting' ? true : undefined}>
      {show ? children : presence.content}
    </div>
  </MotionPhaseContext.Provider>
}
