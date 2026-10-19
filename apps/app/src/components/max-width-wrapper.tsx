import type { PropsWithChildren } from 'react'
import { cn } from 'cn'

export const MaxWidthWrapper = ({
  children,
  className
}: PropsWithChildren & {
  className?: string
}) => {
  return <div className={cn('h-full mx-auto w-full max-w-7xl px-2.5 md:px-20', className)}>{children}</div>
}
