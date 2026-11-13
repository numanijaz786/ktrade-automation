/** Static demo fixtures (no prices): connections, settings, sessions, notifications, imports. */
import type {
  Alert,
  BrokerConnection,
  Capability,
  CapabilityState,
  ChannelConfig,
  Discrepancy,
  FeeScheduleRow,
  ImportBatch,
  ImportRow,
  MailboxStatus,
  MarketProvider,
  Notification,
  Session,
  TaxRate,
  UserSettings,
  Watchlist,
} from '../api/types';
import { daysAgo } from './ledger';

export const LIVE_PORTFOLIO_ID = 'pf-live';
export const PAPER_PORTFOLIO_ID = 'pf-paper';

const at = (n: number, time = '05:30:00') => `${daysAgo(n)}T${time}Z`;

const CAPS: Capability[] = [
  'readAccount',
  'readCash',
  'readHoldings',
  'readOrders',
  'readExecutions',
  'prepareOrder',
  'placeOrder',
  'cancelOrder',
  'streamOrderUpdates',
];
const off: CapabilityState = { implemented: false, verified: false, authorized: false, enabled: false };
const on: CapabilityState = { implemented: true, verified: true, authorized: true, enabled: true };
const caps = (f: (c: Capability) => CapabilityState) =>
  Object.fromEntries(CAPS.map((c) => [c, f(c)])) as Record<Capability, CapabilityState>;

export function seedConnections(): BrokerConnection[] {
  return [
    {
      id: 'conn-manual',
      adapterKind: 'MANUAL_IMPORT',
      label: 'Manual import & mailbox',
      status: 'CONNECTED',
      description:
        'Reads contract notes and statements you upload or that arrive in your mailbox. Read-only; cannot place orders.',
      capabilities: caps((c) =>
        ['readHoldings', 'readExecutions', 'readCash'].includes(c)
          ? {
              implemented: true,
              verified: true,
              authorized: true,
              authorizationRef: 'Own documents',
              enabled: true,
            }
          : off,
      ),
    },
    {
      id: 'conn-paper',
      adapterKind: 'PAPER',
      label: 'Paper broker',
      status: 'CONNECTED',
      description: 'Simulated broker for paper portfolios. Same order state machine and risk checks as live.',
      capabilities: caps(() => ({ ...on, authorizationRef: 'Internal simulator' })),
    },
    {
      id: 'conn-ktrade-api',
      adapterKind: 'KTRADE_OFFICIAL_API',
      label: 'KTrade official API',
      status: 'DISABLED',
      description:
        'Stub. KTrade does not publish a retail trading API today; every capability stays off until one exists and is authorized in writing.',
      capabilities: caps(() => off),
    },
    {
      id: 'conn-ktrade-browser',
      adapterKind: 'KTRADE_BROWSER',
      label: 'KTrade browser adapter',
      status: 'DISABLED',
      description:
        'Not built. Local-only browser automation is designed but disabled until KTrade gives written permission (see docs/03).',
      capabilities: caps(() => off),
    },
  ];
}

export function seedWatchlists(): Watchlist[] {
  return [
    {
      id: 'wl-core',
      name: 'Core holdings',
      symbols: ['OGDC', 'HUBC', 'MCB', 'ENGRO', 'LUCK', 'MEBL', 'FFC', 'PSO', 'MARI', 'SYS'],
    },
    { id: 'wl-banks', name: 'Banks', symbols: ['MCB', 'UBL', 'MEBL', 'HBL', 'BAFL', 'NBP'] },
    {
      id: 'wl-energy',
      name: 'Energy',
      symbols: ['OGDC', 'PPL', 'MARI', 'POL', 'PSO', 'SNGP', 'HUBC', 'KEL'],
    },
  ];
}

