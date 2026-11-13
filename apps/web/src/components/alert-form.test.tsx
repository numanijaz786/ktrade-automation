import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ALERT_KINDS, validateAlertForm, type AlertFormValues } from '@/lib/alerts';
import type { Alert, AlertInput, Portfolio } from '@/lib/api/types';
import { mockClient, renderWithClient } from '@/test/render';
import { AlertForm } from './alert-form';

const base: AlertFormValues = {
  type: 'PRICE_ABOVE',
  symbol: 'ogdc',
  portfolioId: '',
  value: '271.50',
  cooldownMinutes: '60',
  triggerOnce: false,
  active: true,
  channels: ['IN_APP'],
};

const errorsOf = (v: Partial<AlertFormValues>) => {
  const r = validateAlertForm({ ...base, ...v });
  return r.ok ? {} : r.errors;
};

describe('validateAlertForm — per type', () => {
  it('builds the typed params for every alert type', () => {
    const expected: Record<string, [string, Record<string, string>]> = {
      PRICE_ABOVE: ['price', { price: '12.5' }],
      PRICE_BELOW: ['price', { price: '12.5' }],
      PCT_CHANGE_ABOVE: ['pct', { pct: '12.5' }],
      PCT_CHANGE_BELOW: ['pct', { pct: '12.5' }],
      VOLUME_SPIKE: ['multiple', { multiple: '12.5' }],
      PORTFOLIO_DAILY_LOSS: ['pct', { pct: '12.5' }],
      POSITION_STOP_LOSS: ['pct', { pct: '12.5' }],
    };
    for (const type of ALERT_KINDS) {
      const r = validateAlertForm({ ...base, type, value: ' 12.5 ', portfolioId: 'p1' });
      expect(r.ok, type).toBe(true);
      if (!r.ok) continue;
      expect(r.input.params).toEqual(expected[type][1]);
      expect('symbol' in r.input).toBe(type !== 'PORTFOLIO_DAILY_LOSS');
      expect('portfolioId' in r.input).toBe(type === 'PORTFOLIO_DAILY_LOSS' || type === 'POSITION_STOP_LOSS');
    }
    const ok = validateAlertForm(base);
    expect(ok.ok && ok.input).toMatchObject({ symbol: 'OGDC', cooldownMinutes: 60, channels: ['IN_APP'] });
  });

  it('rejects non-decimal strings before any numeric comparison', () => {
    for (const type of ALERT_KINDS)
      for (const value of ['abc', '1e3', '12.', '', '1,000', '0x10'])
        expect(errorsOf({ type, value, portfolioId: 'p1' }).value, `${type} ${value}`).toMatch(
          /Enter a number/,
        );
  });

  it('requires a positive value for every type', () => {
    for (const type of ALERT_KINDS)
      for (const value of ['0', '0.000', '-5'])
        expect(errorsOf({ type, value, portfolioId: 'p1' }).value, `${type} ${value}`).toBe(
          'Must be greater than zero',
        );
  });

  it('applies the per-type upper bounds exactly as the API does', () => {
    expect(errorsOf({ type: 'PRICE_ABOVE', value: '99999.99' }).value).toBeUndefined();
    expect(errorsOf({ type: 'PCT_CHANGE_ABOVE', value: '1000' }).value).toBeUndefined();
    expect(errorsOf({ type: 'PCT_CHANGE_ABOVE', value: '1000.01' }).value).toBe('Must be at most 1000');
    expect(errorsOf({ type: 'VOLUME_SPIKE', value: '1000.0001' }).value).toBe('Must be at most 1000');
    for (const type of ['PCT_CHANGE_BELOW', 'PORTFOLIO_DAILY_LOSS', 'POSITION_STOP_LOSS'] as const) {
      expect(errorsOf({ type, value: '99.9999', portfolioId: 'p1' }).value).toBeUndefined();
      expect(errorsOf({ type, value: '100', portfolioId: 'p1' }).value).toBe('Must be below 100');
    }
  });

  it('checks the target, cooldown and channels', () => {
    expect(errorsOf({ symbol: '' }).symbol).toMatch(/PSX symbol/);
    expect(errorsOf({ symbol: 'BAD SYMBOL' }).symbol).toMatch(/PSX symbol/);
    expect(errorsOf({ type: 'PORTFOLIO_DAILY_LOSS', symbol: '', value: '2' }).portfolioId).toBe(
      'Pick a portfolio',
    );
    expect(errorsOf({ type: 'PORTFOLIO_DAILY_LOSS', symbol: '', value: '2', portfolioId: 'p1' })).toEqual({});
    expect(errorsOf({ type: 'POSITION_STOP_LOSS', value: '5' }).portfolioId).toBe('Pick a portfolio');
    for (const c of ['0', '10081', '1.5', 'x', ''])
      expect(errorsOf({ cooldownMinutes: c }).cooldownMinutes, c).toMatch(/Whole minutes/);
    expect(errorsOf({ cooldownMinutes: '10080' }).cooldownMinutes).toBeUndefined();
    expect(errorsOf({ channels: [] }).channels).toBe('Pick at least one channel');
  });
});

