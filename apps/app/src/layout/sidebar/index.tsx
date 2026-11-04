import { useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from '@tanstack/react-router'
import { ChevronRight, Cloud, Folder, LoaderCircle, Play, Plus, RefreshCw, Settings } from 'lucide-react'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  useSidebar
} from '@/components/ui/sidebar'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { useAppStore, importLocalFolder } from '@/store/app-store'
import { usePlayerOpen } from '@/store/audio-store'
import { playAllLocalAudios } from '@/store/local-audio-store'
import { loadNetworkFolders, playAllNetworkAudios, useNetworkAudioStore } from '@/store/network-audio-store'
import { useNetworkSettings } from '@/store/network-settings'
import { LocalFolderItem } from './local-folder-item'
import { NetworkFolderItem } from './network-folder-item'
import { connectionSignal } from '@/api'
import { isIOS, isMobile as isMobilePlatform } from '@/lib/platform'

export function AppSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
  const pathname = useLocation({ select: location => location.pathname })
  const navigate = useNavigate()
  const { isMobile, setOpenMobile } = useSidebar()
  const navigateFromSidebar: typeof navigate = options => {
    if (isMobile) setOpenMobile(false)
    return navigate(options)
  }

  const localFolderList = useAppStore(state => state.localFolderList)
  const playerOpen = usePlayerOpen()
  const importing = useAppStore(state => state.importing)
  const loading = useAppStore(state => state.loading)
  const inited = useAppStore(state => state.inited)
  const removing = useAppStore(state => state.removingFolderIds.length > 0)
  const [playingAll, setPlayingAll] = useState(false)
  const [playAllError, setPlayAllError] = useState<string>()
  const playAllPending = useRef(false)
  const [playingAllNetwork, setPlayingAllNetwork] = useState(false)
  const [networkPlayAllError, setNetworkPlayAllError] = useState<{ message: string; signal: AbortSignal }>()
  const networkPlayAllPending = useRef(false)
  const networkFolders = useNetworkAudioStore(state => state.folders)
  const networkLoading = useNetworkAudioStore(state => state.loading)
  const networkError = useNetworkAudioStore(state => state.error)
  const serverUrl = useNetworkSettings(state => state.serverUrl)
  const token = useNetworkSettings(state => state.token)
  useEffect(() => {
    if (serverUrl && token) void loadNetworkFolders()
  }, [serverUrl, token])

  async function handlePlayAll() {
    if (playAllPending.current || !inited || loading || importing || !localFolderList.length) return
    playAllPending.current = true
    setPlayingAll(true)
    setPlayAllError(undefined)
    try {
      await playAllLocalAudios()
    } catch (error) {
      setPlayAllError(error instanceof Error ? error.message : String(error))
    } finally {
      playAllPending.current = false
      setPlayingAll(false)
    }
  }

  async function handlePlayAllNetwork() {
    if (networkPlayAllPending.current || networkLoading || !serverUrl || !token || !networkFolders.length) return
    networkPlayAllPending.current = true
    const signal = connectionSignal()
    setPlayingAllNetwork(true)
    setNetworkPlayAllError(undefined)
    try {
      await playAllNetworkAudios()
    } catch (error) {
      if (!signal.aborted)
        setNetworkPlayAllError({ message: error instanceof Error ? error.message : String(error), signal })
    } finally {
      networkPlayAllPending.current = false
      setPlayingAllNetwork(false)
    }
  }

  return (
    <Sidebar {...props}>
      {isMobilePlatform && (
        <div
          aria-hidden="true"
          className="shrink-0"
          style={{ height: 'var(--android-top-inset, env(safe-area-inset-top, 0px))' }}
        />
      )}
      <SidebarContent>
        <SidebarGroup>
          <SidebarMenu>
            <Collapsible defaultOpen className="group/collapsible">
              <SidebarMenuItem>
                <CollapsibleTrigger asChild>
                  <SidebarMenuButton className="pr-16!">
                    <Folder />
                    <span>本地</span>
                    <ChevronRight className="ml-auto transition-transform group-data-[state=open]/collapsible:rotate-90" />
                  </SidebarMenuButton>
                </CollapsibleTrigger>
                <Button
                  variant="outline"
                  size="icon-xs"
                  className="absolute right-8 top-2.5 md:top-1"
                  title="播放全部"
                  disabled={!inited || loading || importing || playingAll || !localFolderList.length}
                  onClick={handlePlayAll}
                >
                  {playingAll ? <LoaderCircle className="size-4 animate-spin" /> : <Play className="size-4" />}
                </Button>
                <Button
                  variant="outline"
                  size="icon-xs"
                  className="absolute right-1 top-2.5 md:top-1"
                  title="导入文件夹"
                  disabled={importing || loading || removing}
                  onClick={async () => {
                    const folderId = await importLocalFolder()
                    if (folderId == null) return
                    void navigateFromSidebar({ to: '/local/$folderId', params: { folderId: String(folderId) } })
                  }}
                >
                  {importing ? <LoaderCircle className="size-4 animate-spin" /> : <Plus className="size-4" />}
                </Button>
                {playAllError && (
                  <p className="px-2 py-1 text-sm text-destructive break-all md:text-xs">{playAllError}</p>
                )}
                <CollapsibleContent>
                  <SidebarMenuSub>
                    {localFolderList?.map(folder => (
                      <LocalFolderItem key={folder.id} folder={folder} onNavigate={navigateFromSidebar} />
                    ))}
                    {!localFolderList?.length && <p className="text-base md:text-sm">暂无导入</p>}
                  </SidebarMenuSub>
                </CollapsibleContent>
              </SidebarMenuItem>
            </Collapsible>
            <Collapsible defaultOpen className="group/network">
              <SidebarMenuItem>
                <CollapsibleTrigger asChild>
                  <SidebarMenuButton className="pr-16!">
                    <Cloud />
                    <span>网络</span>
                    <ChevronRight className="ml-auto transition-transform group-data-[state=open]/network:rotate-90" />
                  </SidebarMenuButton>
                </CollapsibleTrigger>
                <Button
                  variant="outline"
                  size="icon-xs"
                  className="absolute right-8 top-2.5 md:top-1"
                  title="播放全部"
                  disabled={networkLoading || playingAllNetwork || !serverUrl || !token || !networkFolders.length}
                  onClick={handlePlayAllNetwork}
                >
                  {playingAllNetwork ? <LoaderCircle className="size-4 animate-spin" /> : <Play className="size-4" />}
                </Button>
                <Button
                  variant="outline"
                  size="icon-xs"
                  className="absolute right-1 top-2.5 md:top-1"
                  title="刷新网络文件夹"
                  disabled={networkLoading || !serverUrl || !token}
                  onClick={() => void loadNetworkFolders()}
                >
                  {networkLoading ? <LoaderCircle className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
                </Button>
                {networkPlayAllError && !networkPlayAllError.signal.aborted && (
                  <p role="alert" className="px-2 py-1 text-sm text-destructive break-all md:text-xs">
                    {networkPlayAllError.message}
                  </p>
                )}
                <CollapsibleContent>
                  <SidebarMenuSub>
                    {networkFolders.map(folder => (
                      <NetworkFolderItem key={folder.id} folder={folder} onNavigate={navigateFromSidebar} />
                    ))}
                    {(!serverUrl || !token) && (
                      <SidebarMenuSubButton
                        className="cursor-pointer"
                        onClick={() => void navigateFromSidebar({ to: '/settings' })}
                      >
                        请先配置服务端
                      </SidebarMenuSubButton>
                    )}
                    {serverUrl && token && !networkLoading && !networkError && !networkFolders.length && (
                      <p className="text-base md:text-sm">暂无同步的文件夹</p>
                    )}
                    {networkError && (
                      <p role="alert" className="text-sm text-destructive break-all md:text-xs">
                        {networkError}
                      </p>
                    )}
                  </SidebarMenuSub>
                </CollapsibleContent>
              </SidebarMenuItem>
            </Collapsible>
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter className="shrink-0">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              isActive={pathname === '/settings'}
              onClick={() => void navigateFromSidebar({ to: '/settings' })}
            >
              <Settings />
              <span>App 设置</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      {!isMobile && playerOpen && (
        <div className={isIOS ? 'h-[calc(5rem+env(safe-area-inset-bottom))] shrink-0' : 'h-20 shrink-0'} />
      )}
    </Sidebar>
  )
}
