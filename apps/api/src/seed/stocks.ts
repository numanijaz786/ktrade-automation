import type { Clock } from '../common/clock.js';
import type { PrismaClient } from '../generated/prisma/client.js';
import { addDays, pktDateOf, PsxCalendar } from '../market-data/calendar.js';
import { upsertBars } from '../market-data/prices.repository.js';
import { SimulatedMarketDataProvider } from '../market-data/providers/simulated.provider.js';
import { ACTIVE_PROVIDER_SETTING } from '../market-data/provider-registry.js';

export interface SeedStock {
  symbol: string;
  name: string;
  sector: string;
  /**
   * Anchor level for the SIMULATED price generator only — a rough order of magnitude, NOT a quote.
   * Decimal string (PKR).
   */
  simBasePrice: string;
}

/**
 * ~30 PSX-listed companies: symbol, company name and PSX sector (public listing information, docs/09 Part C).
 * Shariah status and face value are deliberately left unset rather than guessed.
 */
export const PSX_SEED_STOCKS: readonly SeedStock[] = [
  {
    symbol: 'OGDC',
    name: 'Oil & Gas Development Company Limited',
    sector: 'Oil & Gas Exploration Companies',
    simBasePrice: '220.00',
  },
  {
    symbol: 'PPL',
    name: 'Pakistan Petroleum Limited',
    sector: 'Oil & Gas Exploration Companies',
    simBasePrice: '180.00',
  },
  {
    symbol: 'MARI',
    name: 'Mari Energies Limited',
    sector: 'Oil & Gas Exploration Companies',
    simBasePrice: '600.00',
  },
  {
    symbol: 'POL',
    name: 'Pakistan Oilfields Limited',
    sector: 'Oil & Gas Exploration Companies',
    simBasePrice: '600.00',
  },
  {
    symbol: 'HUBC',
    name: 'The Hub Power Company Limited',
    sector: 'Power Generation & Distribution',
    simBasePrice: '150.00',
  },
  {
    symbol: 'KAPCO',
    name: 'Kot Addu Power Company Limited',
    sector: 'Power Generation & Distribution',
    simBasePrice: '35.00',
  },
  { symbol: 'ENGRO', name: 'Engro Corporation Limited', sector: 'Fertilizer', simBasePrice: '330.00' },
  { symbol: 'EFERT', name: 'Engro Fertilizers Limited', sector: 'Fertilizer', simBasePrice: '200.00' },
  { symbol: 'FFC', name: 'Fauji Fertilizer Company Limited', sector: 'Fertilizer', simBasePrice: '350.00' },
  {
    symbol: 'FATIMA',
    name: 'Fatima Fertilizer Company Limited',
    sector: 'Fertilizer',
    simBasePrice: '110.00',
  },
  { symbol: 'LUCK', name: 'Lucky Cement Limited', sector: 'Cement', simBasePrice: '350.00' },
  { symbol: 'DGKC', name: 'D.G. Khan Cement Company Limited', sector: 'Cement', simBasePrice: '180.00' },
  { symbol: 'MLCF', name: 'Maple Leaf Cement Factory Limited', sector: 'Cement', simBasePrice: '90.00' },
  { symbol: 'MCB', name: 'MCB Bank Limited', sector: 'Commercial Banks', simBasePrice: '300.00' },
  { symbol: 'UBL', name: 'United Bank Limited', sector: 'Commercial Banks', simBasePrice: '350.00' },
  { symbol: 'HBL', name: 'Habib Bank Limited', sector: 'Commercial Banks', simBasePrice: '250.00' },
  { symbol: 'MEBL', name: 'Meezan Bank Limited', sector: 'Commercial Banks', simBasePrice: '400.00' },
  { symbol: 'BAHL', name: 'Bank AL Habib Limited', sector: 'Commercial Banks', simBasePrice: '160.00' },
  { symbol: 'NBP', name: 'National Bank of Pakistan', sector: 'Commercial Banks', simBasePrice: '150.00' },
  { symbol: 'SYS', name: 'Systems Limited', sector: 'Technology & Communication', simBasePrice: '160.00' },
  {
    symbol: 'TRG',
    name: 'TRG Pakistan Limited',
    sector: 'Technology & Communication',
    simBasePrice: '75.00',
  },
  {
    symbol: 'PSO',
    name: 'Pakistan State Oil Company Limited',
    sector: 'Oil & Gas Marketing Companies',
    simBasePrice: '400.00',
  },
  {
    symbol: 'SNGP',
    name: 'Sui Northern Gas Pipelines Limited',
    sector: 'Oil & Gas Marketing Companies',
    simBasePrice: '120.00',
  },
  {
    symbol: 'SSGC',
    name: 'Sui Southern Gas Company Limited',
    sector: 'Oil & Gas Marketing Companies',
    simBasePrice: '40.00',
  },
  { symbol: 'NML', name: 'Nishat Mills Limited', sector: 'Textile Composite', simBasePrice: '130.00' },
  { symbol: 'ILP', name: 'Interloop Limited', sector: 'Textile Composite', simBasePrice: '75.00' },
  {
    symbol: 'INDU',
    name: 'Indus Motor Company Limited',
    sector: 'Automobile Assembler',
    simBasePrice: '2000.00',
  },
  {
    symbol: 'HCAR',
    name: 'Honda Atlas Cars (Pakistan) Limited',
    sector: 'Automobile Assembler',
    simBasePrice: '300.00',
  },
  { symbol: 'PAEL', name: 'Pak Elektron Limited', sector: 'Cable & Electrical Goods', simBasePrice: '40.00' },
  { symbol: 'SEARL', name: 'The Searle Company Limited', sector: 'Pharmaceuticals', simBasePrice: '100.00' },
];

