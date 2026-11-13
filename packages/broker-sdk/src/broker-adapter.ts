import type {
  BrokerAdapterKind,
  DataSource,
  OrderSide,
  OrderStatus,
  OrderType,
  Sourced,
  TimeInForce,
} from '@ktrade/shared';
import type { CapabilityManifest } from './capabilities.js';

/** Monetary/quantity fields are decimal strings at this boundary (adapters may be out-of-process). */
export interface AdapterContext {
  brokerAccountId: string;
  /** Correlates logs/audit across api → adapter. */
  requestId: string;
}

export interface CashBalanceDto {
  cash: string;
  buyingPower?: string;
  unsettled?: string;
}

export interface BrokerHoldingDto {
  symbol: string;
  quantity: string;
  avgCost?: string;
  marketValue?: string;
}

export interface BrokerOrderDto {
  brokerOrderRef: string;
  symbol: string;
  side: OrderSide;
  type: OrderType;
  quantity: string;
  limitPrice?: string;
  filledQuantity: string;
  avgFillPrice?: string;
  status: OrderStatus;
  placedAt?: string;
}

export interface BrokerExecutionDto {
  brokerExecRef: string;
  brokerOrderRef?: string;
  symbol: string;
  side: OrderSide;
  quantity: string;
  price: string;
  executedAt: string;
}

/** An order that has passed risk checks AND been approved under an ApprovalPolicy. */
export interface ApprovedOrder {
  orderId: string;
  idempotencyKey: string;
  previewHash: string;
  symbol: string;
  side: OrderSide;
  type: OrderType;
  timeInForce: TimeInForce;
  quantity: string;
  limitPrice?: string;
  stopPrice?: string;
}

export interface PreparedOrderResult {
  /** The order form is filled in the broker UI, awaiting the user's own submit click. */
  awaitingUserSubmit: true;
  screenshotRef?: string;
}

/**
 * Receipt for a submission. Deliberately has NO "filled" state:
 * a submission is never treated as an execution (docs/08 §7).
 */
export interface SubmissionReceipt {
  brokerOrderRef: string;
  status: Extract<OrderStatus, 'SUBMITTED' | 'ACCEPTED' | 'REJECTED_BY_BROKER' | 'UNKNOWN'>;
  source: DataSource;
  receivedAt: string;
}

export interface CancelReceipt {
  brokerOrderRef: string;
  status: Extract<OrderStatus, 'CANCEL_REQUESTED' | 'CANCELLED' | 'UNKNOWN'>;
  source: DataSource;
}

export interface OrderQuery {
  from?: string;
  to?: string;
  openOnly?: boolean;
}

/**
 * Implemented by every broker integration (paper, manual import, future official API, future browser agent).
 * Optional methods correspond to capabilities; callers MUST go through `guardedCall` (guard.ts), never call directly.
 */
export interface BrokerAdapter {
  readonly kind: BrokerAdapterKind;
  readonly displayName: string;
  capabilities(): CapabilityManifest;

  getCash?(ctx: AdapterContext): Promise<Sourced<CashBalanceDto>>;
  getHoldings?(ctx: AdapterContext): Promise<Sourced<BrokerHoldingDto[]>>;
  getOrders?(ctx: AdapterContext, q: OrderQuery): Promise<Sourced<BrokerOrderDto[]>>;
  getExecutions?(ctx: AdapterContext, q: OrderQuery): Promise<Sourced<BrokerExecutionDto[]>>;
  getOrderStatus?(ctx: AdapterContext, brokerOrderRef: string): Promise<Sourced<BrokerOrderDto>>;
  prepareOrder?(ctx: AdapterContext, order: ApprovedOrder): Promise<PreparedOrderResult>;
  placeOrder?(ctx: AdapterContext, order: ApprovedOrder): Promise<SubmissionReceipt>;
  cancelOrder?(ctx: AdapterContext, brokerOrderRef: string): Promise<CancelReceipt>;
}
