import { expect, test } from 'bun:test'
import { listenForSidebarSwipe } from '../src/lib/sidebar-swipe'

type SetupOptions = {
  mobile?: boolean
  isDrawer?: boolean
  drawerOpen?: boolean
  wideOpen?: boolean
  surface?: string
  control?: string
  horizontalScroll?: boolean
}

function setup({
  mobile = true,
  isDrawer = true,
  drawerOpen = false,
  wideOpen = true,
  surface = drawerOpen ? 'drawer' : 'page',
  control = '',
  horizontalScroll = false
}: SetupOptions = {}) {
  const state = { isDrawer, drawerOpen, wideOpen, overlayOpen: false, fullscreenLyrics: false }
  const doc = Object.assign(new EventTarget(), {
    querySelector: () => (state.overlayOpen ? {} : null),
    defaultView: { getComputedStyle: () => ({ overflowX: 'auto' }) }
  })
  const page = {
    nodeType: 1,
    closest: (selector: string) => {
      if (surface === 'page' && selector === '[data-slot="sidebar-wrapper"]') return page
      if (surface === 'drawer' && selector.includes('[data-slot="sidebar"][data-mobile="true"]')) return page
      if (surface === 'backdrop' && selector.includes('[data-slot="sheet-overlay"][data-state="open"]')) return page
      return control && selector.includes(control) ? page : null
    },
    scrollWidth: horizontalScroll ? 200 : 100,
    clientWidth: 100,
    parentElement: null
  }
  const stop = listenForSidebarSwipe(doc as unknown as Document, mobile, () => ({
    disabled: state.fullscreenLyrics,
    isDrawer: state.isDrawer,
    open: state.isDrawer ? state.drawerOpen : state.wideOpen,
    setOpen: open => {
      if (state.isDrawer) state.drawerOpen = open
      else state.wideOpen = open
    }
  }))

  function touch(type: string, clientX: number, clientY = 0, fingers = 1, cancelable = true) {
    const point = { identifier: 1, clientX, clientY }
    const touches = fingers === 2 ? [point, { ...point, identifier: 2 }] : [point]
    const event = new Event(type, { cancelable })
    Object.defineProperties(event, {
      target: { value: page },
      touches: { value: type === 'touchend' ? [] : touches },
      changedTouches: { value: [point] }
    })
    doc.dispatchEvent(event)
    return event
  }

  function swipe(x: number, y = 0) {
    touch('touchstart', 100)
    touch('touchmove', 100 + x, y)
    touch('touchend', 100 + x, y)
  }

  function click(detail = 1) {
    const event = new Event('click', { cancelable: true })
    Object.defineProperty(event, 'detail', { value: detail })
    doc.dispatchEvent(event)
    return event.defaultPrevented
  }

  return { state, stop, touch, swipe, click }
}

test('a right swipe opens the mobile drawer on release', () => {
  const { state, stop, touch } = setup()
  expect(touch('touchstart', 0).defaultPrevented).toBe(false)
  expect(touch('touchmove', 60).defaultPrevented).toBe(true)
  expect(state.drawerOpen).toBe(false)
  touch('touchend', 60)
  expect(state.drawerOpen).toBe(true)
  stop?.()
})

test('left swipe inside the portal closes the drawer while right swipe leaves it open', () => {
  const { state, swipe } = setup({ drawerOpen: true })
  swipe(80)
  expect(state.drawerOpen).toBe(true)
  swipe(-80)
  expect(state.drawerOpen).toBe(false)
})

test('left swipe over the backdrop closes the open drawer', () => {
  const { state, touch, swipe } = setup({ drawerOpen: true, surface: 'backdrop' })
  swipe(-80)
  expect(state.drawerOpen).toBe(false)
  touch('touchstart', 100)
  expect(touch('touchend', 100).defaultPrevented).toBe(false)
})

test('a non-cancelable move can still complete a left swipe inside the drawer', () => {
  const { state, touch } = setup({ drawerOpen: true })
  touch('touchstart', 100)
  touch('touchmove', 95, 0, 1, false)
  touch('touchmove', 30, 0, 1, false)
  touch('touchend', 30)
  expect(state.drawerOpen).toBe(false)
})

test.each([true, false])('fullscreen lyrics leave horizontal touches alone (drawer layout: %p)', isDrawer => {
  const { state, touch } = setup({ isDrawer })
  state.fullscreenLyrics = true
  const x = isDrawer ? 80 : -80
  touch('touchstart', 100)
  expect(touch('touchmove', 100 + x).defaultPrevented).toBe(false)
  expect(touch('touchend', 100 + x).defaultPrevented).toBe(false)
  expect(state.drawerOpen).toBe(false)
  expect(state.wideOpen).toBe(true)
})

