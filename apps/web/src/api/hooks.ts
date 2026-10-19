import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Paginated } from '@sil/shared';
import { useNotify } from '../components/Notify';
import { api, ApiError, RequestOptions } from './client';

type Params = Record<string, string | number | boolean | null | undefined>;

/** Server-paginated list (DataGrid page is 0-based, API page is 1-based). */
export function usePaged<T>(path: string, params: Params & { page: number; pageSize: number }, enabled = true) {
  return useQuery({
    queryKey: [path, params],
    queryFn: () => api<Paginated<T>>(path, { query: { ...params, page: params.page + 1 } }),
    placeholderData: keepPreviousData,
    enabled,
  });
}

export function useList<T>(path: string, params?: Params, enabled = true) {
  return useQuery({
    queryKey: [path, params ?? {}],
    queryFn: () => api<T[]>(path, { query: params }),
    staleTime: 60_000,
    enabled,
  });
}

/** For endpoints that are paginated but where a short full list is wanted (selects). */
export function useAll<T>(path: string, params?: Params, enabled = true) {
  return useQuery({
    queryKey: [path, 'all', params ?? {}],
    queryFn: async () => (await api<Paginated<T>>(path, { query: { pageSize: 500, ...params } })).items,
    staleTime: 60_000,
    enabled,
  });
}

/**
 * Mutation that shows success/error snackbars and invalidates every query
 * whose key starts with one of `invalidate` (API paths).
 */
export function useApiMutation<TVars, TResult = unknown>(
  request: (vars: TVars) => [string, RequestOptions],
  { invalidate = [], success }: { invalidate?: string[]; success?: string } = {},
) {
  const qc = useQueryClient();
  const notify = useNotify();
  return useMutation<TResult, ApiError, TVars>({
    mutationFn: (vars) => {
      const [path, options] = request(vars);
      return api<TResult>(path, options);
    },
    onSuccess: async () => {
      await Promise.all(
        invalidate.map((p) => qc.invalidateQueries({ predicate: (q) => String(q.queryKey[0]).startsWith(p) })),
      );
      if (success) notify.success(success);
    },
    onError: (err) => notify.error(err.message),
  });
}
