import * as React from 'react'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

export interface SegmentedOption<T extends string> {
  value: T
  label: string
  title?: string
}

export interface SegmentedControlProps<T extends string> {
  id?: string
  ariaLabel: string
  value: T
  onChange: (value: T) => void
  options: readonly SegmentedOption<T>[]
  /** 'compact' is the popup's h-7/text-xs scale; 'default' is the options page's h-8. */
  size?: 'default' | 'compact'
  disabled?: boolean
  className?: string
}

// --secondary, --muted and --accent are all oklch(0.97 0 0), so the active
// half needs its own surface to read as selected, and the unselected half
// needs a tint that differs from the track. Hover comes from the seg-hover-*
// utilities, which are !important to outrank the ghost variant's own
// same-specificity hover utilities — see style.css. They replace a
// `hover:bg-background!` suffix, which Tailwind v4's scanner silently ignores,
// compiling to no rule at all.
const SEGMENT_CLASS = {
  default: {
    active: 'h-8 border border-input bg-background px-2 font-semibold shadow-xs seg-hover-off-selected',
    idle: 'h-8 px-2 seg-hover-off',
  },
  compact: {
    active:
      'h-7 border border-input bg-background px-1 text-xs font-semibold shadow-xs seg-hover-off-selected',
    idle: 'h-7 px-1 text-xs seg-hover-off',
  },
} as const

export function SegmentedControl<T extends string>({
  id,
  ariaLabel,
  value,
  onChange,
  options,
  size = 'default',
  disabled,
  className,
}: SegmentedControlProps<T>) {
  const scale = SEGMENT_CLASS[size]
  return (
    <div
      id={id}
      role="radiogroup"
      aria-label={ariaLabel}
      className={cn(
        'grid grid-cols-2 gap-1 rounded-md border border-input bg-muted p-1',
        className,
      )}
    >
      {options.map((option) => {
        const active = value === option.value
        return (
          <Button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            title={option.title || undefined}
            data-value={option.value}
            variant="ghost"
            size="sm"
            className={active ? scale.active : scale.idle}
            onClick={() => onChange(option.value)}
            disabled={disabled}
          >
            {option.label}
          </Button>
        )
      })}
    </div>
  )
}