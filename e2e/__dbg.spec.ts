import { expect, launch, test, tempDir } from './harness'

test('debug rail drag', async () => {
  const { win } = await launch(tempDir('intersect-dbg2-'))
  const divider = win.locator('[data-testid="sidebar-rail-resizer"]')
  const box = (await divider.boundingBox())!

  await win.evaluate(() => {
    const w = window as unknown as { __wm: number; __down: number }
    w.__wm = 0
    w.__down = 0
    window.addEventListener('pointermove', () => (w.__wm += 1))
    window.addEventListener('pointerdown', () => (w.__down += 1))
  })

  const logs: string[] = []
  win.on('console', (m) => logs.push(`${m.type()}: ${m.text()}`))
  win.on('pageerror', (e) => logs.push(`pageerror: ${String(e)}`))

  await win.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await win.mouse.down()
  await win.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 70, { steps: 8 })
  await win.mouse.up()
  await win.waitForTimeout(300)

  const boxes = await win.evaluate(() =>
    [...document.querySelectorAll('[role="separator"]')].map((el) => ({
      id: el.getAttribute('data-testid'),
      rect: el.getBoundingClientRect().toJSON()
    }))
  )
  console.log('DBG separators', JSON.stringify(boxes))
  const out = await win.evaluate(() => ({
    windowMoves: (window as unknown as { __wm: number }).__wm,
    downs: (window as unknown as { __down: number }).__down,
    inline: document.querySelector<HTMLElement>('.ix-rail')?.style.height ?? '(none)',
    railH: document.querySelector('.ix-rail')?.getBoundingClientRect().height,
    asideH: document.querySelector('.ix-sidebar')?.getBoundingClientRect().height
  }))
  console.log('DBG', JSON.stringify(out))
  console.log('DBG all', JSON.stringify(logs.slice(0, 12)))
  expect(true).toBe(true)
})