const portfolios: Portfolio[] = [
  { id: 'p1', name: 'Live', kind: 'LIVE', costBasisMethod: 'WEIGHTED_AVERAGE', demo: false },
];

describe('AlertForm', () => {
  it('shows per-field errors and creates a typed alert; email/telegram are disabled', async () => {
    const create = vi.fn(async (i: AlertInput) => ({ id: 'a1', ...i }) as unknown as Alert);
    const onDone = vi.fn();
    renderWithClient(
      <AlertForm portfolios={portfolios} defaultSymbol="OGDC" onDone={onDone} />,
      mockClient({ alerts: { create } }),
    );
    expect(screen.getByRole('checkbox', { name: 'Email (not configured)' })).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: 'Telegram (not configured)' })).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: 'In-app' })).toBeChecked();

    await userEvent.type(screen.getByLabelText('Price (Rs)'), '12.3.4');
    await userEvent.clear(screen.getByLabelText('Cooldown (minutes)'));
    await userEvent.type(screen.getByLabelText('Cooldown (minutes)'), '0');
    await userEvent.click(screen.getByRole('button', { name: 'Create alert' }));
    expect(await screen.findByText('Enter a number, e.g. 150.50')).toBeInTheDocument();
    expect(screen.getByText(/Whole minutes from 1 to 10080/)).toBeInTheDocument();
    expect(create).not.toHaveBeenCalled();

    await userEvent.clear(screen.getByLabelText('Price (Rs)'));
    await userEvent.type(screen.getByLabelText('Price (Rs)'), '300');
    await userEvent.clear(screen.getByLabelText('Cooldown (minutes)'));
    await userEvent.type(screen.getByLabelText('Cooldown (minutes)'), '15');
    await userEvent.click(screen.getByRole('checkbox', { name: /Trigger once/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Create alert' }));
    await waitFor(() =>
      expect(create).toHaveBeenCalledWith({
        type: 'PRICE_ABOVE',
        symbol: 'OGDC',
        params: { price: '300' },
        channels: ['IN_APP'],
        cooldownMinutes: 15,
        triggerOnce: true,
        active: true,
      }),
    );
    await waitFor(() => expect(onDone).toHaveBeenCalled());
  });

  it('edits only the mutable fields of an existing alert', async () => {
    const alert: Alert = {
      id: 'a9',
      type: 'PORTFOLIO_DAILY_LOSS',
      symbol: null,
      portfolio: { id: 'p1', name: 'Live' },
      params: { pct: '1.5' },
      threshold: '1.5',
      channels: ['IN_APP'],
      active: true,
      triggerOnce: false,
      cooldownMinutes: 60,
      lastTriggeredAt: null,
      createdAt: '2026-11-01T00:00:00.000Z',
      updatedAt: '2026-11-01T00:00:00.000Z',
    };
    const update = vi.fn(async () => alert);
    renderWithClient(
      <AlertForm alert={alert} portfolios={portfolios} onDone={() => undefined} />,
      mockClient({ alerts: { update } }),
    );
    const pct = screen.getByLabelText('Loss (%)');
    expect(pct).toHaveValue('1.5');
    expect(screen.queryByLabelText('Symbol')).not.toBeInTheDocument();
    await userEvent.clear(pct);
    await userEvent.type(pct, '100');
    await userEvent.click(screen.getByRole('button', { name: 'Save alert' }));
    expect(await screen.findByText('Must be below 100')).toBeInTheDocument();
    await userEvent.clear(pct);
    await userEvent.type(pct, '2.25');
    await userEvent.click(screen.getByRole('button', { name: 'Save alert' }));
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith('a9', {
        params: { pct: '2.25' },
        channels: ['IN_APP'],
        cooldownMinutes: 60,
        triggerOnce: false,
        active: true,
      }),
    );
  });
});