export function seedNotifications(): Notification[] {
  return [
    {
      id: 'n-1',
      type: 'STRATEGY_SIGNAL',
      title: 'New signal: OGDC entry',
      body: 'EMA 9/21 crossover strategy produced an ENTRY signal (paper).',
      createdAt: at(0, '10:35:00'),
      read: false,
      channel: 'IN_APP',
      link: '/strategies',
    },
    {
      id: 'n-2',
      type: 'DIVIDEND_ANNOUNCED',
      title: 'FFC announced a cash dividend',
      body: 'Rs 7.50/share; ex-date 24 Nov 2026. Entitlement is an estimate until paid.',
      createdAt: at(1, '09:10:00'),
      read: false,
      channel: 'IN_APP',
      link: '/dividends',
    },
    {
      id: 'n-3',
      type: 'SYNC_DISCREPANCY',
      title: 'Holdings mismatch: PSO',
      body: 'Ledger shows 5 more PSO shares than the latest holdings statement. Review in KTrade Integration.',
      createdAt: at(1, '06:00:00'),
      read: false,
      channel: 'IN_APP',
      link: '/integration',
    },
    {
      id: 'n-4',
      type: 'PRICE_ABOVE',
      title: 'HUBC crossed Rs 150.00',
      body: 'Price alert triggered (simulated prices).',
      createdAt: at(2, '08:12:00'),
      read: true,
      channel: 'IN_APP',
      link: '/market/HUBC',
    },
    {
      id: 'n-5',
      type: 'ORDER_EXECUTED',
      title: 'MARI fill reconciled',
      body: 'Your user-reported fill matched contract note CN-2026-10-30-0042 and is now broker-confirmed.',
      createdAt: at(9, '04:20:00'),
      read: true,
      channel: 'EMAIL',
      link: '/orders',
    },
    {
      id: 'n-6',
      type: 'ORDER_REJECTED',
      title: 'KEL order rejected by risk checks',
      body: 'MAX_ORDER_QTY failed (60,000 > 10,000).',
      createdAt: at(4, '07:01:00'),
      read: true,
      channel: 'IN_APP',
      link: '/orders',
    },
    {
      id: 'n-7',
      type: 'PORTFOLIO_DAILY_LOSS',
      title: 'Portfolio down 1.8% today',
      body: 'Daily loss alert threshold is 1.5%. New buys are still allowed (block at 3%).',
      createdAt: at(6, '10:30:00'),
      read: true,
      channel: 'TELEGRAM',
    },
    {
      id: 'n-8',
      type: 'DIVIDEND_RECEIVED',
      title: 'MCB dividend received',
      body: 'Net of 15% withholding tax (estimated rate).',
      createdAt: at(35, '05:00:00'),
      read: true,
      channel: 'IN_APP',
      link: '/dividends',
    },
  ];
}

export function seedAlerts(): Alert[] {
  return [
    {
      id: 'al-1',
      type: 'PRICE_ABOVE',
      symbol: 'HUBC',
      params: { price: '150.00' },
      active: true,
      channels: ['IN_APP', 'TELEGRAM'],
    },
    {
      id: 'al-2',
      type: 'PRICE_BELOW',
      symbol: 'LUCK',
      params: { price: '360.00' },
      active: true,
      channels: ['IN_APP'],
    },
    {
      id: 'al-3',
      type: 'PORTFOLIO_DAILY_LOSS',
      symbol: null,
      params: { pct: '1.5' },
      active: true,
      channels: ['IN_APP', 'EMAIL'],
    },
    {
      id: 'al-4',
      type: 'VOLUME_SPIKE',
      symbol: 'TRG',
      params: { multiple: '2.0' },
      active: false,
      channels: ['IN_APP'],
    },
  ];
}

