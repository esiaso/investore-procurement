import { useQuery } from '@tanstack/react-query';
import { createContext, ReactNode, useContext } from 'react';
import type { PublicSettings } from '@sil/shared';
import { api } from '../api/client';

/** Used only until the server answers; real values come from system_setting. */
const FALLBACK: PublicSettings = {
  currency: 'KES',
  timezone: 'Africa/Nairobi',
  dateFormat: 'DD/MM/YYYY',
  financialYearStartMonth: 1,
  passwordPolicy: { minLength: 12, requireUppercase: true, requireLowercase: true, requireDigit: true, requireSymbol: true },
};

const SettingsContext = createContext<PublicSettings>(FALLBACK);

export function SettingsProvider({ children }: { children: ReactNode }) {
  const { data } = useQuery({
    queryKey: ['settings', 'public'],
    queryFn: () => api<PublicSettings>('/settings/public'),
    staleTime: 10 * 60_000,
  });
  return <SettingsContext.Provider value={data ?? FALLBACK}>{children}</SettingsContext.Provider>;
}

export const useSettings = () => useContext(SettingsContext);
