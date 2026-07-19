import { createContext, useContext } from 'react'

export type MotionPhase = 'entering' | 'entered' | 'exiting'

export const MotionPhaseContext = createContext<MotionPhase>('entered')

export function useMotionPhase(): MotionPhase {
  return useContext(MotionPhaseContext)
}
