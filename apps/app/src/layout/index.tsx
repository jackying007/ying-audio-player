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

export function AppLayout() {
  const playerOpen = usePlayerOpen()

  return (
    <TooltipProvider>
      <Toaster />
      <SidebarProvider>
        <AppSidebar />
        <SidebarInset className="h-svh">
          <AppHeader />
          <Separator />
          <main className="flex-1 h-0">
            <LocalAudioStatus />
            <Outlet />
          </main>
          {playerOpen && <div className="h-20 " />}
        </SidebarInset>
        <AudioPlayer />
      </SidebarProvider>
    </TooltipProvider>
  )
}
