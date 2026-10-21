import { useState } from 'react'
import { useLocation, useNavigate, useRouter } from '@tanstack/react-router'
import { confirm } from '@tauri-apps/plugin-dialog'
import { LoaderCircle, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { connectionSignal, type NetworkFolder } from '@/api'
import { Button } from '@/components/ui/button'
import { SidebarMenuSubButton, SidebarMenuSubItem } from '@/components/ui/sidebar'
import { useAppStore } from '@/store/app-store'
import { removeNetworkFolder, useNetworkAudioStore } from '@/store/network-audio-store'

export function NetworkFolderItem({
  folder,
  onNavigate
}: {
  folder: NetworkFolder
  onNavigate: ReturnType<typeof useNavigate>
}) {
  const router = useRouter()
  const pathname = useLocation({ select: location => location.pathname })
  const localFolders = useAppStore(state => state.localFolderList)
  const syncing = useNetworkAudioStore(state =>
    localFolders.some(local => local.name === folder.name && state.syncs[String(local.id)]?.running)
  )
  const removing = useNetworkAudioStore(state => state.removingFolders.some(item => item.id === folder.id))
  const [confirming, setConfirming] = useState(false)

  async function handleRemove() {
    if (confirming || removing || syncing) return
    const signal = connectionSignal()
    setConfirming(true)
    try {
      const accepted = await confirm(
        `确定删除网络文件夹“${folder.name}”？云端文件夹及其中全部音频、歌词、封面和上传暂存资源将被删除，无法恢复。本地原始文件和已下载的磁盘缓存会保留。`,
        { title: '删除网络文件夹', kind: 'warning', okLabel: '删除', cancelLabel: '取消' }
      )
      if (!accepted || signal.aborted || !(await removeNetworkFolder(folder.id))) return
      if (router.state.location.pathname === `/network/${folder.id}`) {
        await onNavigate({ to: '/network', replace: true })
      }
    } catch (error) {
      toast.error(`删除失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setConfirming(false)
    }
  }

  return (
    <SidebarMenuSubItem className="group/network-folder relative">
      <SidebarMenuSubButton
        className="cursor-pointer pr-8"
        isActive={pathname === `/network/${folder.id}`}
        onClick={() => void onNavigate({ to: '/network/$folderId', params: { folderId: String(folder.id) } })}
      >
        <span>{folder.name}</span>
      </SidebarMenuSubButton>
      <Button
        type="button"
        variant="ghostDestructive"
        size="icon-sm"
        className="absolute right-1 top-0.5 size-7 text-muted-foreground opacity-0 group-hover/network-folder:opacity-100 group-focus-within/network-folder:opacity-100 disabled:opacity-0 group-hover/network-folder:disabled:opacity-50 group-focus-within/network-folder:disabled:opacity-50"
        title="删除云端文件夹及全部资源"
        disabled={removing || syncing || confirming}
        onClick={() => void handleRemove()}
      >
        {removing ? <LoaderCircle className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
      </Button>
    </SidebarMenuSubItem>
  )
}
