import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, ReactNode, useCallback, useContext, useMemo } from 'react';
import type { LoginResponse, PermissionCode, SessionUser } from '@sil/shared';
import { api, ApiError, setCsrfToken } from '../api/client';

export const ME_KEY = ['auth', 'me'];

interface AuthApi {
  user: SessionUser | null;
  loading: boolean;
  login(username: string, password: string): Promise<LoginResponse>;
  verifyTotp(code: string): Promise<LoginResponse>;
  logout(): Promise<void>;
  refresh(): Promise<void>;
  can(...permissions: PermissionCode[]): boolean;
}

const AuthContext = createContext<AuthApi | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const me = useQuery({
    queryKey: ME_KEY,
    queryFn: async () => {
      try {
        return await api<SessionUser>('/auth/me');
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return null;
        throw e;
      }
    },
    staleTime: 5 * 60_000,
    retry: false,
  });

  const finish = useCallback(
    (res: LoginResponse) => {
      setCsrfToken(res.csrfToken);
      if (res.user) qc.setQueryData(ME_KEY, res.user);
      return res;
    },
    [qc],
  );

  const value = useMemo<AuthApi>(() => {
    const user = me.data ?? null;
    const held = new Set(user?.permissions ?? []);
    return {
      user,
      loading: me.isLoading,
      login: async (username, password) =>
        finish(await api<LoginResponse>('/auth/login', { method: 'POST', body: { username, password } })),
      verifyTotp: async (code) => finish(await api<LoginResponse>('/auth/2fa/verify', { method: 'POST', body: { code } })),
      logout: async () => {
        await api('/auth/logout', { method: 'POST' }).catch(() => undefined);
        setCsrfToken(null);
        qc.clear();
        qc.setQueryData(ME_KEY, null);
      },
      refresh: async () => {
        await qc.invalidateQueries({ queryKey: ME_KEY });
      },
      can: (...permissions) => permissions.every((p) => held.has(p)),
    };
  }, [me.data, me.isLoading, finish, qc]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthApi {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth outside AuthProvider');
  return ctx;
}
