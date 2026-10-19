import { EscrowService } from './escrow.service';
import { EscrowAction } from './dto/sync-escrow.dto';
import { AuditAction, AuditResult } from '../audit-log/enums/audit-action.enum';

describe('EscrowService transaction audit context', () => {
  const auditContext = {
    userId: 'actor-user-id',
    ipAddress: '203.0.113.10',
    userAgent: 'test-agent',
    correlationId: 'request-123',
  };
  let service: EscrowService;
  let auditCreate: jest.Mock;
  let escrowUpdate: jest.Mock;
  let escrowFindById: jest.Mock;
  let sendTransaction: jest.Mock;

  beforeEach(() => {
    auditCreate = jest.fn().mockResolvedValue(undefined);
    escrowUpdate = jest.fn().mockResolvedValue(undefined);
    escrowFindById = jest.fn().mockResolvedValue({
      escrowId: 'escrow-id',
      orderId: 'order-id',
      contractId: 'contract-id',
      escrowStatus: 'initialized',
      lastSyncTxHash: null,
      lastSyncAction: null,
    });
    const repository = {
      findById: escrowFindById,
      update: escrowUpdate,
    };
    sendTransaction = jest.fn().mockResolvedValue({ status: 'SUCCESS' });
    const trustlessWork = { sendTransaction };
    service = new EscrowService(
      repository as never,
      trustlessWork as never,
      {} as never,
      {} as never,
      { create: auditCreate } as never,
    );
  });

  it.each<[EscrowAction, AuditAction, string]>([
    [EscrowAction.FUND, AuditAction.ESCROW_FUNDED, 'initialized'],
    [EscrowAction.FIAT_SENT, AuditAction.ESCROW_FIAT_SENT, 'funded'],
    [EscrowAction.RELEASE, AuditAction.ESCROW_RELEASED, 'funded'],
  ])(
    'records actor and request context for %s',
    async (action, auditAction, status) => {
      escrowFindById.mockResolvedValue({
      escrowId: 'escrow-id',
      orderId: 'order-id',
      contractId: 'contract-id',
      escrowStatus: status,
      lastSyncTxHash: null,
      lastSyncAction: null,
    });

      await service.syncTransaction(
        { escrowId: 'escrow-id', signedXdr: 'signed-xdr', action },
        auditContext,
      );

      expect(auditCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          ...auditContext,
          action: auditAction,
          resourceType: 'Escrow',
          resourceId: 'escrow-id',
          result: AuditResult.SUCCESS,
          metadata: expect.objectContaining({
            orderId: 'order-id',
            transactionHash: expect.any(String),
          }),
        }),
      );
      expect(escrowUpdate).toHaveBeenCalled();
      expect(JSON.stringify(auditCreate.mock.calls[0][0])).not.toContain(
        'signed-xdr',
      );
    },
  );

  it('records a failed transaction attempt without persisting the signed XDR', async () => {
    sendTransaction.mockResolvedValue({ status: 'FAILED', message: 'rejected' });

    await expect(
      service.syncTransaction(
        {
          escrowId: 'escrow-id',
          signedXdr: 'sensitive-signed-xdr',
          action: EscrowAction.FUND,
        },
        auditContext,
      ),
    ).rejects.toThrow();

    expect(auditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        ...auditContext,
        action: AuditAction.ESCROW_FUNDED,
        resourceId: 'escrow-id',
        result: AuditResult.FAILURE,
        metadata: expect.objectContaining({ transactionHash: expect.any(String) }),
      }),
    );
    expect(JSON.stringify(auditCreate.mock.calls[0][0])).not.toContain(
      'sensitive-signed-xdr',
    );
    expect(escrowUpdate).not.toHaveBeenCalled();
  });
});