/** symbol → simulation anchor price, consumed by SimulatedMarketDataProvider. */
export const SIM_BASE_PRICES: ReadonlyMap<string, string> = new Map(
  PSX_SEED_STOCKS.map((s) => [s.symbol, s.simBasePrice]),
);

export interface SeedMarketDataOptions {
  /** Calendar years of SIMULATED D1 history per symbol. Default 2. */
  years?: number;
}

export interface SeedMarketDataResult {
  stocks: number;
  barsInserted: number;
  barsUpdated: number;
  from: string;
  to: string;
}

/**
 * Idempotent market-data seed: upserts the reference stocks, then SIMULATED D1 bars (providerKey
 * `simulated`) for the last `years` up to the last completed PSX session. Re-running produces identical
 * rows (the generator is seeded by symbol + date). Rows imported from another source (e.g. a user CSV)
 * are never overwritten. Also defaults `marketData.activeProvider` to `simulated` if unset.
 */
export async function seedMarketData(
  prisma: PrismaClient,
  clock: Clock,
  options: SeedMarketDataOptions = {},
): Promise<SeedMarketDataResult> {
  const years = options.years ?? 2;
  if (!Number.isSafeInteger(years) || years < 1 || years > 5)
    throw new RangeError('years must be an integer 1–5');

  for (const s of PSX_SEED_STOCKS) {
    await prisma.stock.upsert({
      where: { symbol: s.symbol },
      create: { symbol: s.symbol, name: s.name, sector: s.sector },
      update: { name: s.name, sector: s.sector },
    });
  }
  const stocks = await prisma.stock.findMany({
    where: { symbol: { in: PSX_SEED_STOCKS.map((s) => s.symbol) } },
    select: { id: true, symbol: true },
  });

  const holidays = await prisma.marketHoliday.findMany({ select: { date: true } });
  const calendar = new PsxCalendar(holidays.map((h) => h.date.toISOString().slice(0, 10)));
  const provider = new SimulatedMarketDataProvider(clock, () => calendar, SIM_BASE_PRICES);

  const now = clock.now();
  const to = calendar.lastCompletedSession(now);
  const from = addDays(pktDateOf(now), -365 * years);
  let inserted = 0;
  let updated = 0;
  for (const stock of stocks) {
    const bars = await provider.getBars(
      stock.symbol,
      'D1',
      calendar.sessionOpen(from),
      calendar.sessionClose(to),
    );
    const res = await upsertBars(prisma, stock.id, bars, {
      providerKey: provider.key,
      source: provider.source,
      overwritableProviderKeys: [provider.key],
    });
    inserted += res.inserted;
    updated += res.updated;
  }

  await prisma.systemSetting.upsert({
    where: { key: ACTIVE_PROVIDER_SETTING },
    create: { key: ACTIVE_PROVIDER_SETTING, value: 'simulated' },
    update: {},
  });

  return { stocks: stocks.length, barsInserted: inserted, barsUpdated: updated, from, to };
}
