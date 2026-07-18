import { memo, useEffect, useState } from 'react'

export const Avatar = memo(function Avatar({ title, src, large = false }: {
  title: string
  src?: string
  large?: boolean
}): React.JSX.Element {
  const [imageAvailable, setImageAvailable] = useState(Boolean(src))
  useEffect(() => setImageAvailable(Boolean(src)), [src])
  const classes = `avatar ${large ? 'large' : ''} ${imageAvailable ? 'has-image' : ''}`
  return <div className={classes} aria-hidden="true">
    {src && imageAvailable
      ? <img src={src} alt="" loading="lazy" decoding="async" onError={() => setImageAvailable(false)} />
      : contactInitials(title)}
  </div>
})

function contactInitials(title: string): string {
  const words = title.trim().split(/\s+/).filter(Boolean)
  if (!words.length) return '?'
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase()
  return `${words[0]![0] ?? ''}${words.at(-1)?.[0] ?? ''}`.toUpperCase()
}
