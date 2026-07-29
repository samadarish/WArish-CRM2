// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MotionPresence } from '../src/renderer/src/motion'
import { MOTION_PREFERENCE_EVENT } from '../src/renderer/src/motion-preference'
import { runSurfaceTransition } from '../src/renderer/src/surface-transition'
import { useDebouncedValue } from '../src/renderer/src/use-debounced-value'

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => window.setTimeout(() => callback(0), 1))
  vi.stubGlobal('cancelAnimationFrame', (id: number) => window.clearTimeout(id))
})

afterEach(() => {
  delete document.documentElement.dataset.motion
  delete document.documentElement.dataset.surfaceTransition
  Reflect.deleteProperty(document, 'startViewTransition')
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('MotionPresence', () => {
  it('retains inert content for the exit transition and then removes it', () => {
    const view = render(<MotionPresence show><button>Customer details</button></MotionPresence>)
    act(() => { vi.advanceTimersByTime(1) })
    expect(screen.getByText('Customer details').parentElement).toHaveAttribute('data-motion-state', 'entered')

    view.rerender(<MotionPresence show={false}>{null}</MotionPresence>)
    const presence = screen.getByText('Customer details').parentElement
    expect(presence).toHaveAttribute('data-motion-state', 'exiting')
    expect(presence).toHaveAttribute('inert')
    act(() => { vi.advanceTimersByTime(219) })
    expect(screen.getByText('Customer details')).toBeInTheDocument()
    act(() => { vi.advanceTimersByTime(1) })
    expect(screen.queryByText('Customer details')).not.toBeInTheDocument()
  })

  it('retains an entering surface when it is dismissed before the next frame', () => {
    const view = render(<MotionPresence show={false}><button>Quick panel</button></MotionPresence>)
    view.rerender(<MotionPresence show><button>Quick panel</button></MotionPresence>)
    expect(screen.getByText('Quick panel').parentElement).toHaveAttribute('data-motion-state', 'entering')

    view.rerender(<MotionPresence show={false}>{null}</MotionPresence>)
    expect(screen.getByText('Quick panel').parentElement).toHaveAttribute('data-motion-state', 'exiting')
    act(() => { vi.advanceTimersByTime(220) })
    expect(screen.queryByText('Quick panel')).not.toBeInTheDocument()
  })

  it('removes content immediately when interface motion is disabled', () => {
    document.documentElement.dataset.motion = 'reduced'
    const view = render(<MotionPresence show><button>Search messages</button></MotionPresence>)
    view.rerender(<MotionPresence show={false}>{null}</MotionPresence>)
    expect(screen.queryByText('Search messages')).not.toBeInTheDocument()
  })

  it('finishes an active exit when motion is disabled while it is running', () => {
    const view = render(<MotionPresence show><button>Customer panel</button></MotionPresence>)
    act(() => { vi.advanceTimersByTime(1) })
    view.rerender(<MotionPresence show={false}>{null}</MotionPresence>)
    expect(screen.getByText('Customer panel')).toBeInTheDocument()
    document.documentElement.dataset.motion = 'reduced'
    act(() => { window.dispatchEvent(new Event(MOTION_PREFERENCE_EVENT)) })
    expect(screen.queryByText('Customer panel')).not.toBeInTheDocument()
  })
})

describe('runSurfaceTransition', () => {
  it('updates immediately when View Transitions are unavailable', () => {
    let value = 'before'
    runSurfaceTransition('workspace', () => { value = 'after' })
    expect(value).toBe('after')
  })

  it('scopes the named surface while active and clears it after completion', async () => {
    let finishTransition: (() => void) | undefined
    const finished = new Promise<void>((resolve) => { finishTransition = resolve })
    Object.defineProperty(document, 'startViewTransition', { configurable: true, value: vi.fn((update: () => void) => {
      update()
      return { skipTransition: vi.fn(), finished,
        ready: Promise.resolve(), updateCallbackDone: Promise.resolve(), types: new Set<string>() }
    }) })

    runSurfaceTransition('settings', () => undefined)
    expect(document.documentElement).toHaveAttribute('data-surface-transition', 'settings')
    finishTransition?.()
    await finished
    await Promise.resolve()
    expect(document.documentElement).not.toHaveAttribute('data-surface-transition')
  })

  it('skips an in-progress transition before starting the latest update', () => {
    const transitions: Array<{ skipTransition: ReturnType<typeof vi.fn>; finished: Promise<void> }> = []
    Object.defineProperty(document, 'startViewTransition', { configurable: true, value: vi.fn((update: () => void) => {
      update()
      const transition = { skipTransition: vi.fn(), finished: Promise.resolve(),
        ready: Promise.resolve(), updateCallbackDone: Promise.resolve(), types: new Set<string>() }
      transitions.push(transition)
      return transition
    }) })
    let value = 0
    runSurfaceTransition('chat', () => { value = 1 })
    runSurfaceTransition('chat', () => { value = 2 })
    expect(value).toBe(2)
    expect(transitions).toHaveLength(1)
    expect(transitions[0]?.skipTransition).toHaveBeenCalledOnce()
    expect(document.documentElement).not.toHaveAttribute('data-surface-transition')
  })

  it('ignores a stale pending callback after an interrupted update commits', () => {
    let pendingUpdate: (() => void) | undefined
    const transition = { skipTransition: vi.fn(), finished: Promise.resolve(),
      ready: Promise.resolve(), updateCallbackDone: Promise.resolve(), types: new Set<string>() }
    Object.defineProperty(document, 'startViewTransition', { configurable: true, value: vi.fn((update: () => void) => {
      pendingUpdate = update
      return transition
    }) })
    let value = 0
    runSurfaceTransition('chat', () => { value = 1 })
    runSurfaceTransition('chat', () => { value = 2 })
    expect(value).toBe(2)
    pendingUpdate?.()
    expect(value).toBe(2)
    expect(transition.skipTransition).toHaveBeenCalledOnce()
  })

  it('does not start a View Transition for reduced motion', () => {
    document.documentElement.dataset.motion = 'reduced'
    const start = vi.fn()
    Object.defineProperty(document, 'startViewTransition', { configurable: true, value: start })
    let updated = false
    runSurfaceTransition('workspace', () => { updated = true })
    expect(updated).toBe(true)
    expect(start).not.toHaveBeenCalled()
  })

  it('preserves pending updates from a different surface when interrupted', () => {
    let pendingUpdate: (() => void) | undefined
    const transition = { skipTransition: vi.fn(), finished: Promise.resolve(),
      ready: Promise.resolve(), updateCallbackDone: Promise.resolve(), types: new Set<string>() }
    Object.defineProperty(document, 'startViewTransition', { configurable: true, value: vi.fn((update: () => void) => {
      pendingUpdate = update
      return transition
    }) })
    const updates: string[] = []
    runSurfaceTransition('chat', () => { updates.push('chat') })
    runSurfaceTransition('session', () => { updates.push('session') })
    expect(updates).toEqual(['chat', 'session'])
    pendingUpdate?.()
    expect(updates).toEqual(['chat', 'session'])
  })

  it('falls back to an immediate update when View Transition startup throws', () => {
    Object.defineProperty(document, 'startViewTransition', { configurable: true, value: vi.fn(() => {
      throw new Error('Document is not ready')
    }) })
    let updated = false
    expect(() => runSurfaceTransition('workspace', () => { updated = true })).not.toThrow()
    expect(updated).toBe(true)
    expect(document.documentElement).not.toHaveAttribute('data-surface-transition')
  })

  it('commits and skips a pending transition when motion is disabled', async () => {
    let pendingUpdate: (() => void) | undefined
    let finishTransition: (() => void) | undefined
    const finished = new Promise<void>((resolve) => { finishTransition = resolve })
    const transition = { skipTransition: vi.fn(), finished,
      ready: Promise.resolve(), updateCallbackDone: Promise.resolve(), types: new Set<string>() }
    Object.defineProperty(document, 'startViewTransition', { configurable: true, value: vi.fn((update: () => void) => {
      pendingUpdate = update
      return transition
    }) })
    let updates = 0
    runSurfaceTransition('workspace', () => { updates += 1 })
    document.documentElement.dataset.motion = 'reduced'
    window.dispatchEvent(new Event(MOTION_PREFERENCE_EVENT))
    expect(updates).toBe(1)
    expect(transition.skipTransition).toHaveBeenCalledOnce()
    pendingUpdate?.()
    expect(updates).toBe(1)
    finishTransition?.()
    await finished
  })

  it('cancels an active transition when the system preference changes', async () => {
    let reduced = false
    let notifyChange: (() => void) | undefined
    const media = {
      get matches() { return reduced }, media: '(prefers-reduced-motion: reduce)', onchange: null,
      addEventListener: (_type: string, listener: () => void) => { notifyChange = listener },
      removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn()
    }
    vi.stubGlobal('matchMedia', vi.fn(() => media))
    let pendingUpdate: (() => void) | undefined
    let finishTransition: (() => void) | undefined
    const finished = new Promise<void>((resolve) => { finishTransition = resolve })
    const transition = { skipTransition: vi.fn(), finished,
      ready: Promise.resolve(), updateCallbackDone: Promise.resolve(), types: new Set<string>() }
    Object.defineProperty(document, 'startViewTransition', { configurable: true, value: vi.fn((update: () => void) => {
      pendingUpdate = update
      return transition
    }) })
    let updates = 0
    runSurfaceTransition('crm', () => { updates += 1 })
    reduced = true
    notifyChange?.()
    expect(updates).toBe(1)
    expect(transition.skipTransition).toHaveBeenCalledOnce()
    pendingUpdate?.()
    expect(updates).toBe(1)
    finishTransition?.()
    await finished
  })
})

function DebouncedValue({ value }: { value: string }): React.JSX.Element {
  return <output>{useDebouncedValue(value, 200)}</output>
}

describe('useDebouncedValue', () => {
  it('publishes only the settled value after the configured delay', () => {
    const view = render(<DebouncedValue value="p" />)
    view.rerender(<DebouncedValue value="pr" />)
    view.rerender(<DebouncedValue value="priya" />)
    act(() => { vi.advanceTimersByTime(199) })
    expect(screen.getByText('p')).toBeInTheDocument()
    act(() => { vi.advanceTimersByTime(1) })
    expect(screen.getByText('priya')).toBeInTheDocument()
  })
})
