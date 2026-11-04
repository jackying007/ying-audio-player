import { Toaster as Sonner, type ToasterProps } from 'sonner'

function Toaster({ style, ...props }: ToasterProps) {
  return <Sonner className="toaster group" richColors style={{ fontFamily: 'inherit', ...style }} {...props} />
}

export { Toaster }
