import flowDarkCompact from '../assets/brand/flow-dark-compact.png'
import flowDark from '../assets/brand/flow-dark.png'
import flowLightCompact from '../assets/brand/flow-light-compact.png'
import flowLight from '../assets/brand/flow-light.png'

export function BrandMark({ variant = 'full', size = 'normal', label }: {
  variant?: 'full' | 'compact'
  size?: 'normal' | 'small' | 'large'
  label?: string
}): React.JSX.Element {
  const lightAsset = variant === 'compact' ? flowLightCompact : flowLight
  const darkAsset = variant === 'compact' ? flowDarkCompact : flowDark
  const sizeClass = size === 'normal' ? '' : ` ${size}`

  return <span className={`brand-mark${sizeClass}`} data-brand-variant={variant}
    role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
    <img className="brand-mark-image light" src={lightAsset} alt="" draggable={false} />
    <img className="brand-mark-image dark" src={darkAsset} alt="" draggable={false} />
  </span>
}
