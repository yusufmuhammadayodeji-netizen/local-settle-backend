import { OrderService } from './order.service';
import { CreateOrderDto } from './dto/create-order.dto';

describe('OrderService.create idempotency', () => {
  const idempotencyKey = 'e8aa8b28-85c9-4e45-b516-75c1f857a637';
  const dto = {
    idempotencyKey,
    offerId: '11111111-1111-4111-8111-111111111111',
    buyerId: '22222222-2222-4222-8222-222222222222',
    sellerId: '33333333-3333-4333-8333-333333333333',
    assetAmount: '5',
    fiatAmount: '500',
    sellerAddress: 'seller-wallet',
    buyerAddress: 'buyer-wallet',
    assetCode: 'USDC',
  } as CreateOrderDto;

  it('reuses a persisted deployment when order persistence failed after deployment', async () => {
    const reservation = {
      idempotency_key: idempotencyKey,
      order_id: idempotencyKey,
      request_hash: '',
      buyer_id: dto.buyerId,
      seller_id: dto.sellerId,
      status: 'pending' as const,
      contract_id: null,
      unsigned_fund_transaction: null,
    };
    let reserveCall = 0;
    const repo = {
      reserveOrderCreation: jest.fn().mockImplementation(async (input) => {
        reserveCall += 1;
        const firstCall = reserveCall === 1;
        return {
          created: firstCall,
          reservation: {
            ...reservation,
            request_hash: input.requestHash,
            status: firstCall ? 'pending' : 'deployed',
            contract_id: firstCall ? null : 'contract-1',
            unsigned_fund_transaction: firstCall
              ? null
              : 'unsigned-xdr',
          },
        };
      }),
      findById: jest.fn().mockResolvedValue(null),
      saveOrderDeployment: jest.fn().mockResolvedValue(undefined),
      create: jest
        .fn()
        .mockRejectedValueOnce(new Error('temporary database failure'))
        .mockResolvedValue({ orderId: idempotencyKey, escrowId: 'escrow-1' }),
      completeOrderCreation: jest.fn().mockResolvedValue(undefined),
    };
    const escrowService = {
      deployEscrowToChain: jest.fn().mockResolvedValue({
        contractId: 'contract-1',
        unsignedFundTransaction: 'unsigned-xdr',
      }),
    };
    const service = new OrderService(
      repo as never,
      escrowService as never,
      { create: jest.fn() } as never,
      {} as never,
    );

    await expect(service.create(dto)).rejects.toThrow(
      'temporary database failure',
    );
    await expect(service.create(dto)).resolves.toEqual(
      expect.objectContaining({
        orderId: idempotencyKey,
        contractId: 'contract-1',
        unsignedFundTransaction: 'unsigned-xdr',
      }),
    );
    expect(escrowService.deployEscrowToChain).toHaveBeenCalledTimes(1);
    expect(repo.create).toHaveBeenCalledTimes(2);
  });

  it('does not deploy a second escrow while another request owns the key', async () => {
    const repo = {
      reserveOrderCreation: jest.fn().mockImplementation(async (input) => ({
        created: false,
        reservation: {
          idempotency_key: idempotencyKey,
          order_id: idempotencyKey,
          request_hash: input.requestHash,
          buyer_id: dto.buyerId,
          seller_id: dto.sellerId,
          status: 'pending',
          contract_id: null,
          unsigned_fund_transaction: null,
        },
      })),
      findById: jest.fn().mockResolvedValue(null),
    };
    const escrowService = { deployEscrowToChain: jest.fn() };
    const service = new OrderService(
      repo as never,
      escrowService as never,
      {} as never,
      {} as never,
    );

    await expect(service.create(dto)).rejects.toThrow(/already in progress/);
    expect(escrowService.deployEscrowToChain).not.toHaveBeenCalled();
  });
});
