import { useNavigate } from '@tanstack/react-router'
import { Button } from '@/components/ui/button'
import { retryLocalAudio, useAppStore } from '@/store/app-store'

export function LocalAudioStatus() {
  const error = useAppStore(state => state.error)
  const importing = useAppStore(state => state.importing)
  const loading = useAppStore(state => state.loading)
  const warnings = useAppStore(state => state.warnings)
  const navigate = useNavigate()

  if (!error && !importing && !warnings.length) return null
  return (
    <div className="space-y-2 border-b p-3 text-sm" role="status" aria-live="polite">
      {importing && <p>正在扫描音频并建立音乐库，请稍候…</p>}
      {error && (
        <div className="flex items-center gap-3">
          <p className="text-destructive break-all">{error}</p>
          <Button
            size="sm"
            variant="outline"
            disabled={importing || loading}
            onClick={async () => {
              const id = await retryLocalAudio()
              if (typeof id === 'number') void navigate({ to: '/local/$folderId', params: { folderId: String(id) } })
            }}
          >
            重试
          </Button>
        </div>
      )}
      {warnings.length > 0 && (
        <details>
          <summary className="cursor-pointer">已导入，{warnings.length} 个文件的部分信息无法读取</summary>
          <ul className="max-h-40 overflow-auto break-all">
            {warnings.map((warning, index) => (
              <li key={index}>{warning}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  )
}
