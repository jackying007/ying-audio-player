import { createFileRoute, Navigate } from '@tanstack/react-router'
import { Button } from '@/components/ui/button'
import { PageLoading } from '@/components/page-loading'
import { useAppStore, importLocalFolder } from '@/store/app-store'
import { useNetworkAudioStore } from '@/store/network-audio-store'

export const Route = createFileRoute('/local/')({ component: LocalPage })

function LocalPage() {
  const inited = useAppStore(state => state.inited)
  const localFolderList = useAppStore(state => state.localFolderList)
  const importing = useAppStore(state => state.importing)
  const error = useAppStore(state => state.error)
  const networkFolders = useNetworkAudioStore(state => state.folders)
  const networkLoading = useNetworkAudioStore(state => state.loading)
  const navigate = Route.useNavigate()

  if (!inited) return <PageLoading />
  if (error) return null
  if (localFolderList?.length)
    return <Navigate to="/local/$folderId" params={{ folderId: String(localFolderList[0].id) }} replace />
  if (networkLoading) return <PageLoading />
  if (networkFolders.length)
    return <Navigate to="/network/$folderId" params={{ folderId: String(networkFolders[0].id) }} replace />
  return (
    <div className="p-2 h-full flex flex-col justify-center items-center">
      <p className="mb-4 text-md">暂无已导入的文件夹</p>
      <Button
        variant="default"
        disabled={importing}
        onClick={async () => {
          const id = await importLocalFolder()
          if (id != null) void navigate({ to: '/local/$folderId', params: { folderId: String(id) } })
        }}
      >
        {importing ? '正在导入…' : '导入'}
      </Button>
    </div>
  )
}
