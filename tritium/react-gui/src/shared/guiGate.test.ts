/**
 * @file shared/guiGate.test.ts
 * @description The one table every gated surface (menus, toolbar, bottom
 * panel) is decided by. A missing declaration must fail safe: usable only
 * with a molview tab in front.
 */
import { describe, it, expect } from 'vitest'
import { isAvailable, recentAvailability } from './guiGate'
import type { Availability, GuiGate } from './guiGate'

describe('isAvailable', () => {
  it('follows the availability x front-tab table', () => {
    const tabs: GuiGate['tab'][] = ['molview', 'other', 'none']
    const row = (a: Availability | undefined) => tabs.map((tab) => isAvailable(a, { tab }))
    expect(row('always')).toEqual([true, true, true])
    expect(row('loadIntoScene')).toEqual([true, false, true])
    expect(row(undefined)).toEqual([true, false, false])
  })

  it('gates an Open Recent row by the type it opens as', () => {
    expect(recentAvailability({ ftype: 'scene' })).toBe('always')
    expect(recentAvailability({ ftype: 'obj' })).toBe('loadIntoScene')
  })
})
