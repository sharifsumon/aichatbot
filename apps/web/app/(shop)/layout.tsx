import type { ReactNode } from 'react';
import { Shell } from '@/components/Shell';

export default function ShopLayout({ children }: { children: ReactNode }) {
  return <Shell>{children}</Shell>;
}
