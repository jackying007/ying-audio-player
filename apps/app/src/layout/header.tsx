import { Minus, Maximize, X, RefreshCw } from 'lucide-react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { SidebarTrigger } from '@/components/ui/sidebar'
import { Button } from '@/components/ui/button'

const appWindow = getCurrentWindow()

export function AppHeader() {
  return (
    <div data-tauri-drag-region className="flex justify-between p-2 cursor-move">
      <SidebarTrigger variant="ghost" className="w-8 h-8" />

      <div className="flex gap-x-2">
        {import.meta.env.DEV && (
          <Button variant="ghost" size="icon" className="w-8 h-8" onClick={() => window.location.replace('/')}>
            <RefreshCw />
          </Button>
        )}

        <Button variant="ghost" size="icon" className="w-8 h-8" onClick={() => appWindow.minimize()}>
          <Minus />
        </Button>

        <Button variant="ghost" size="icon" className="w-8 h-8" onClick={() => appWindow.toggleMaximize()}>
          <Maximize />
        </Button>

        <Button variant="ghostDestructive" size="icon" className="w-8 h-8" onClick={() => appWindow.close()}>
          <X />
        </Button>
      </div>
    </div>
  )
}
