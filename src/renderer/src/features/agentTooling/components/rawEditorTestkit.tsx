import { useState } from 'react'
import type { RawJsonEditorProps } from './RawJsonEditor'

/**
 * A stand-in for the Monaco raw editor, for the suites that drive the raw-editing path from the
 * outside (the settings view, the app shell). Monaco needs layout and workers that jsdom does not
 * provide, and it is loaded lazily on purpose, so a test that mounted the real one would pull the
 * whole editor into a renderer bundle it must stay out of.
 *
 * The stand-in keeps the contract that matters: it is seeded once at mount, it reports every
 * change as it happens, and it compares against the same baseline for its dirty state. A test can
 * therefore type into the raw editor and read back what survived an unmount.
 */
export function RawJsonEditorStub({
  seed,
  baseline,
  busy,
  onChange,
  onPreview,
  onReload
}: RawJsonEditorProps) {
  const [text, setText] = useState(seed)
  // The real editor rebuilds its buffer whenever the seed changes (another file, a reload); the
  // stand-in has to do the same, otherwise a test reads a buffer the app would have replaced.
  const [seeded, setSeeded] = useState(seed)
  if (seeded !== seed) {
    setSeeded(seed)
    setText(seed)
  }
  return (
    <div className="ix-at-raw">
      <textarea
        aria-label="Raw JSON"
        value={text}
        onChange={(e) => {
          setText(e.target.value)
          onChange(e.target.value)
        }}
      />
      <button type="button" onClick={onReload} disabled={busy}>
        Reload from disk
      </button>
      <button type="button" onClick={() => onPreview(text)} disabled={busy || text === baseline}>
        Preview changes…
      </button>
    </div>
  )
}
