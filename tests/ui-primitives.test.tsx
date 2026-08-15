// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ComboBoxField, DropdownMenu, SelectField, Tooltip } from '../src/renderer/src/components/ui-primitives'

beforeEach(() => {
  class ResizeObserverStub {
    observe(): void { /* Layout is not measured in jsdom. */ }
    unobserve(): void { /* Layout is not measured in jsdom. */ }
    disconnect(): void { /* Layout is not measured in jsdom. */ }
  }
  vi.stubGlobal('ResizeObserver', ResizeObserverStub)
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('SelectField', () => {
  it('supports keyboard selection and exposes required state', async () => {
    const onChange = vi.fn()
    render(<SelectField label="Priority" value="normal" required onChange={onChange} options={[
      { value: 'low', label: 'Low' }, { value: 'normal', label: 'Normal' }, { value: 'high', label: 'High' }
    ]} />)
    const trigger = screen.getByRole('button', { name: /Priority/ })
    expect(trigger.closest('.ui-choice-field')).toHaveAttribute('data-required', 'true')
    trigger.focus()
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    const selectedOption = await screen.findByRole('option', { name: 'Normal' })
    expect(selectedOption).toHaveFocus()
    fireEvent.keyDown(selectedOption, { key: 'ArrowDown' })
    const nextOption = screen.getByRole('option', { name: 'High' })
    expect(nextOption).toHaveFocus()
    fireEvent.keyDown(nextOption, { key: 'Enter' })
    expect(onChange).toHaveBeenCalledWith('high')
  })

  it('keeps disabled controls unavailable', () => {
    render(<SelectField label="Status" value="open" disabled onChange={vi.fn()}
      options={[{ value: 'open', label: 'Open' }]} />)
    expect(screen.getByRole('button', { name: /Status/ })).toBeDisabled()
  })

  it('associates descriptions and leaves an unmatched required value invalid', () => {
    const view = render(<form><SelectField label="Cache size" value="" required description="Older media is removed automatically"
      onChange={vi.fn()} options={[{ value: '1', label: '1 GB' }]} /></form>)
    expect(screen.getByRole('button', { name: /Cache size/ })).toHaveAccessibleDescription('Older media is removed automatically')
    expect(view.container.querySelector('form')).not.toBeValid()
  })

  it('reflects controlled options that arrive after the field mounts', () => {
    const view = render(<SelectField label="Stage" value="qualified" onChange={vi.fn()} options={[]} />)
    expect(screen.getByRole('button', { name: /Stage/ })).toHaveTextContent('Select an option')
    view.rerender(<SelectField label="Stage" value="qualified" onChange={vi.fn()}
      options={[{ value: 'qualified', label: 'Qualified' }]} />)
    expect(screen.getByRole('button', { name: /Stage/ })).toHaveTextContent('Qualified')
  })

  it('shows matching color swatches in the selected value and option list', async () => {
    render(<SelectField label="Stage" value="won" onChange={vi.fn()} options={[
      { value: 'all', label: 'All', color: 'rgb(102, 119, 129)' },
      { value: 'won', label: 'Won', color: '#84CC16' }
    ]} />)

    const trigger = screen.getByRole('button', { name: /Stage/ })
    expect(trigger.querySelector('.ui-choice-swatch')).toHaveStyle({ '--choice-color': '#84CC16' })
    fireEvent.click(trigger)
    const wonOption = await screen.findByRole('option', { name: 'Won' })
    expect(wonOption.querySelector('.ui-choice-swatch')).toHaveStyle({ '--choice-color': '#84CC16' })
    expect(document.querySelectorAll('.ui-choice-swatch')).toHaveLength(3)
  })
})

describe('ComboBoxField', () => {
  it('filters searchable data and renders an explicit empty state', async () => {
    render(<ComboBoxField label="Contact" value="" onChange={vi.fn()} placeholder="Search contacts" options={[
      { value: 'one', label: 'Priya Shah' }, { value: 'two', label: 'Aarav Mehta' }
    ]} />)
    const input = screen.getByRole('combobox', { name: 'Contact' })
    input.focus()
    fireEvent.input(input, { target: { value: 'missing' } })
    expect(await screen.findByText('No matching options')).toBeInTheDocument()
    fireEvent.input(input, { target: { value: 'Priya' } })
    expect(await screen.findByRole('option', { name: 'Priya Shah' })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: 'Aarav Mehta' })).not.toBeInTheDocument()
  })

  it('preserves an explicit empty-value option', async () => {
    const onChange = vi.fn()
    render(<ComboBoxField label="Catalog item" value="item" onChange={onChange} options={[
      { value: '', label: 'Custom item' }, { value: 'item', label: 'Desk lamp' }
    ]} />)
    fireEvent.click(screen.getByRole('button', { name: /Open Catalog item options/ }))
    fireEvent.click(await screen.findByRole('option', { name: 'Custom item' }))
    expect(onChange).toHaveBeenCalledWith('')
  })

  it('clears the controlled value when the searchable input is cleared', () => {
    const onChange = vi.fn()
    render(<ComboBoxField label="Contact" value="contact-one" required onChange={onChange} options={[
      { value: 'contact-one', label: 'Priya Shah' }, { value: 'contact-two', label: 'Aarav Mehta' }
    ]} />)
    const input = screen.getByRole('combobox', { name: 'Contact' })
    expect(input).toHaveValue('Priya Shah')
    fireEvent.input(input, { target: { value: '' } })
    expect(onChange).toHaveBeenCalledWith('')
  })

  it('associates a searchable field description', () => {
    render(<ComboBoxField label="Catalog item" value="" description="Search products and services" onChange={vi.fn()}
      options={[{ value: '', label: 'Custom item' }]} />)
    expect(screen.getByRole('combobox', { name: 'Catalog item' })).toHaveAccessibleDescription('Search products and services')
  })
})

