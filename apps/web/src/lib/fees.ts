/**
 * Client-side mirror of the fee engine used for the demo estimate (docs/08 §7 preview).
 * KTrade published schedule (reference): commission = max(0.30% of value, Rs 0.06 per share);
 * SST = 15% of commission (Sindh); CDC charges "at actual" — only known from the contract note.
 * All maths are exact decimal (Dec); amounts are rounded to paisa.
 */
import type { OrderSide } from '@ktrade/shared';
import { Dec, type DecInput } from './decimal';
import type { FeeEstimate, FeeLine } from './api/types';

export const COMMISSION_RATE = '0.003';
export const COMMISSION_PER_SHARE = '0.06';
export const SST_RATE = '0.15';

export function estimateFees(side: OrderSide, quantity: DecInput, price: DecInput): FeeEstimate {
  const qty = Dec.of(quantity);
  const notional = qty.mul(price).round(2);
  const pctLeg = notional.mul(COMMISSION_RATE);
  const perShareLeg = qty.mul(COMMISSION_PER_SHARE);
  const commission = Dec.max(pctLeg, perShareLeg).round(2);
  const sst = commission.mul(SST_RATE).round(2);
  const cdc = Dec.zero();

  const fees: FeeLine[] = [
    {
      component: 'COMMISSION',
      amount: commission.toFixed(2),
      source: 'ESTIMATED',
      basis: `max(0.30% × ${notional.toFixed(2)}, Rs 0.06 × ${qty.toString()} sh)`,
    },
    {
      component: 'SST_ON_COMMISSION',
      amount: sst.toFixed(2),
      source: 'ESTIMATED',
      basis: '15% of commission',
    },
    {
      component: 'CDC_CHARGES',
      amount: cdc.toFixed(2),
      source: 'ESTIMATED',
      basis: 'at actual',
      note: 'At actual — known after the contract note',
    },
  ];
  const totalFees = commission.add(sst).add(cdc);
  const total = side === 'BUY' ? notional.add(totalFees) : notional.sub(totalFees);
  return {
    notional: notional.toFixed(4),
    fees,
    totalFees: totalFees.toFixed(2),
    total: total.toFixed(4),
  };
}