export function seedImports(): { batches: ImportBatch[]; rows: Map<string, ImportRow[]> } {
  // Only formats the real pipeline supports today (generic CSV). KTrade contract-note/CDC parsers need real samples.
  const base = {
    portfolioId: LIVE_PORTFOLIO_ID,
    kind: 'GENERIC_TRANSACTIONS_CSV' as const,
    channel: 'UPLOAD' as const,
    parserKey: 'generic.transactions.csv',
    source: 'USER_REPORTED' as const,
  };
  const batches: ImportBatch[] = [
    {
      ...base,
      id: 'imp-1',
      fileName: 'trades_sep2026.csv',
      sizeBytes: 412,
      status: 'COMMITTED',
      uploadedAt: at(9, '03:00:00'),
      committedAt: at(9, '03:05:00'),
      periodFrom: daysAgo(40),
      periodTo: daysAgo(12),
      rowCounts: { COMMITTED: 2 },
    },
    {
      ...base,
      id: 'imp-2',
      fileName: 'trades_oct2026.csv',
      sizeBytes: 655,
      status: 'AWAITING_REVIEW',
      uploadedAt: at(1, '06:00:00'),
      committedAt: null,
      periodFrom: daysAgo(14),
      periodTo: daysAgo(5),
      rowCounts: { VALID: 3, DUPLICATE: 1, INVALID: 1 },
    },
  ];
  const est = 'no charges in file — fees will be ESTIMATED from the fee schedule';
  const row = (r: Partial<ImportRow> & Pick<ImportRow, 'id' | 'rowNo' | 'status'>): ImportRow => ({
    tradeDate: null,
    symbol: null,
    side: null,
    quantity: null,
    price: null,
    contractRef: null,
    fees: [],
    feeSource: 'ESTIMATED_ON_COMMIT',
    duplicateOf: null,
    errors: [],
    warnings: [],
    message: null,
    ...r,
  });
  const rows = new Map<string, ImportRow[]>([
    [
      'imp-2',
      [
        row({
          id: 'r-1',
          rowNo: 2,
          status: 'VALID',
          tradeDate: daysAgo(14),
          symbol: 'PPL',
          side: 'BUY',
          quantity: '200',
          price: '196.40',
          contractRef: 'CN-1013',
          fees: [
            { component: 'COMMISSION', amount: '117.84' },
            { component: 'SST_ON_COMMISSION', amount: '17.68' },
          ],
          feeSource: 'FILE',
        }),
        row({
          id: 'r-2',
          rowNo: 3,
          status: 'DUPLICATE',
          tradeDate: daysAgo(10),
          symbol: 'MARI',
          side: 'BUY',
          quantity: '230',
          price: '612.40',
          contractRef: 'CN-1016',
          duplicateOf: {
            kind: 'IMPORT_ROW',
            id: 'imp-1',
            detail: 'already imported from trades_sep2026.csv (row 3)',
          },
          warnings: ['already imported from trades_sep2026.csv (row 3) — skipped unless you include it', est],
        }),
        row({
          id: 'r-3',
          rowNo: 4,
          status: 'VALID',
          tradeDate: daysAgo(8),
          symbol: 'EFERT',
          side: 'SELL',
          quantity: '50',
          price: '214.10',
          contractRef: 'CN-1019',
          warnings: [est],
        }),
        row({
          id: 'r-4',
          rowNo: 5,
          status: 'INVALID',
          tradeDate: daysAgo(7),
          symbol: 'XYZ',
          side: 'BUY',
          quantity: '10',
          price: '12.00',
          contractRef: 'CN-1020',
          feeSource: null,
          errors: ['unknown symbol XYZ (not in the PSX stock list)'],
        }),
        row({
          id: 'r-5',
          rowNo: 6,
          status: 'VALID',
          tradeDate: daysAgo(5),
          symbol: 'UBL',
          side: 'BUY',
          quantity: '100',
          price: '262.75',
          contractRef: 'CN-1022',
          warnings: [est],
        }),
      ].map((r) => ({ ...r, message: [...r.errors, ...r.warnings].join('; ') || null })),
    ],
  ]);
  return { batches, rows };
}

export function seedMailbox(): MailboxStatus {
  return {
    connected: false,
    address: null,
    senderFilter: 'from:<KTrade contract-note sender> has:attachment',
    lastSyncAt: null,
    messagesProcessed: 0,
    scope: 'Read-only mailbox scope (e.g. gmail.readonly)',
  };
}

export function seedDiscrepancies(): Discrepancy[] {
  return [
    {
      id: 'dq-1',
      kind: 'HOLDING',
      symbol: 'PSO',
      ledger: '0',
      broker: '0',
      difference: '5',
      brokerSource: 'BROKER_CONFIRMED',
      detectedAt: at(1, '06:00:00'),
      status: 'OPEN',
      note: 'Ledger has 5 more shares than the holdings statement. Likely a missing contract note.',
    },
    {
      id: 'dq-2',
      kind: 'CASH',
      symbol: null,
      ledger: '0',
      broker: '0',
      difference: '-12.40',
      brokerSource: 'BROKER_CONFIRMED',
      detectedAt: at(9, '03:05:00'),
      status: 'RESOLVED',
      note: 'CDC charges are “at actual” and were not in the estimate; upgraded from the contract note.',
    },
  ];
}

export function seedSessions(): Session[] {
  return [
    {
      id: 'ses-1',
      device: 'Chrome on Windows',
      ip: '203.0.113.24',
      location: 'Lahore, PK (approx.)',
      createdAt: at(3, '04:00:00'),
      lastSeenAt: at(0, '10:40:00'),
      current: true,
    },
    {
      id: 'ses-2',
      device: 'Safari on iPhone',
      ip: '198.51.100.7',
      location: 'Lahore, PK (approx.)',
      createdAt: at(12, '15:00:00'),
      lastSeenAt: at(1, '16:20:00'),
      current: false,
    },
    {
      id: 'ses-3',
      device: 'Firefox on Ubuntu',
      ip: '192.0.2.88',
      location: 'Karachi, PK (approx.)',
      createdAt: at(30, '07:00:00'),
      lastSeenAt: at(18, '07:30:00'),
      current: false,
    },
  ];
}

