import { useEffect, useRef, useState, type ReactNode } from 'react'
import { MotionPhaseContext, type MotionPhase } from './motion-context'
import { motionDuration } from './motion-preference'

function usePresenceValue<T>(value: T | undefined, exitMs = 220): {
  value: T | undefined
  phase: MotionPhase
} {
  const [rendered, setRendered] = useState(value)
  const [phase, setPhase] = useState<MotionPhase>('entered')
  const renderedRef = useRef(rendered)
  const frameRef = useRef<number | undefined>(undefined)
  const timerRef = useRef<number | undefined>(undefined)

  useEffect(() => {
    if (frameRef.current !== undefined) window.cancelAnimationFrame(frameRef.current)
    if (timerRef.current !== undefined) window.clearTimeout(timerRef.current)
    frameRef.current = undefined
    timerRef.current = undefined

    if (value !== undefined) {
      setRendered(value)
      if (motionDuration(1) === 0) {
        setPhase('entered')
        return
      }
      setPhase('entering')
      frameRef.current = window.requestAnimationFrame(() => {
        frameRef.current = undefined
        setPhase('entered')
      })
      return
    }

    if (renderedRef.current === undefined || motionDuration(1) === 0) {
      setRendered(undefined)
      setPhase('entered')
      return
    }

    setPhase('exiting')
    timerRef.current = window.setTimeout(() => {
      timerRef.current = undefined
      setRendered(undefined)
      setPhase('entered')
    }, exitMs)
  }, [exitMs, value])

  useEffect(() => {
    renderedRef.current = rendered
  }, [rendered])

  useEffect(() => () => {
    if (frameRef.current !== undefined) window.cancelAnimationFrame(frameRef.current)
    if (timerRef.current !== undefined) window.clearTimeout(timerRef.current)
  }, [])

  return { value: rendered, phase }
}

export function MotionPresence({ show, children, exitMs = 220 }: {
  show: boolean
  children: ReactNode
  exitMs?: number
}): React.JSX.Element | null {
  const lastChildrenRef = useRef<ReactNode>(children)
  if (show) lastChildrenRef.current = children
  const presence = usePresenceValue(show ? true : undefined, exitMs)
  if (!presence.value) return null

  return <MotionPhaseContext.Provider value={presence.phase}>
    <div className="motion-presence" data-motion-state={presence.phase}
      aria-hidden={presence.phase === 'exiting' ? true : undefined}
      inert={presence.phase === 'exiting' ? true : undefined}>
      {show ? children : lastChildrenRef.current}
    </div>
  </MotionPhaseContext.Provider>
}
