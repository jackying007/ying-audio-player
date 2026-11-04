import { isIOS } from '@/lib/platform'
import { Outlet } from '@tanstack/react-router'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar'
import { Separator } from '@/components/ui/separator'
import { usePlayerOpen } from '@/store/audio-store'
import { AppSidebar } from './sidebar'
import { AppHeader } from './header'
import { LocalAudioStatus } from './local-audio-status'
import { AudioPlayer } from './audio-player'
import { AndroidNavigation } from './android-navigation'

export function AppLayout() {
  const playerOpen = usePlayerOpen()

  return (
    <TooltipProvider>
      <AndroidNavigation />
      <Toaster />
      <SidebarProvider className={isIOS ? 'pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)]' : undefined}>
        <AppSidebar />
        <SidebarInset className="h-svh">
          <AppHeader />
          <Separator />
          <main className="flex-1 h-0">
            <LocalAudioStatus />
            <Outlet />
          </main>
          {playerOpen && <div className={isIOS ? 'h-[calc(5rem+env(safe-area-inset-bottom))] shrink-0' : 'h-20'} />}
        </SidebarInset>
        <AudioPlayer />
      </SidebarProvider>
    </TooltipProvider>
  )
}
