import { createFileRoute, Link } from '@tanstack/react-router'
import { PageLoading } from '@/components/page-loading'
import { useNetworkAudioStore } from '@/store/network-audio-store'
import { useNetworkSettings } from '@/store/network-settings'

export const Route = createFileRoute('/network/')({ component: NetworkPage })

function NetworkPage() {
  const folders = useNetworkAudioStore(state => state.folders)
  const loading = useNetworkAudioStore(state => state.loading)
  const error = useNetworkAudioStore(state => state.error)
  const serverUrl = useNetworkSettings(state => state.serverUrl)
  const token = useNetworkSettings(state => state.token)

  if (!serverUrl || !token)
    return (
      <p className="p-4">
        请先在{' '}
        <Link to="/settings" className="underline">
          App 设置
        </Link>{' '}
        中配置服务端。
      </p>
    )
  if (loading) return <PageLoading />
  if (error)
    return (
      <p role="alert" className="p-4 text-destructive break-all">
        {error}
      </p>
    )
  return (
    <div className="p-4 h-full flex flex-col justify-center items-center">
      <p>{folders.length ? '请从侧栏选择网络文件夹' : '暂无同步的文件夹，请从本地文件夹同步'}</p>
    </div>
  )
}
