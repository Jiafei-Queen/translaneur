import { cn } from '@/lib/utils'

// The artwork in public/icon is white-on-transparent, so it inherits the
// browser's own toolbar theme but vanishes on a light page. Painting the very
// same file as a CSS mask instead of an <img> lets `currentColor` tint it,
// which keeps one source of truth for the icon and stays legible on both the
// light and the dark surfaces of the popup and the settings page.
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