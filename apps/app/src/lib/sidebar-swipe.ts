const MOBILE_SIDEBAR = '[data-slot="sidebar"][data-mobile="true"]'
const OPEN_DRAWER_SURFACE = `${MOBILE_SIDEBAR}, [data-slot="sheet-overlay"][data-state="open"]`
const BLOCKING_OVERLAY = `:is([role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"])[data-state="open"]:not(${MOBILE_SIDEBAR})`
const EDITABLE_CONTROL =
  'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="slider"], [data-slot="slider"]'

type SidebarState = {
  disabled: boolean
  isDrawer: boolean
  open: boolean
  setOpen: (open: boolean) => void
}

type Swipe = {
  start: Touch
  isDrawer: boolean
  open: boolean
  horizontal: boolean
}

function isHorizontal(x: number, y: number) {
  return Math.abs(x) >= 1.5 * Math.abs(y)
}

function hasHorizontalScroller(target: Element, view: Window | null) {
  for (let element: Element | null = target; view && element; element = element.parentElement) {
    if (
      element.scrollWidth > element.clientWidth &&
      /^(auto|scroll|overlay)$/.test(view.getComputedStyle(element).overflowX)
    ) {
      return true
    }
  }
  return false
}

export function listenForSidebarSwipe(doc: Document, isMobilePlatform: boolean, getSidebar: () => SidebarState) {
  if (!isMobilePlatform) return

  let swipe: Swipe | undefined
  let suppressClickUntil = -Infinity

  function clearClickGuard() {
    suppressClickUntil = -Infinity
  }

  function onStart(event: TouchEvent) {
    swipe = undefined
    clearClickGuard()
    if (event.touches.length !== 1) return

    const target = event.target as Element | null
    if (target?.nodeType !== 1 || target.closest(EDITABLE_CONTROL)) return

    const { disabled, isDrawer, open } = getSidebar()
    if (disabled) return
    const surface = isDrawer && open ? OPEN_DRAWER_SURFACE : '[data-slot="sidebar-wrapper"]'
    if (
      !target.closest(surface) ||
      doc.querySelector(BLOCKING_OVERLAY) ||
      hasHorizontalScroller(target, doc.defaultView)
    ) {
      return
    }

    swipe = { start: event.touches[0], isDrawer, open, horizontal: false }
  }

  function onMove(event: TouchEvent) {
    if (!swipe) return
    const point = event.touches[0]
    if (
      event.touches.length !== 1 ||
      point.identifier !== swipe.start.identifier ||
      getSidebar().disabled ||
      doc.querySelector(BLOCKING_OVERLAY)
    ) {
      swipe = undefined
      return
    }

    if (!swipe.horizontal) {
      const x = point.clientX - swipe.start.clientX
      const y = point.clientY - swipe.start.clientY
      if (Math.hypot(x, y) <= 10) return
      if (!isHorizontal(x, y)) {
        swipe = undefined
        return
      }
      swipe.horizontal = true
    }

    if (event.cancelable) event.preventDefault()
  }

  function onEnd(event: TouchEvent) {
    const gesture = swipe
    swipe = undefined
    if (!gesture || event.touches.length || event.changedTouches.length !== 1) return
    const point = event.changedTouches[0]
    if (point.identifier !== gesture.start.identifier) return
    const { disabled, isDrawer, open, setOpen } = getSidebar()
    if (disabled || isDrawer !== gesture.isDrawer || open !== gesture.open) return

    const x = point.clientX - gesture.start.clientX
    const y = point.clientY - gesture.start.clientY
    const completed = Math.abs(x) >= 60 && isHorizontal(x, y)
    if (!gesture.horizontal && !completed) return

    // Consume the click even if a horizontal drag falls short of toggling the sidebar.
    if (event.cancelable) event.preventDefault()
    suppressClickUntil = event.timeStamp + 500
    if (!completed || doc.querySelector(BLOCKING_OVERLAY)) return

    const nextOpen = x > 0
    if (nextOpen !== open) setOpen(nextOpen)
  }

  function onCancel() {
    swipe = undefined
    clearClickGuard()
  }

  function onClick(event: MouseEvent) {
    if (event.detail === 0 || event.timeStamp > suppressClickUntil || getSidebar().disabled) return
    clearClickGuard()
    event.preventDefault()
    event.stopImmediatePropagation()
  }

  const cancelableCapture = { capture: true, passive: false }
  doc.addEventListener('touchstart', onStart, { capture: true, passive: true })
  doc.addEventListener('touchmove', onMove, cancelableCapture)
  doc.addEventListener('touchend', onEnd, cancelableCapture)
  doc.addEventListener('touchcancel', onCancel, true)
  doc.addEventListener('pointerdown', clearClickGuard, true)
  doc.addEventListener('click', onClick, true)

  return () => {
    onCancel()
    doc.removeEventListener('touchstart', onStart, true)
    doc.removeEventListener('touchmove', onMove, true)
    doc.removeEventListener('touchend', onEnd, true)
    doc.removeEventListener('touchcancel', onCancel, true)
    doc.removeEventListener('pointerdown', clearClickGuard, true)
    doc.removeEventListener('click', onClick, true)
  }
}