test('entering fullscreen lyrics mid-swipe cancels the gesture', () => {
  const { state, touch, swipe } = setup()
  touch('touchstart', 0)
  touch('touchmove', 80)
  state.fullscreenLyrics = true
  expect(touch('touchend', 80).defaultPrevented).toBe(false)
  expect(state.drawerOpen).toBe(false)
  state.fullscreenLyrics = false
  swipe(80)
  expect(state.drawerOpen).toBe(true)
})

test('wide mobile layouts change only the persistent sidebar', () => {
  const { state, swipe } = setup({ isDrawer: false })
  swipe(-80)
  expect(state.wideOpen).toBe(false)
  swipe(-80)
  expect(state.wideOpen).toBe(false)
  swipe(80)
  expect(state.wideOpen).toBe(true)
  expect(state.drawerOpen).toBe(false)
})

test.each([
  [59, 0, false],
  [60, 40, true],
  [60, 41, false]
])('release at (%i, %i) opens the drawer: %p', (x, y, opens) => {
  const { state, swipe } = setup()
  swipe(x, y)
  expect(state.drawerOpen).toBe(opens)
})

test('vertical motion keeps scrolling and cannot turn into a sidebar swipe', () => {
  const { state, touch } = setup()
  touch('touchstart', 0)
  expect(touch('touchmove', 1, 12).defaultPrevented).toBe(false)
  expect(touch('touchmove', 80, 12).defaultPrevented).toBe(false)
  touch('touchend', 80, 12)
  expect(state.drawerOpen).toBe(false)
})

test.each(['second finger', 'cancellation', 'layout change', 'unmount'] as const)(
  '%s ends an in-progress swipe',
  interruption => {
    const { state, touch, stop } = setup()
    touch('touchstart', 0)
    touch('touchmove', 80)
    if (interruption === 'second finger') touch('touchstart', 80, 0, 2)
    if (interruption === 'cancellation') touch('touchcancel', 80)
    if (interruption === 'layout change') {
      state.isDrawer = false
      state.wideOpen = false
    }
    if (interruption === 'unmount') stop?.()
    touch('touchend', 80)
    expect(state.drawerOpen).toBe(false)
    if (interruption === 'layout change') expect(state.wideOpen).toBe(false)
  }
)

test.each([
  ['a desktop platform', { mobile: false }],
  ['a surface outside the drawer and its backdrop', { drawerOpen: true, surface: 'outside' }],
  ['an input', { control: 'input' }],
  ['a slider track', { control: '[data-slot="slider"]' }],
  ['editable content', { control: '[contenteditable]' }],
  ['a horizontal scroller', { horizontalScroll: true }]
] as const)('swipes starting on %s remain available to that surface', (_, options) => {
  const { state, touch } = setup(options)
  const wasOpen = state.drawerOpen
  const x = wasOpen ? -80 : 80
  touch('touchstart', 0)
  expect(touch('touchmove', x).defaultPrevented).toBe(false)
  expect(touch('touchend', x).defaultPrevented).toBe(false)
  expect(state.drawerOpen).toBe(wasOpen)
})

test('an open dialog blocks swipe handling both at touch start and before release', () => {
  const { state, touch, swipe } = setup()
  state.overlayOpen = true
  swipe(80)
  expect(state.drawerOpen).toBe(false)
  state.overlayOpen = false
  touch('touchstart', 0)
  touch('touchmove', 80)
  state.overlayOpen = true
  touch('touchend', 80)
  expect(state.drawerOpen).toBe(false)
})

test('a dialog opening during a touch takes over before the swipe locks', () => {
  const { state, touch } = setup()
  touch('touchstart', 0)
  expect(touch('touchmove', 10).defaultPrevented).toBe(false)
  state.overlayOpen = true
  expect(touch('touchmove', 80).defaultPrevented).toBe(false)
  touch('touchend', 80)
  expect(state.drawerOpen).toBe(false)
})

test('a horizontal drag consumes its click but leaves keyboard activation and the next tap alone', () => {
  const { state, touch, swipe, click } = setup()
  swipe(25)
  expect(state.drawerOpen).toBe(false)
  expect(click(0)).toBe(false)
  expect(click()).toBe(true)
  swipe(80)
  expect(state.drawerOpen).toBe(true)
  touch('touchstart', 100)
  touch('touchend', 100)
  expect(click()).toBe(false)
})
