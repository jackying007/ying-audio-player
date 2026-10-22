import { useState } from 'react'
import { useLocation, useNavigate, useRouter } from '@tanstack/react-router'
import { confirm } from '@tauri-apps/plugin-dialog'
import { LoaderCircle, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { SidebarMenuSubButton, SidebarMenuSubItem } from '@/components/ui/sidebar'
import type { LocalAudioFolder } from '@/lib/local-audio'
import { useAppStore } from '@/store/app-store'
import { removeLocalFolder, useLocalAudioStore } from '@/store/local-audio-store'
import { useNetworkAudioStore } from '@/store/network-audio-store'

export function LocalFolderItem({
  folder,
  onNavigate
}: {
  folder: LocalAudioFolder
  onNavigate: ReturnType<typeof useNavigate>
}) {
  const router = useRouter()
  const pathname = useLocation({ select: location => location.pathname })
  const busy = useAppStore(state => state.loading || state.importing || state.removingFolderIds.includes(folder.id))
  const refreshing = useLocalAudioStore(state => state[String(folder.id)]?.refreshing)
  const syncing = useNetworkAudioStore(state => state.syncs[String(folder.id)]?.running)
  const removing = useAppStore(state => state.removingFolderIds.includes(folder.id))
  const [confirming, setConfirming] = useState(false)

  async function handleRemove() {
    if (confirming || busy || refreshing || syncing) return
    setConfirming(true)
    try {
      const accepted = await confirm(
        `确定移除文件夹“${folder.name}”？仅移除导入记录和歌曲索引，磁盘原文件及已同步的云端歌曲会保留，可随时重新导入。`,
        { title: '删除本地文件夹', kind: 'warning', okLabel: '移除', cancelLabel: '取消' }
      )
      if (!accepted || !(await removeLocalFolder(folder.id))) return
      if (router.state.location.pathname === `/local/${folder.id}`) {
        await onNavigate({ to: '/local', replace: true })
      }
    } catch (error) {
      toast.error(`移除失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setConfirming(false)
    }
  }

  return (
    <SidebarMenuSubItem className="group/local-folder relative">
      <SidebarMenuSubButton
        className="cursor-pointer pr-8"
        isActive={pathname === `/local/${folder.id}`}
        onClick={() => void onNavigate({ to: '/local/$folderId', params: { folderId: String(folder.id) } })}
      >
        <span>{folder.name}</span>
      </SidebarMenuSubButton>
      <Button
        type="button"
        variant="ghostDestructive"
        size="icon-sm"
        className="absolute right-1 top-0.5 size-7 text-muted-foreground [@media(hover:none)]:opacity-100 [@media(hover:none)]:disabled:opacity-50 opacity-0 group-hover/local-folder:opacity-100 group-focus-within/local-folder:opacity-100 disabled:opacity-0 group-hover/local-folder:disabled:opacity-50 group-focus-within/local-folder:disabled:opacity-50"
        title="移除导入记录，保留原文件"
        disabled={busy || refreshing || syncing || confirming}
        onClick={() => void handleRemove()}
      >
        {removing ? <LoaderCircle className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
      </Button>
    </SidebarMenuSubItem>
  )
}
