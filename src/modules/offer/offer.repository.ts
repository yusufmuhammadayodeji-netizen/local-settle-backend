import { BadRequestException, Injectable } from '@nestjs/common';
import { BaseRepository } from '../../common/base.repository';
import { PrismaService } from '../../../prisma/prisma.service';
import { Prisma } from '@prisma/client';
import { PAYMENT_METHOD_SELECT } from '../../common/prisma-selects';
import { AppException, ErrorCode } from '../../common/errors';
import { PaymentDataCipher } from '../payment-methods/payment-data-cipher';

export const OFFER_DETAIL_INCLUDE = {
  payment_methods: { select: PAYMENT_METHOD_SELECT },
} satisfies Prisma.OfferInclude;

export type OfferWithRelations = Prisma.OfferGetPayload<{
  include: typeof OFFER_DETAIL_INCLUDE;
}>;

@Injectable()
export class OfferRepository extends BaseRepository {
  private readonly paymentDataCipher = new PaymentDataCipher();

  constructor(private readonly prisma: PrismaService) {
    super(prisma.offer, 'offerId');
  }

  async create(data: Record<string, unknown>): Promise<OfferWithRelations> {
    const { paymentMethodIds, ...offerData } = data as {
      paymentMethodIds?: string[];
      [key: string]: unknown;
    };

    const connectPaymentMethods: { connect?: Array<{ paymentId: string }> } =
      {};

    if (paymentMethodIds && paymentMethodIds.length > 0) {
      const creatorId = offerData.creatorId as string;
      const uniqueIds = [...new Set(paymentMethodIds)];
      const v2Methods = await this.prisma.paymentMethod.findMany({
        where: {
          paymentId: { in: uniqueIds },
          userId: creatorId,
          isActive: true,
        },
        select: { paymentId: true },
      });
      if (v2Methods.length !== uniqueIds.length) {
        throw new BadRequestException('Payment methods must be active and owned by the offer creator');
      }
      connectPaymentMethods.connect = v2Methods.map(
        (m: { paymentId: string }) => ({ paymentId: m.paymentId }),
      );
    }

    const created = await this.prisma.offer.create({
      data: {
        ...offerData,
        payment_methods: connectPaymentMethods.connect
          ? connectPaymentMethods
          : undefined,
      } as never,
      include: OFFER_DETAIL_INCLUDE,
    });
    return this.decryptPaymentMethods(created);
  }

  async findById(offerId: string): Promise<OfferWithRelations | null> {
    const offer = await this.prisma.offer.findFirst({
      where: { offerId, creator: { deletedAt: null } },
      include: OFFER_DETAIL_INCLUDE,
    });
    return offer ? this.decryptPaymentMethods(offer) : null;
  }

  async getUserRole(userId: string): Promise<string | null> {
    const user = await this.prisma.appUser.findUnique({
      where: { userId },
      select: { role: true },
    });
    return user?.role ?? null;
  }

  async updateWithVersion(
    offerId: string,
    data: Record<string, unknown>,
    expectedVersion: number,
  ): Promise<OfferWithRelations> {
    const result = await this.prisma.offer.updateMany({
      where: { offerId, version: expectedVersion },
      data: { ...data, version: { increment: 1 } },
    });

    if (result.count === 0) {
      const exists = await this.prisma.offer.findUnique({
        where: { offerId },
        select: { offerId: true },
      });
      if (!exists) {
        throw new AppException(
          ErrorCode.OFFER_NOT_FOUND,
          `Offer ${offerId} not found`,
        );
      }
      throw new AppException(
        ErrorCode.OFFER_VERSION_CONFLICT,
        'Offer has changed. Reload it and retry with the current version.',
      );
    }

    const updated = await this.findById(offerId);
    if (!updated) {
      throw new AppException(
        ErrorCode.OFFER_NOT_FOUND,
        `Offer ${offerId} not found`,
      );
    }
    return updated;
  }

  search(
    where: Record<string, unknown>,
    skip = 0,
    take = 20,
    sortBy: 'price' | 'createdAt' | 'offerId' = 'offerId',
    sortOrder: 'asc' | 'desc' = 'desc',
  ): Promise<OfferWithRelations[]> {
    return this.prisma.offer.findMany({
      where: { ...where, creator: { deletedAt: null } },
      skip,
      take,
      orderBy: [{ [sortBy]: sortOrder }, { offerId: 'desc' }],
      include: OFFER_DETAIL_INCLUDE,
    }).then((offers) => offers.map((offer) => this.decryptPaymentMethods(offer)));
  }

  private decryptPaymentMethods<T extends { payment_methods?: unknown[] }>(offer: T): T {
    if (!Array.isArray(offer.payment_methods)) return offer;
    return {
      ...offer,
      payment_methods: offer.payment_methods.map((method) =>
        this.paymentDataCipher.decryptFields(method as never),
      ),
    };
  }

  async searchPage(
    where: Record<string, unknown>,
    skip = 0,
    take = 20,
    sortBy: 'price' | 'createdAt' | 'offerId' = 'offerId',
    sortOrder: 'asc' | 'desc' = 'desc',
  ) {
    const [items, total] = await Promise.all([
      this.search(where, skip, take, sortBy, sortOrder),
      this.prisma.offer.count({ where: where as Prisma.OfferWhereInput }),
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
}