describe('DropdownMenu', () => {
  it('supports arrow navigation, Escape dismissal, and focus restoration', async () => {
    const action = vi.fn()
    render(<DropdownMenu label="Actions" icon={<span>+</span>} items={[
      { id: 'first', label: 'First action', onAction: action }, { id: 'second', label: 'Second action', onAction: vi.fn() }
    ]} />)
    const trigger = screen.getByRole('button', { name: 'Actions' })
    trigger.focus()
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    const menu = await screen.findByRole('menu')
    fireEvent.keyDown(menu, { key: 'ArrowDown' })
    expect(screen.getByRole('menuitem', { name: 'Second action' })).toHaveFocus()
    fireEvent.keyDown(document.activeElement ?? menu, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument())
    expect(trigger).toHaveFocus()
  })

  it('focuses the stable trigger before invoking a menu action', async () => {
    let actionFocus: Element | null = null
    render(<DropdownMenu label="Message actions" icon={<span>+</span>} items={[
      { id: 'edit', label: 'Edit', onAction: () => { actionFocus = document.activeElement } }
    ]} />)
    const trigger = screen.getByRole('button', { name: 'Message actions' })
    fireEvent.click(trigger)
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Edit' }))
    expect(actionFocus).toBe(trigger)
  })

  it('anchors the popover to the actual dropdown button while tooltip support is enabled', async () => {
    render(<DropdownMenu label="Message actions" icon={<span>+</span>} items={[
      { id: 'copy', label: 'Copy', onAction: vi.fn() }
    ]} />)
    const trigger = screen.getByRole('button', { name: 'Message actions' })
    vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue({
      x: 480, y: 320, top: 320, right: 508, bottom: 348, left: 480, width: 28, height: 28, toJSON: () => ({})
    })

    fireEvent.click(trigger)
    const menu = await screen.findByRole('menu')
    await waitFor(() => expect(menu.closest('.ui-menu-popover')).toHaveStyle({ '--trigger-width': '28px' }))
  })

})

