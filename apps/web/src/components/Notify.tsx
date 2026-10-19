import { Alert, Snackbar } from '@mui/material';
import { createContext, ReactNode, useCallback, useContext, useMemo, useState } from 'react';

interface Message {
  key: number;
  severity: 'success' | 'error' | 'info';
  text: string;
}

interface NotifyApi {
  success(text: string): void;
  error(text: string): void;
  info(text: string): void;
}

const NotifyContext = createContext<NotifyApi>({ success: () => {}, error: () => {}, info: () => {} });

export function NotifyProvider({ children }: { children: ReactNode }) {
  const [message, setMessage] = useState<Message | null>(null);
  const push = useCallback(
    (severity: Message['severity']) => (text: string) => setMessage({ key: Date.now(), severity, text }),
    [],
  );
  const value = useMemo(() => ({ success: push('success'), error: push('error'), info: push('info') }), [push]);

  return (
    <NotifyContext.Provider value={value}>
      {children}
      <Snackbar
        key={message?.key}
        open={!!message}
        autoHideDuration={message?.severity === 'error' ? 8000 : 3000}
        onClose={(_, reason) => reason !== 'clickaway' && setMessage(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        {message ? (
          <Alert severity={message.severity} variant="filled" onClose={() => setMessage(null)} sx={{ width: '100%' }}>
            {message.text}
          </Alert>
        ) : undefined}
      </Snackbar>
    </NotifyContext.Provider>
  );
}

export const useNotify = () => useContext(NotifyContext);
