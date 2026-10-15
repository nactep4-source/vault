'use client';

import { useEffect } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';

// `/embed` hosts the public direct-stream player — it is meant to be iframed
// from other sites, so it can never depend on a signed-in session.
const PUBLIC_PATHS = ['/login', '/forgot-password', '/auth/callback', '/embed'];

function isPublicPath(pathname: string) {
  return PUBLIC_PATHS.some(
    (path) => pathname === path || pathname.startsWith(`${path}/`)
  );
}

export default function AuthGate({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { user, loading } = useAuth();
  const isPublic = isPublicPath(pathname);

  useEffect(() => {
    if (!isPublic && !loading && !user) {
      router.replace('/login');
    }
  }, [isPublic, loading, router, user]);

  if (!isPublic && (loading || !user)) {
    return null;
  }

  return children;
}