describe('Tooltip', () => {
  it('shows a themed tooltip after the configured hover delay', () => {
    vi.useFakeTimers()
    render(<Tooltip label="Attach a file"><button aria-label="Attach"><span>+</span></button></Tooltip>)
    fireEvent.pointerMove(document, { pointerType: 'mouse' })
    const trigger = screen.getByRole('button', { name: 'Attach' })
    fireEvent.pointerEnter(trigger, { pointerType: 'mouse' })
    act(() => { vi.advanceTimersByTime(450) })
    const tooltip = screen.getByRole('tooltip')
    expect(tooltip).toHaveTextContent('Attach a file')
    expect(trigger).toHaveAttribute('aria-describedby', tooltip.id)
    fireEvent.pointerLeave(trigger, { pointerType: 'mouse' })
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
    act(() => { vi.advanceTimersByTime(500) })
  })

  it('cancels abandoned hovers and opens only the final sibling trigger', () => {
    vi.useFakeTimers()
    render(<>
      <Tooltip label="Grinning face"><button aria-label="Grinning face">😀</button></Tooltip>
      <Tooltip label="Smiling face"><button aria-label="Smiling face">😊</button></Tooltip>
    </>)
    fireEvent.pointerMove(document, { pointerType: 'mouse' })
    const grinning = screen.getByRole('button', { name: 'Grinning face' })
    const smiling = screen.getByRole('button', { name: 'Smiling face' })
    fireEvent.pointerEnter(grinning, { pointerType: 'mouse' })
    act(() => { vi.advanceTimersByTime(100) })
    fireEvent.pointerLeave(grinning, { pointerType: 'mouse' })
    fireEvent.pointerEnter(smiling, { pointerType: 'mouse' })
    act(() => { vi.advanceTimersByTime(100) })
    fireEvent.pointerLeave(smiling, { pointerType: 'mouse' })
    act(() => { vi.advanceTimersByTime(500) })
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()

    fireEvent.pointerEnter(smiling, { pointerType: 'mouse' })
    act(() => { vi.advanceTimersByTime(449) })
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
    act(() => { vi.advanceTimersByTime(1) })
    expect(screen.getByRole('tooltip')).toHaveTextContent('Smiling face')
    fireEvent.pointerLeave(smiling, { pointerType: 'mouse' })
    act(() => { vi.advanceTimersByTime(500) })
  })

  it('keeps one tooltip open while moving across warmed sibling triggers', () => {
    vi.useFakeTimers()
    render(<>
      <Tooltip label="Reply"><button aria-label="Reply">R</button></Tooltip>
      <Tooltip label="Forward"><button aria-label="Forward">F</button></Tooltip>
    </>)
    fireEvent.pointerMove(document, { pointerType: 'mouse' })
    const reply = screen.getByRole('button', { name: 'Reply' })
    const forward = screen.getByRole('button', { name: 'Forward' })
    fireEvent.pointerEnter(reply, { pointerType: 'mouse' })
    act(() => { vi.advanceTimersByTime(450) })
    expect(screen.getByRole('tooltip')).toHaveTextContent('Reply')
    fireEvent.pointerLeave(reply, { pointerType: 'mouse' })
    fireEvent.pointerEnter(forward, { pointerType: 'mouse' })
    expect(screen.getAllByRole('tooltip')).toHaveLength(1)
    expect(screen.getByRole('tooltip')).toHaveTextContent('Forward')
    fireEvent.pointerLeave(forward, { pointerType: 'mouse' })
    act(() => { vi.advanceTimersByTime(500) })
  })

  it('opens immediately for keyboard focus and closes on Escape or blur', () => {
    vi.useFakeTimers()
    render(<Tooltip label="Search this conversation"><button aria-label="Search"><span>+</span></button></Tooltip>)
    const trigger = screen.getByRole('button', { name: 'Search' })
    fireEvent.keyDown(document.body, { key: 'Tab', code: 'Tab' })
    act(() => { trigger.focus() })
    expect(screen.getByRole('tooltip')).toHaveTextContent('Search this conversation')
    act(() => { trigger.blur() })
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()

    fireEvent.keyDown(document.body, { key: 'Tab', code: 'Tab' })
    act(() => { trigger.focus() })
    expect(screen.getByRole('tooltip')).toBeInTheDocument()
    fireEvent.keyDown(trigger, { key: 'Escape' })
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
    act(() => { vi.advanceTimersByTime(500) })
  })

  it('keeps disabled icon controls labeled without registering an unusable tooltip trigger', () => {
    vi.useFakeTimers()
    render(<Tooltip label="Remove line"><button aria-label="Remove line" disabled><span>-</span></button></Tooltip>)
    const trigger = screen.getByRole('button', { name: 'Remove line' })
    expect(trigger).toBeDisabled()
    fireEvent.mouseEnter(trigger)
    act(() => { vi.advanceTimersByTime(500) })
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
  })
})
