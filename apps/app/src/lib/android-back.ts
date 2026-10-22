type BackActions = {
  dismissOverlay: () => boolean
  closePlayer: () => boolean
  canGoBack: boolean
  goBack: () => void
  exit: () => void
}

export function handleAndroidBack(actions: BackActions) {
  if (actions.dismissOverlay() || actions.closePlayer()) return
  if (actions.canGoBack) actions.goBack()
  else actions.exit()
}

export function dismissAndroidOverlay() {
  if (
    !document.querySelector(
      '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"], [role="menu"][data-state="open"], [role="listbox"][data-state="open"]'
    )
  )
    return false
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
  return true
}
