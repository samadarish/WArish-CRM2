import { ChevronDown, Check } from 'lucide-react'
import {
  Button as AriaButton,
  ComboBox as AriaComboBox,
  Input as AriaInput,
  Label as AriaLabel,
  ListBox as AriaListBox,
  ListBoxItem as AriaListBoxItem,
  Menu as AriaMenu,
  MenuItem as AriaMenuItem,
  MenuTrigger as AriaMenuTrigger,
  Popover as AriaPopover,
  Pressable,
  Select as AriaSelect,
  SelectValue as AriaSelectValue,
  Text as AriaText,
  Tooltip as AriaTooltip,
  TooltipTrigger as AriaTooltipTrigger,
  useFilter,
  type Placement
} from 'react-aria-components'
import { isValidElement, useEffect, useId, useLayoutEffect, useRef, useState, type ComponentProps, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

const EMPTY_KEY = '__warish_empty_value__'

export interface ChoiceOption {
  value: string
  label: string
  color?: string
  disabled?: boolean
}

type KeyedChoiceOption = ChoiceOption & { id: string }

interface ChoiceFieldProps {
  label: string
  value: string
  options: ChoiceOption[]
  onChange(value: string): void
  description?: string
  placeholder?: string
  disabled?: boolean
  required?: boolean
  hideLabel?: boolean
  density?: 'regular' | 'compact'
  className?: string
}

function optionKey(value: string): string {
  return value === '' ? EMPTY_KEY : value
}

function optionValue(key: React.Key): string {
  return String(key) === EMPTY_KEY ? '' : String(key)
}

function keyedOptions(options: ChoiceOption[]): KeyedChoiceOption[] {
  return options.map((option) => ({ ...option, id: optionKey(option.value) }))
}

function selectedOptionKey(value: string, options: ChoiceOption[]): string | null {
  return options.some((option) => option.value === value) ? optionKey(value) : null
}

export function SelectField({ label, value, options, onChange, description, placeholder, disabled = false,
  required = false, hideLabel = false, density = 'regular', className = '' }: ChoiceFieldProps): React.JSX.Element {
  const items = keyedOptions(options)
  const selected = options.find((option) => option.value === value)
  return <AriaSelect className={`ui-choice-field ui-select-field ${density} ${className}`.trim()}
    selectedKey={selectedOptionKey(value, options)} isDisabled={disabled} isRequired={required} validationBehavior="native"
    onSelectionChange={(key) => { if (key !== null) onChange(optionValue(key)) }}>
    <span className={`ui-choice-copy ${hideLabel ? 'sr-only' : ''}`}>
      <AriaLabel className="ui-choice-label">{label}</AriaLabel>
      {description && <AriaText slot="description"><small>{description}</small></AriaText>}
    </span>
    <AriaButton className="ui-choice-trigger">
      <AriaSelectValue>{selected ? <ChoiceOptionLabel option={selected} /> : placeholder || 'Select an option'}</AriaSelectValue>
      <ChevronDown aria-hidden="true" />
    </AriaButton>
    <AriaPopover className="ui-popover" placement="bottom start" offset={4} shouldFlip>
      <AriaListBox className="ui-listbox" items={items} renderEmptyState={() => <div className="ui-empty-option">No options</div>}>
        {(option) => <AriaListBoxItem id={option.id} textValue={option.label} isDisabled={option.disabled}
          className="ui-option">{({ isSelected }) => <><ChoiceOptionLabel option={option} />{isSelected && <Check aria-hidden="true" />}</>}</AriaListBoxItem>}
      </AriaListBox>
    </AriaPopover>
  </AriaSelect>
}

function ChoiceOptionLabel({ option }: { option: ChoiceOption }): React.JSX.Element {
  return <span className="ui-choice-option">{option.color && <i className="ui-choice-swatch" aria-hidden="true"
    style={{ '--choice-color': option.color } as React.CSSProperties} />}<span>{option.label}</span></span>
}

export function ComboBoxField({ label, value, options, onChange, description, placeholder = 'Search options',
  disabled = false, required = false, hideLabel = false, density = 'regular', className = '' }: ChoiceFieldProps): React.JSX.Element {
  const { contains } = useFilter({ sensitivity: 'base' })
  const items = keyedOptions(options)
  return <AriaComboBox className={`ui-choice-field ui-combobox-field ${density} ${className}`.trim()}
    defaultItems={items} selectedKey={selectedOptionKey(value, options)} isDisabled={disabled} isRequired={required}
    validationBehavior="native" defaultFilter={contains}
    allowsEmptyCollection
    onSelectionChange={(key) => onChange(key === null ? '' : optionValue(key))}>
    <span className={`ui-choice-copy ${hideLabel ? 'sr-only' : ''}`}>
      <AriaLabel className="ui-choice-label">{label}</AriaLabel>
      {description && <AriaText slot="description"><small>{description}</small></AriaText>}
    </span>
    <div className="ui-combobox-control">
      <AriaInput className="ui-combobox-input" placeholder={placeholder} />
      <AriaButton className="ui-combobox-button" aria-label={`Open ${label} options`}><ChevronDown aria-hidden="true" /></AriaButton>
    </div>
    <AriaPopover className="ui-popover" placement="bottom start" offset={4} shouldFlip>
      <AriaListBox<KeyedChoiceOption> className="ui-listbox"
        renderEmptyState={() => <div className="ui-empty-option">No matching options</div>}>
        {(option) => <AriaListBoxItem id={option.id} textValue={option.label} isDisabled={option.disabled}
          className="ui-option">{({ isSelected }) => <><span>{option.label}</span>{isSelected && <Check aria-hidden="true" />}</>}</AriaListBoxItem>}
      </AriaListBox>
    </AriaPopover>
  </AriaComboBox>
}

export interface DropdownMenuItem {
  id: string
  label: string
  icon?: ReactNode
  disabled?: boolean
  danger?: boolean
  onAction(returnFocus?: HTMLElement): void
}

export function DropdownMenu({ label, icon, items, className = 'icon-button', placement = 'bottom end',
  disabled = false, isOpen, onOpenChange }: {
  label: string
  icon: ReactNode
  items: DropdownMenuItem[]
  className?: string
  placement?: Placement
  disabled?: boolean
  isOpen?: boolean
  onOpenChange?(open: boolean): void
}): React.JSX.Element {
  const triggerRef = useRef<HTMLButtonElement>(null)
  const tooltipRef = useRef<HTMLDivElement>(null)
  const tooltipTimerRef = useRef<number | undefined>(undefined)
  const tooltipId = useId()
  const [tooltipOpen, setTooltipOpen] = useState(false)
  const [tooltipPosition, setTooltipPosition] = useState({ left: 0, top: 0, placement: 'top' as 'top' | 'bottom' })
  const closeTooltip = (): void => {
    if (tooltipTimerRef.current !== undefined) window.clearTimeout(tooltipTimerRef.current)
    tooltipTimerRef.current = undefined
    setTooltipOpen(false)
  }
  const scheduleTooltip = (): void => {
    if (disabled) return
    if (tooltipTimerRef.current !== undefined) window.clearTimeout(tooltipTimerRef.current)
    tooltipTimerRef.current = window.setTimeout(() => {
      tooltipTimerRef.current = undefined
      setTooltipOpen(true)
    }, 450)
  }
  useEffect(() => () => {
    if (tooltipTimerRef.current !== undefined) window.clearTimeout(tooltipTimerRef.current)
  }, [])
  useLayoutEffect(() => {
    if (!tooltipOpen) return
    const updatePosition = (): void => {
      const trigger = triggerRef.current
      const tooltip = tooltipRef.current
      if (!trigger || !tooltip) return
      const triggerBounds = trigger.getBoundingClientRect()
      const tooltipBounds = tooltip.getBoundingClientRect()
      const edgePadding = 8
      const gap = 7
      const halfWidth = tooltipBounds.width / 2
      const left = Math.min(window.innerWidth - edgePadding - halfWidth,
        Math.max(edgePadding + halfWidth, triggerBounds.left + triggerBounds.width / 2))
      const placement = triggerBounds.top >= tooltipBounds.height + gap + edgePadding ? 'top' : 'bottom'
      setTooltipPosition({ left, top: placement === 'top' ? triggerBounds.top - gap : triggerBounds.bottom + gap, placement })
    }
    updatePosition()
    window.addEventListener('resize', updatePosition)
    window.addEventListener('scroll', updatePosition, true)
    return () => {
      window.removeEventListener('resize', updatePosition)
      window.removeEventListener('scroll', updatePosition, true)
    }
  }, [tooltipOpen])
  return <>
    <AriaMenuTrigger isOpen={isOpen} onOpenChange={(open) => {
      if (open) closeTooltip()
      onOpenChange?.(open)
    }}>
    <AriaButton ref={triggerRef} className={className} aria-label={label} aria-describedby={tooltipOpen ? tooltipId : undefined}
      isDisabled={disabled} onHoverStart={scheduleTooltip} onHoverEnd={closeTooltip}
      onFocus={() => setTooltipOpen(!disabled)} onBlur={closeTooltip} onKeyDown={(event) => { if (event.key === 'Escape') closeTooltip() }}>
      <span aria-hidden="true">{icon}</span>
    </AriaButton>
    <AriaPopover className="ui-popover ui-menu-popover" placement={placement} offset={4} shouldFlip>
      <AriaMenu className="ui-menu" items={items} onAction={(key) => {
        const item = items.find((candidate) => candidate.id === key)
        if (!item) return
        triggerRef.current?.focus()
        item.onAction(triggerRef.current ?? undefined)
      }}>
        {(item) => <AriaMenuItem id={item.id} textValue={item.label} isDisabled={item.disabled}
          className={`ui-menu-item ${item.danger ? 'danger-text' : ''}`}>
          {item.icon}<span>{item.label}</span>
        </AriaMenuItem>}
      </AriaMenu>
    </AriaPopover>
  </AriaMenuTrigger>
    {!disabled && tooltipOpen && createPortal(<div ref={tooltipRef} id={tooltipId} role="tooltip"
      className="ui-tooltip dropdown-tooltip" data-placement={tooltipPosition.placement}
      style={{ left: tooltipPosition.left, top: tooltipPosition.top }}>{label}</div>, document.body)}
  </>
}

export function IconButton({ label, tooltipPlacement = 'top', className = 'icon-button', children, ...props }: {
  label: string
  tooltipPlacement?: Placement
  children: ReactNode
} & Omit<ComponentProps<'button'>, 'aria-label' | 'className' | 'children' | 'title'> & {
  className?: string
}): React.JSX.Element {
  return <Tooltip label={label} placement={tooltipPlacement}>
    <button {...props} className={className} aria-label={label}>{children}</button>
  </Tooltip>
}

export function Tooltip({ label, children, placement = 'top' }: {
  label: string
  children: ComponentProps<typeof Pressable>['children']
  placement?: Placement
}): React.JSX.Element {
  const triggerDisabled = isValidElement<{ disabled?: boolean; isDisabled?: boolean }>(children)
    && Boolean(children.props.disabled || children.props.isDisabled)

  if (triggerDisabled) return <>{children}</>

  return <AriaTooltipTrigger delay={450} closeDelay={0}>
    <Pressable>{children}</Pressable>
    <AriaTooltip className="ui-tooltip" placement={placement} offset={7}>{label}</AriaTooltip>
  </AriaTooltipTrigger>
}
