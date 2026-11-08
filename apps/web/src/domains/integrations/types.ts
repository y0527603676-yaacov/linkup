/**
 * Platform-neutral order model. WooCommerce (and later Shopify) adapters
 * translate their payloads into this shape; no other domain knows the platform.
 */
export type OrderStatus = "pending" | "processing" | "completed" | "cancelled" | "refunded" | "failed";

export interface NormalizedOrder {
  storeConnectionId: string;
  externalOrderId: string;
  currency: string;
  status: OrderStatus;
  /** Gross total incl. tax + shipping, minor units. */
  totalMinor: number;
  taxMinor: number;
  shippingMinor: number;
  shippingTaxMinor: number;
  /** Coupon codes in the order they were applied. */
  couponCodes: string[];
  customerEmailHash?: string;
  createdAt: Date;
}

export type OrderEventType = "order.upserted" | "order.refunded" | "order.deleted";

export interface NormalizedOrderEvent {
  storeConnectionId: string;
  /** Platform-unique id for de-duplication. */
  eventId: string;
  type: OrderEventType;
  occurredAt: Date;
  order: NormalizedOrder;
  refund?: { externalRefundId: string; amountMinor: number };
}

export interface CommercePlatformAdapter {
  readonly platform: "woocommerce" | "shopify";
  verifySignature(rawBody: string, signature: string, timestampSec: number, secret: string, nowSec: number): boolean;
  parseEvent(storeConnectionId: string, rawBody: string): NormalizedOrderEvent;
}
