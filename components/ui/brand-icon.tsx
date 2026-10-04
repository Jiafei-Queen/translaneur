import { cn } from '@/lib/utils'

// The artwork in public/icon is a single-colour silhouette on transparency.
// Painting the very same file as a CSS mask instead of an <img> makes the mask
// read its alpha channel and ignore the fill baked into the PNG, so
// `currentColor` tints it. That keeps one source of truth for the icon and
// stays legible on both the light and the dark surfaces of the popup and the
// settings page.
const MASK = 'url(/icon/96.png) center / contain no-repeat'

export function BrandIcon({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cn('inline-block shrink-0 bg-current', className)}
      style={{ mask: MASK, WebkitMask: MASK }}
    />
  )
}