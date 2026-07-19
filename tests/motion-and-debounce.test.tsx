// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MotionPresence } from '../src/renderer/src/motion'
import { useDebouncedValue } from '../src/renderer/src/use-debounced-value'

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => window.setTimeout(() => callback(0), 1))
  vi.stubGlobal('cancelAnimationFrame', (id: number) => window.clearTimeout(id))
})

afterEach(() => {
  delete document.documentElement.dataset.motion
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

  it('removes content immediately when interface motion is disabled', () => {
    document.documentElement.dataset.motion = 'reduced'
    const view = render(<MotionPresence show><button>Search messages</button></MotionPresence>)
    view.rerender(<MotionPresence show={false}>{null}</MotionPresence>)
    expect(screen.queryByText('Search messages')).not.toBeInTheDocument()
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
