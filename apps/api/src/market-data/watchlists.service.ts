import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { UnknownSymbolError } from './errors.js';
import { MarketDataService } from './market-data.service.js';

export const MAX_WATCHLISTS = 20;
export const MAX_WATCHLIST_ITEMS = 100;

const nameTaken = () =>
  new ConflictException({ message: 'You already have a watchlist with that name', code: 'ALREADY_EXISTS' });

/** Per-user watchlists. Every query is scoped by userId — a user can never see or modify another user's lists. */
@Injectable()
export class WatchlistsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly market: MarketDataService,
  ) {}

  async list(userId: string) {
    const lists = await this.prisma.watchlist.findMany({
      where: { userId },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      include: {
        items: {
          include: { stock: { select: { symbol: true } } },
          orderBy: [{ sortOrder: 'asc' }, { addedAt: 'asc' }],
        },
      },
    });
    const symbols = [...new Set(lists.flatMap((l) => l.items.map((i) => i.stock.symbol)))];
    const quotes = new Map(
      (symbols.length ? await this.market.quotes(symbols) : []).map((q) => [q.symbol, q]),
    );
    return lists.map((l) => ({
      id: l.id,
      name: l.name,
      createdAt: l.createdAt.toISOString(),
      items: l.items.map((i) => ({
        symbol: i.stock.symbol,
        addedAt: i.addedAt.toISOString(),
        quote: quotes.get(i.stock.symbol) ?? null,
      })),
    }));
  }

  async get(userId: string, id: string) {
    const found = (await this.list(userId)).find((l) => l.id === id);
    if (!found) throw new NotFoundException({ message: 'Watchlist not found', code: 'NOT_FOUND' });
    return found;
  }

  async create(userId: string, name: string, symbols: string[] = []) {
    if ((await this.prisma.watchlist.count({ where: { userId } })) >= MAX_WATCHLISTS) {
      throw new ConflictException({ message: `At most ${MAX_WATCHLISTS} watchlists`, code: 'LIMIT_REACHED' });
    }
    const stocks = await this.resolveSymbols(symbols);
    try {
      const w = await this.prisma.watchlist.create({
        data: { userId, name, items: { create: stocks.map((s, i) => ({ stockId: s.id, sortOrder: i })) } },
      });
      return this.get(userId, w.id);
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') throw nameTaken();
      throw err;
    }
  }

  async rename(userId: string, id: string, name: string) {
    await this.owned(userId, id);
    try {
      await this.prisma.watchlist.update({ where: { id }, data: { name } });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') throw nameTaken();
      throw err;
    }
    return this.get(userId, id);
  }

  async remove(userId: string, id: string): Promise<void> {
    await this.owned(userId, id);
    await this.prisma.watchlist.delete({ where: { id } }); // items cascade
  }

  async addStock(userId: string, id: string, symbol: string) {
    await this.owned(userId, id);
    const [stock] = await this.resolveSymbols([symbol]);
    const count = await this.prisma.watchlistStock.count({ where: { watchlistId: id } });
    if (count >= MAX_WATCHLIST_ITEMS)
      throw new ConflictException({
        message: `At most ${MAX_WATCHLIST_ITEMS} stocks per watchlist`,
        code: 'LIMIT_REACHED',
      });
    // Idempotent: adding a symbol that is already present is a no-op.
    await this.prisma.watchlistStock.upsert({
      where: { watchlistId_stockId: { watchlistId: id, stockId: stock!.id } },
      create: { watchlistId: id, stockId: stock!.id, sortOrder: count },
      update: {},
    });
    return this.get(userId, id);
  }

  async removeStock(userId: string, id: string, symbol: string) {
    await this.owned(userId, id);
    const stock = await this.prisma.stock.findUnique({ where: { symbol } });
    if (!stock) throw new UnknownSymbolError(symbol);
    const { count } = await this.prisma.watchlistStock.deleteMany({
      where: { watchlistId: id, stockId: stock.id },
    });
    if (count === 0)
      throw new NotFoundException({ message: `${symbol} is not on this watchlist`, code: 'NOT_FOUND' });
    return this.get(userId, id);
  }

  private async owned(userId: string, id: string): Promise<void> {
    const w = await this.prisma.watchlist.findFirst({ where: { id, userId }, select: { id: true } });
    // 404 (not 403) for other users' lists: don't reveal that the id exists.
    if (!w) throw new NotFoundException({ message: 'Watchlist not found', code: 'NOT_FOUND' });
  }

  private async resolveSymbols(symbols: string[]) {
    const unique = [...new Set(symbols)];
    if (unique.length === 0) return [];
    const rows = await this.prisma.stock.findMany({
      where: { symbol: { in: unique } },
      select: { id: true, symbol: true },
    });
    const missing = unique.find((s) => !rows.some((r) => r.symbol === s));
    if (missing) throw new UnknownSymbolError(missing);
    return unique.map((s) => rows.find((r) => r.symbol === s)!);
  }
}
