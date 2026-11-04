import { Minus, Maximize, X, RefreshCw } from 'lucide-react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { SidebarTrigger } from '@/components/ui/sidebar'
import { Button } from '@/components/ui/button'
import { isMobile } from '@/lib/platform'

const appWindow = isMobile ? undefined : getCurrentWindow()

export function AppHeader() {
  return (
    <div
      data-tauri-drag-region={isMobile ? undefined : true}
      className={`flex shrink-0 justify-between p-2 ${isMobile ? '' : 'cursor-move'}`}
      style={
        isMobile
          ? { paddingTop: 'calc(var(--android-top-inset, env(safe-area-inset-top, 0px)) + var(--spacing) * 2)' }
          : undefined
      }
    >
      <SidebarTrigger variant="outline" className="w-8 h-8" />

      <div className="flex gap-x-2">
        {import.meta.env.DEV && (
          <Button variant="ghost" size="icon" className="w-8 h-8" onClick={() => window.location.replace('/')}>
            <RefreshCw />
          </Button>
        )}

        {appWindow && (
          <>
            <Button variant="ghost" size="icon" className="w-8 h-8" onClick={() => appWindow.minimize()}>
              <Minus />
            </Button>

            <Button variant="ghost" size="icon" className="w-8 h-8" onClick={() => appWindow.toggleMaximize()}>
              <Maximize />
            </Button>

            <Button variant="ghostDestructive" size="icon" className="w-8 h-8" onClick={() => appWindow.close()}>
              <X />
            </Button>
          </>
        )}
      </div>
    </div>
  )
}
