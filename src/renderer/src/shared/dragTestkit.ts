/**
 * What a test needs to drive an HTML5 drag under jsdom, which implements neither `DataTransfer`
 * nor `DragEvent`. Shared rather than copied per suite, because every drop surface in the app is
 * tested the same way and the shape of the stand-in is the part that has to match the real thing.
 */

/** A `DataTransfer` stand-in: a plain key/value bag plus the two effect fields a drag reads. */
export interface FakeDataTransfer {
  effectAllowed: string
  dropEffect: string
  readonly types: readonly string[]
  getData(type: string): string
  setData(type: string, value: string): void
}

/** An empty transfer, ready to be written to the way a real `dragstart` handler writes one. */
export function fakeDataTransfer(): FakeDataTransfer {
  const data: Record<string, string> = {}
  return {
    effectAllowed: '',
    dropEffect: '',
    get types() {
      return Object.keys(data)
    },
    getData: (type) => data[type] ?? '',
    setData: (type, value) => {
      data[type] = value
    }
  }
}

/**
 * A drag event carrying both a pointer position and a transfer. Built on `MouseEvent` because
 * jsdom has no `DragEvent`, and fireEvent's would arrive as a bare `Event` with no `clientX` on
 * it at all - which is the whole input to any drop-position arithmetic under test.
 */
export function dragEvent(type: string, dataTransfer: FakeDataTransfer, clientX = 0): Event {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX })
  Object.defineProperty(event, 'dataTransfer', { value: dataTransfer })
  return event
}
