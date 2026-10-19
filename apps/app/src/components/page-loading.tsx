import { Skeleton } from './ui/skeleton'

export const PageLoading = () => {
  return (
    <div className="p-2 flex flex-col gap-2">
      {Array.from({ length: 18 }).map((_, i) => (
        <Skeleton className="h-8" key={i} />
      ))}
    </div>
  )
}
