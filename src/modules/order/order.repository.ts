import { ConflictException, Injectable } from '@nestjs/common';
import { BaseRepository } from '../../common/base.repository';
import { PrismaService } from '../../../prisma/prisma.service';
import { Order, Prisma, escrow_status } from '@prisma/client';
import {
  ORDER_PARTY_SELECT,
  PAYMENT_METHOD_SELECT,
} from '../../common/prisma-selects';
import { ORDER_STATUS } from './order.constants';
import { CreateAuditLogInput } from '../audit-log/interfaces/create-audit-log.interface';

export const ORDER_DETAIL_INCLUDE = {
  offer: {
    include: {
      payment_methods: { select: PAYMENT_METHOD_SELECT },
    },
  },
  escrow: true,
  buyer: { select: ORDER_PARTY_SELECT },
  seller: { select: ORDER_PARTY_SELECT },
} satisfies Prisma.OrderInclude;

export type OrderWithRelations = Prisma.OrderGetPayload<{
  include: typeof ORDER_DETAIL_INCLUDE;
}>;

const SCALE = 10_000_000n;

function toScaled(value: string | number): bigint {
  const text = String(value);
  const match = /^(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) throw new Error('Order amounts and offer prices must be decimal values.');
  const fraction = match[2] ?? '';
  let scaled = BigInt(match[1]) * SCALE + BigInt(fraction.slice(0, 7).padEnd(7, '0') || '0');
  if (fraction.length > 7 && fraction[7] >= '5') scaled += 1n;
  return scaled;
}

/** Multiplies 7-place asset values and rounds fiat totals to 2 places, half up. */
export function calculateFiatAmount(assetAmount: string | number, price: string | number): string {
  const product = toScaled(assetAmount) * toScaled(price);
  const cents = (product + 500_000_000_000n) / 1_000_000_000_000n;
  return `${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`;
}

export interface OrderCreationReservation {
  idempotency_key: string;
  order_id: string;
  request_hash: string;
  buyer_id: string;
  seller_id: string;
  status: 'pending' | 'deployed' | 'completed';
  contract_id: string | null;
  unsigned_fund_transaction: string | null;
}

@Injectable()
export class OrderRepository extends BaseRepository {
  constructor(private readonly prisma: PrismaService) {
    super(prisma.order, 'orderId');
  }

  findActiveForOfferBuyer(offerId: string, buyerId: string) {
    return this.prisma.order.findFirst({
      where: {
        offerId,
        buyerId,
        orderStatus: { in: [ORDER_STATUS.CREATED, ORDER_STATUS.LOCKED] },
      },
      select: { orderId: true },
    });
  }

  async reserveOrderCreation(input: {
    idempotencyKey: string;
    requestHash: string;
    buyerId: string;
    sellerId: string;
  }): Promise<{ reservation: OrderCreationReservation; created: boolean }> {
    const inserted = await this.prisma.$executeRaw`
      INSERT INTO order_creation_reservation
        (idempotency_key, order_id, request_hash, buyer_id, seller_id)
      VALUES
        (${input.idempotencyKey}::uuid, ${input.idempotencyKey}::uuid,
         ${input.requestHash}, ${input.buyerId}::uuid, ${input.sellerId}::uuid)
      ON CONFLICT (idempotency_key) DO NOTHING
    `;
    const rows = await this.prisma.$queryRaw<OrderCreationReservation[]>`
      SELECT idempotency_key, order_id, request_hash, buyer_id, seller_id,
             status, contract_id, unsigned_fund_transaction
      FROM order_creation_reservation
      WHERE idempotency_key = ${input.idempotencyKey}::uuid
    `;
    if (!rows[0]) throw new Error('Order creation reservation was not persisted');
    return { reservation: rows[0], created: inserted === 1 };
  }

