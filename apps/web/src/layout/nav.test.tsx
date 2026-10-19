import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Permissions, type PermissionCode } from '@sil/shared';
import { NavList } from './AppLayout';
import { visibleNav } from './nav';

const state = vi.hoisted(() => ({ held: [] as string[] }));
vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({ can: (...p: string[]) => p.every((x) => state.held.includes(x)) }),
}));

describe('role-aware navigation', () => {
  beforeEach(() => {
    state.held = [];
  });

  it('filters items by permission', () => {
    const can = (...p: PermissionCode[]) => p.every((x) => x === Permissions.CATALOG_READ);
    const labels = visibleNav(can).map((i) => i.label);
    expect(labels).toEqual(expect.arrayContaining(['Dashboard', 'Items', 'Generics', 'My account']));
    expect(labels).not.toContain('Users');
    expect(labels).not.toContain('Bulk import');
  });

  it('shows a cashier only catalog browsing', () => {
    state.held = [Permissions.CATALOG_READ];
    render(
      <MemoryRouter>
        <NavList />
      </MemoryRouter>,
    );
    expect(screen.getByRole('link', { name: /items/i })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /users/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /stores/i })).not.toBeInTheDocument();
    expect(screen.queryByText('Administration')).toBeInTheDocument(); // "My account" lives there
  });

  it('shows administration links to an admin', () => {
    state.held = Object.values(Permissions);
    render(
      <MemoryRouter initialEntries={['/users']}>
        <NavList />
      </MemoryRouter>,
    );
    const users = screen.getByRole('link', { name: /users/i });
    expect(users).toHaveClass('Mui-selected');
    expect(screen.getByRole('link', { name: /audit log/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /bulk import/i })).toBeInTheDocument();
  });
});
