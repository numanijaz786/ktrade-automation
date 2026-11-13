import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ApiError } from '@/lib/api/errors';
import { mockClient, renderWithClient } from '@/test/render';
import { StepUpDialog } from './step-up-dialog';

function setup(
  totpEnabled: boolean | undefined,
  stepUp = vi.fn(async () => ({ token: 'tok', expiresAt: 'x' })),
) {
  const onVerified = vi.fn();
  const onOpenChange = vi.fn();
  renderWithClient(
    <StepUpDialog open onOpenChange={onOpenChange} title="Confirm" onVerified={onVerified} />,
    mockClient({
      auth: {
        me: vi.fn(async () => ({
          id: 'u',
          email: 'e',
          displayName: 'O',
          role: 'OWNER' as const,
          totpEnabled,
        })),
        stepUp,
      },
    }),
  );
  return { onVerified, onOpenChange, stepUp };
}

describe('StepUpDialog', () => {
  it('asks for the password when TOTP is not enabled and passes the token on (memory only)', async () => {
    const user = userEvent.setup();
    const { onVerified, onOpenChange, stepUp } = setup(false);
    const dialog = await screen.findByRole('dialog');
    const input = await within(dialog).findByLabelText('Account password');
    expect(input).toHaveAttribute('type', 'password');
    expect(within(dialog).getByText(/Two-factor authentication is off/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Confirm' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Enter your account password');
    expect(stepUp).not.toHaveBeenCalled();
    await user.type(input, '123456');
    await user.click(within(dialog).getByRole('button', { name: 'Confirm' }));
    // A 6-digit password is still sent as a password, never guessed to be a TOTP code.
    await waitFor(() => expect(stepUp).toHaveBeenCalledWith({ password: '123456' }));
    expect(onVerified).toHaveBeenCalledWith('tok');
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
  });

  it('uses the authenticator code when TOTP is enabled', async () => {
    const user = userEvent.setup();
    const { stepUp } = setup(true);
    const input = await screen.findByLabelText('Authenticator code');
    await user.type(input, '12ab3456');
    expect(input).toHaveValue('123456');
    await user.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(stepUp).toHaveBeenCalledWith({ totpCode: '123456' }));
  });

  it('shows a wrong password and keeps the dialog open', async () => {
    const user = userEvent.setup();
    const { onVerified } = setup(
      false,
      vi.fn(async () => {
        throw new ApiError('STEP_UP_FAILED', 401, 'Verification failed', 'Wrong password');
      }),
    );
    await user.type(await screen.findByLabelText('Account password'), 'nope-nope');
    await user.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Wrong password');
    expect(onVerified).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});