export function seedFeeSchedules(): FeeScheduleRow[] {
  return [
    {
      id: 'fee-1',
      component: 'COMMISSION',
      appliesTo: 'BOTH',
      method: 'MAX_OF_PCT_OR_PER_SHARE',
      rate: '0.30',
      perShare: '0.06',
      description: 'max(0.30% of value, Rs 0.06 per share)',
      effectiveFrom: '2026-01-01',
      source: 'ESTIMATED',
      verified: true,
    },
    {
      id: 'fee-2',
      component: 'SST_ON_COMMISSION',
      appliesTo: 'BOTH',
      method: 'PCT_OF_COMPONENT',
      rate: '15',
      perShare: null,
      description: '15% of commission (Sindh sales tax on services)',
      effectiveFrom: '2026-01-01',
      source: 'ESTIMATED',
      verified: true,
    },
    {
      id: 'fee-3',
      component: 'CDC_CHARGES',
      appliesTo: 'BOTH',
      method: 'AT_ACTUAL',
      rate: null,
      perShare: null,
      description: 'At actual — taken from the contract note',
      effectiveFrom: '2026-01-01',
      source: 'ESTIMATED',
      verified: true,
    },
  ];
}

export function seedTaxRates(): TaxRate[] {
  const note =
    'Placeholder rate — verify against the current Finance Act / NCCPL schedule before relying on it.';
  return [
    {
      id: 'tax-1',
      type: 'CAPITAL_GAINS',
      filerStatus: 'FILER',
      ratePct: '15',
      effectiveFrom: '2026-07-01',
      verified: false,
      note,
    },
    {
      id: 'tax-2',
      type: 'CAPITAL_GAINS',
      filerStatus: 'NON_FILER',
      ratePct: '30',
      effectiveFrom: '2026-07-01',
      verified: false,
      note,
    },
    {
      id: 'tax-3',
      type: 'DIVIDEND_WITHHOLDING',
      filerStatus: 'FILER',
      ratePct: '15',
      effectiveFrom: '2026-07-01',
      verified: false,
      note,
    },
    {
      id: 'tax-4',
      type: 'DIVIDEND_WITHHOLDING',
      filerStatus: 'NON_FILER',
      ratePct: '30',
      effectiveFrom: '2026-07-01',
      verified: false,
      note,
    },
  ];
}

export function seedProviders(): MarketProvider[] {
  return [
    {
      key: 'simulated',
      name: 'Simulated provider',
      source: 'SIMULATED',
      active: true,
      available: true,
      delayMinutes: 0,
      health: 'OK',
      capabilities: {
        quotes: true,
        intradayBars: true,
        eodBars: true,
        corporateActions: false,
        streaming: true,
      },
      note: 'Seeded synthetic prices. Live trading refuses these prices.',
    },
    {
      key: 'csv-eod',
      name: 'CSV end-of-day import',
      source: 'USER_REPORTED',
      active: false,
      available: true,
      delayMinutes: 1440,
      health: 'NOT_CONFIGURED',
      capabilities: {
        quotes: false,
        intradayBars: false,
        eodBars: true,
        corporateActions: false,
        streaming: false,
      },
      note: 'Import EOD files you hold a licence to use.',
    },
    {
      key: 'capitalstake',
      name: 'Capital Stake',
      source: 'PROVIDER',
      active: false,
      available: false,
      delayMinutes: 0,
      health: 'NOT_CONFIGURED',
      capabilities: {
        quotes: true,
        intradayBars: true,
        eodBars: true,
        corporateActions: true,
        streaming: true,
      },
      note: 'Adapter scaffolded but disabled: needs your subscription and API key.',
    },
  ];
}

export function seedChannels(): ChannelConfig[] {
  return [
    { channel: 'IN_APP', enabled: true, target: 'This app', configured: true },
    { channel: 'EMAIL', enabled: false, target: '', configured: false },
    { channel: 'TELEGRAM', enabled: false, target: '', configured: false },
  ];
}

export function seedUserSettings(): UserSettings {
  return {
    displayName: 'Demo Owner',
    taxFilerStatus: 'FILER',
    costBasisMethod: 'WEIGHTED_AVERAGE',
    aiDataSharingOptIn: false,
  };
}
