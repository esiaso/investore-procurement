import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { LoginForm, TotpForm } from './LoginForm';

describe('LoginForm', () => {
  it('validates required fields before submitting', async () => {
    const onSubmit = vi.fn();
    render(<LoginForm onSubmit={onSubmit} />);
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }));
    expect(await screen.findByText('Username is required')).toBeInTheDocument();
    expect(screen.getByText('Password is required')).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('submits trimmed credentials with the Enter key', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<LoginForm onSubmit={onSubmit} />);
    await userEvent.type(screen.getByLabelText(/username/i), '  pharmacist ');
    await userEvent.type(screen.getByLabelText(/password/i), 'Secret#Pass1{Enter}');
    expect(onSubmit).toHaveBeenCalledWith({ username: 'pharmacist', password: 'Secret#Pass1' });
  });

  it('shows the server error message', async () => {
    const onSubmit = vi.fn().mockRejectedValue(new Error('Invalid username or password'));
    render(<LoginForm onSubmit={onSubmit} />);
    await userEvent.type(screen.getByLabelText(/username/i), 'x');
    await userEvent.type(screen.getByLabelText(/password/i), 'y{Enter}');
    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid username or password');
  });
});

describe('TotpForm', () => {
  it('accepts only a 6-digit code', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<TotpForm onSubmit={onSubmit} onCancel={() => {}} />);
    const input = screen.getByLabelText(/authentication code/i);
    await userEvent.type(input, '12ab{Enter}');
    expect(await screen.findByText('Enter the 6-digit code')).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();

    await userEvent.clear(input);
    await userEvent.type(input, '123456{Enter}');
    expect(onSubmit).toHaveBeenCalledWith('123456');
  });

  it('goes back to the password step', async () => {
    const onCancel = vi.fn();
    render(<TotpForm onSubmit={vi.fn()} onCancel={onCancel} />);
    await userEvent.click(screen.getByRole('button', { name: /back/i }));
    expect(onCancel).toHaveBeenCalled();
  });
});
