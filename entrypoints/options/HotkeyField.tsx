import { formatHotkey } from '@/lib/hotkey'
import { Button } from '@/components/ui/button'

export type HotkeyCapability = 'unknown' | 'apply' | 'read-only' | 'error'

interface HotkeyFieldProps {
  /** DOM id of the recorder button, addressed by the e2e specs. */
  id: string
  /** Manifest command this field binds; also its group marker in the DOM. */
  command: string
  /** Accessible name, so the two recorders are distinguishable by role. */
  label: string
  /** The recorded shortcut, or '' for off. */
  value: string
  /** The binding the browser reports it will actually fire. */
  active: string
  capability: HotkeyCapability
  recording: boolean
  hint: string | null
  onRecord: () => void
  onClear: () => void
}

// Presentational: the options page owns the recording state, the commit and the
// per-command binding reads, because all three are shared with the shortcuts
// section's footnotes and must not be duplicated per field.
export function HotkeyField({
  id,
  command,
  label,
  value,
  active,
  capability,
  recording,
  hint,
  onRecord,
  onClear,
}: HotkeyFieldProps) {
  const readOnly = capability === 'read-only'
  return (
    <div className="space-y-1.5" data-hotkey-command={command}>
      <div className="flex items-center gap-2">
        <Button
          id={id}
          variant="outline"
          size="sm"
          className="font-mono"
          aria-label={label}
          disabled={capability !== 'apply'}
          // A disabled button swallows hover, so the reason it is disabled has
          // to live in the title as well as the note below.
          title={
            readOnly
              ? 'Chrome does not let extensions assign shortcuts'
              : undefined
          }
          onClick={onRecord}
        >
          {recording
            ? 'Press keys…'
            : readOnly
              ? // What the browser will really fire, and nothing else.
                // Falling back to the stored preference re-creates the "saved
                // but never applied" lie: getSettings() merges the defaults, so
                // a stored value can exist with no binding behind it.
                active
                ? formatHotkey(active)
                : 'Not set'
              : value
                ? formatHotkey(value)
                : 'Not set'}
        </Button>
        {value !== '' && !recording && !readOnly && (
          <Button variant="ghost" size="sm" onClick={onClear}>
            Clear
          </Button>
        )}
      </div>
      {recording && hint && <p className="text-xs text-destructive">{hint}</p>}
      {capability === 'apply' &&
        (active ? (
          <p className="text-xs text-muted-foreground">
            Currently active: {formatHotkey(active)}
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">
            Not active in the browser.
          </p>
        ))}
    </div>
  )
}
