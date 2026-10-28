import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Permissions } from '@sil/shared';
import { theme } from '../theme';
import { HospitalPage } from './HospitalPage';

const apiMock = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock('../api/client', async (orig) => ({ ...(await orig<typeof import('../api/client')>()), api: apiMock.api }));
const auth = vi.hoisted(() => ({ permissions: [] as string[] }));
vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'u1', permissions: auth.permissions }, can: (...p: string[]) => p.every((x) => auth.permissions.includes(x)) }),
}));

const hospital = { id: 'f1', code: 'SIL-NBI', name: 'Sample Imani Lifecare Hospital', address: 'P.O. Box 1', phone: '+254 700 000000', email: 'info@hospital.example', kraPin: 'P000000000X', hasLogo: false, mailFrom: 'Procurement <procurement@hospital.example>' };

function setup(permissions: string[]) {
  auth.permissions = permissions;
  apiMock.api.mockImplementation(async (path: string, opts?: { method?: string; body?: unknown }) => {
    if (path === '/hospital' && (opts?.method ?? 'GET') === 'GET') return hospital;
    if (path === '/hospital' && opts?.method === 'PUT') return { ...hospital, ...(opts.body as object) };
    throw new Error(`unexpected ${opts?.method ?? 'GET'} ${path}`);
  });
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <HospitalPage />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  apiMock.api.mockReset();
  auth.permissions = [];
});

describe('Hospital details', () => {
  it('lets an administrator change the name and sender', async () => {
    setup([Permissions.ORG_READ, Permissions.ORG_MANAGE]);
    const name = await screen.findByLabelText(/Hospital name/);
    expect(name).toHaveValue('Sample Imani Lifecare Hospital');
    fireEvent.change(name, { target: { value: 'Upendo Mission Hospital' } });
    fireEvent.change(screen.getByLabelText(/Sender of outgoing e-mail/), { target: { value: 'Upendo <p@upendo.example>' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(apiMock.api).toHaveBeenCalledWith('/hospital', expect.objectContaining({ method: 'PUT', body: expect.objectContaining({ name: 'Upendo Mission Hospital', mailFrom: 'Upendo <p@upendo.example>', kraPin: 'P000000000X' }) })),
    );
    expect(screen.getByRole('button', { name: /Upload logo/ })).toBeInTheDocument();
  });

  it('is read-only without org.manage', async () => {
    setup([Permissions.ORG_READ]);
    expect(await screen.findByLabelText(/Hospital name/)).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Upload logo/ })).toBeNull();
    expect(screen.getByText(/Only administrators/)).toBeInTheDocument();
  });
});

describe('Layout fixes', () => {
  it('opens right-side panels below the app bar', () => {
    const style = (theme.components?.MuiDrawer?.styleOverrides?.paperAnchorRight as (p: { theme: typeof theme }) => Record<string, unknown>)({ theme });
    expect(style).toMatchObject({ top: 56, height: 'calc(100% - 56px)' });
    expect(style[theme.breakpoints.up('sm')]).toEqual({ top: 64, height: 'calc(100% - 64px)' });
  });
});