  async saveOrderDeployment(
    idempotencyKey: string,
    contractId: string,
    unsignedFundTransaction: string,
  ): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE order_creation_reservation
      SET status = 'deployed', contract_id = ${contractId},
          unsigned_fund_transaction = ${unsignedFundTransaction}, updated_at = NOW()
      WHERE idempotency_key = ${idempotencyKey}::uuid AND status = 'pending'
    `;
  }

  async completeOrderCreation(idempotencyKey: string): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE order_creation_reservation
      SET status = 'completed', updated_at = NOW()
      WHERE idempotency_key = ${idempotencyKey}::uuid AND status = 'deployed'
    `;
  }

  getOrderCreationReservation(
    idempotencyKey: string,
  ): Promise<OrderCreationReservation | null> {
    return this.prisma.$queryRaw<OrderCreationReservation[]>`
      SELECT idempotency_key, order_id, request_hash, buyer_id, seller_id,
             status, contract_id, unsigned_fund_transaction
      FROM order_creation_reservation
      WHERE idempotency_key = ${idempotencyKey}::uuid
    `.then((rows) => rows[0] ?? null);
  }
  }

  // Override create to atomically create order+escrow and mark the offer as executed.
  // Accepts an optional pre-generated orderId so the same UUID can be used as the
  // Trustless Work engagementId before any DB record is persisted.
  async create(data: {
    orderId?: string; // optional pre-generated UUID
    offerId: string;
    buyerId: string;
    sellerId: string;
    assetAmount: string | number;
    fiatAmount?: string | number;
    orderStatus?: string;
    expiresAt?: Date | string | null;
    auditLog?: CreateAuditLogInput;
    // Escrow data to persist alongside the order
    escrow?: {
      contractId: string;
      sellerAddress: string;
      buyerAddress: string;
      amount: string | number;
    };
  }): Promise<Order & { escrowId: string | null }> {
    const created = await this.prisma.$transaction(async (tx) => {
      // Lock the offer row so concurrent orders cannot reserve the same remaining amount.
      const [offer] = await tx.$queryRaw<
        Array<{
          max_amount: Prisma.Decimal;
          min_amount: Prisma.Decimal;
          price: Prisma.Decimal;
          status: string;
        }>
      >`SELECT max_amount, min_amount, price, status FROM offer WHERE offer_id = ${data.offerId}::uuid FOR UPDATE`;
      if (!offer || offer.status !== 'active') {
        throw new ConflictException('Offer is unavailable');
      }

      const requestedAmount = new Prisma.Decimal(data.assetAmount);
      const minAmount = new Prisma.Decimal(offer.min_amount);
      const maxAmount = new Prisma.Decimal(offer.max_amount);
      const fiatAmount = calculateFiatAmount(data.assetAmount, String(offer.price));
      const now = new Date();
      const reserved = await tx.order.aggregate({
        where: {
          offerId: data.offerId,
          orderStatus: { in: ['created', 'locked', 'disputed'] },
          OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
        },
        _sum: { assetAmount: true },
      });
      const usedAmount = reserved._sum.assetAmount ?? new Prisma.Decimal(0);
      const remaining = maxAmount.minus(usedAmount);
      if (requestedAmount.lessThan(minAmount) || requestedAmount.greaterThan(remaining)) {
        throw new ConflictException(
          `Order amount must be at least ${minAmount.toString()} and no more than the remaining offer amount ${remaining.toString()}`,
        );
      }
      const payload = {
        ...(data.orderId ? { orderId: data.orderId } : {}),
        offerId: data.offerId,
        buyerId: data.buyerId,
        sellerId: data.sellerId,
        assetAmount: data.assetAmount,
        fiatAmount,
        orderStatus: data.orderStatus || undefined,
        expiresAt: data.expiresAt ? new Date(data.expiresAt) : undefined,
      } as Prisma.OrderUncheckedCreateInput;

      const order = await tx.order.create({ data: payload });

      // Persist escrow record atomically with the order if data is provided
      let escrowId: string | null = null;
      if (data.escrow) {
        const escrow = await tx.escrowOnChain.create({
          data: {
            orderId: order.orderId,
            contractId: data.escrow.contractId,
            sellerAddress: data.escrow.sellerAddress,
            buyerAddress: data.escrow.buyerAddress,
            amount: data.escrow.amount,
            escrowStatus: 'initialized',
          },
        });
        escrowId = escrow.escrowId;
      }

      const totalReserved = usedAmount.plus(requestedAmount);
      await tx.offer.update({
        where: { offerId: data.offerId },
        data: { executed: totalReserved.greaterThanOrEqualTo(maxAmount) },
      });

      // Keep the audit record in the same transaction as the business change.
      // If either write fails, neither the order nor its audit entry commits.
      if (data.auditLog) {
        await tx.auditLog.create({
          data: {
            userId: data.auditLog.userId,
            action: data.auditLog.action,
            resourceType: data.auditLog.resourceType,
            resourceId: data.auditLog.resourceId,
            result: data.auditLog.result,
            ipAddress: data.auditLog.ipAddress,
            userAgent: data.auditLog.userAgent,
            correlationId: data.auditLog.correlationId,
            metadata: data.auditLog.metadata as
              | Prisma.InputJsonValue
              | undefined,
          },
        });
      }
      return { ...order, escrowId };
    });

    return created;
  }

  async cancelAndReleaseReservation(orderId: string): Promise<Order> {
    return this.prisma.$transaction(async (tx) => {
      const order = await tx.order.update({
        where: { orderId },
        data: { orderStatus: ORDER_STATUS.CANCELLED },
      });
      await tx.offer.updateMany({
        where: { offerId: order.offerId, executed: true },
        data: { executed: false },
      });
      return order;
    });
  }

  search(
    where: Record<string, unknown>,
    skip = 0,
    take = 20,
  ): Promise<OrderWithRelations[]> {
    return this.prisma.order.findMany({
      where,
      skip,
      take,
      orderBy: { orderId: 'desc' },
      include: ORDER_DETAIL_INCLUDE,
    });
  }

  async searchPage(where: Record<string, unknown>, skip = 0, take = 20) {
    const [items, total] = await Promise.all([
      this.search(where, skip, take),
      this.prisma.order.count({ where: where as Prisma.OrderWhereInput }),
    ]);
    const hasMore = skip + items.length < total;
    return {
      items,
      total,
      skip,
      take,
      hasMore,
      nextSkip: hasMore ? skip + items.length : null,
    };
  }

  findById(id: string): Promise<OrderWithRelations | null> {
    return this.prisma.order.findUnique({
      where: { orderId: id },
      include: ORDER_DETAIL_INCLUDE,
    });
  }

  /**
   * Applies a status-bearing PATCH only while the order and (when supplied)
   * its escrow still match the states validated by the caller. This prevents
   * a concurrent terminal transition from being overwritten by a stale PATCH.
   */
  async updateIfStatusesMatch(
    id: string,
    expectedOrderStatus: Order['orderStatus'],
    expectedEscrowStatus: escrow_status | undefined,
    data: Prisma.OrderUpdateManyMutationInput,
  ): Promise<boolean> {
    const where: Prisma.OrderWhereInput = {
      orderId: id,
      orderStatus: expectedOrderStatus,
      ...(expectedEscrowStatus
        ? { escrow: { is: { escrowStatus: expectedEscrowStatus } } }
        : {}),
    };
    const result = await this.prisma.order.updateMany({ where, data });
    return result.count === 1;
  }

  async getUserStats(
    userId: string,
  ): Promise<{ totalOrders: number; completedOrders: number }> {
    const countsByStatus = await this.prisma.order.groupBy({
      by: ['orderStatus'],
      where: {
        OR: [{ buyerId: userId }, { sellerId: userId }],
      },
      _count: { _all: true },
    });

    return countsByStatus.reduce(
      (stats, row) => {
        const count = row._count._all;
        stats.totalOrders += count;
        if (row.orderStatus === ORDER_STATUS.RELEASED) {
          stats.completedOrders += count;
        }
        return stats;
      },
      { totalOrders: 0, completedOrders: 0 },
    );
  }
}
