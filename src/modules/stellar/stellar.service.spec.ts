jest.mock('@stellar/stellar-sdk', () => ({
  Horizon: { Server: jest.fn().mockImplementation(() => ({})) },
}));

import { ConfigService } from '@nestjs/config';
import { StellarService } from './stellar.service';

describe('StellarService.getTransactions', () => {
  const publicKey = `G${'A'.repeat(55)}`;
  const payment = (id: string, overrides: Record<string, unknown> = {}) => ({
    id,
    transaction_hash: `hash-${id}`,
    created_at: '2026-10-17T00:00:00Z',
    type: 'payment',
    amount: '1',
    asset_type: 'native',
    from: publicKey,
    to: `G${'B'.repeat(55)}`,
    ...overrides,
  });

  function setup(records: unknown[]) {
    const query = {
      forAccount: jest.fn().mockReturnThis(),
      order: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      cursor: jest.fn().mockReturnThis(),
      call: jest.fn().mockResolvedValue({ records }),
    };
    const service = new StellarService({ get: jest.fn() } as unknown as ConfigService);
    Object.defineProperty(service, 'server', {
      value: { payments: jest.fn().mockReturnValue(query) },
    });
    return { service, query };
  }

  it('distinguishes native XLM from issued assets without changing legacy fields', async () => {
    const issuer = `G${'C'.repeat(55)}`;
    const { service } = setup([
      payment('1', { to: issuer }),
      payment('2', {
        amount: '2',
        asset_type: 'credit_alphanum4',
        asset_code: 'USD',
        asset_issuer: issuer,
        from: issuer,
        to: publicKey,
      }),
    ]);

    const result = await service.getTransactions(publicKey);

    expect(result.records[0]).toEqual(
      expect.objectContaining({
        asset: 'XLM',
        asset_issuer: null,
        asset_descriptor: { type: 'native', code: 'XLM', issuer: null },
      }),
    );
    expect(result.records[1]).toEqual(
      expect.objectContaining({
        asset: 'USD',
        asset_issuer: issuer,
        asset_descriptor: {
          type: 'credit_alphanum4',
          code: 'USD',
          issuer,
        },
      }),
    );
  });

  it('returns a continuation cursor when Horizon has another record', async () => {
    const { service, query } = setup([payment('200'), payment('199')]);

    await expect(service.getTransactions(publicKey, 1, '201')).resolves.toEqual({
      records: [expect.objectContaining({ id: '200' })],
      nextCursor: '200',
    });
    expect(query.cursor).toHaveBeenCalledWith('201');
    expect(query.limit).toHaveBeenCalledWith(2);
  });

  it('omits the cursor on the final page and rejects malformed cursors', async () => {
    const { service, query } = setup([payment('100')]);

    await expect(service.getTransactions(publicKey, 1)).resolves.toEqual({
      records: [expect.objectContaining({ id: '100' })],
    });
    await expect(service.getTransactions(publicKey, 1, 'bad-cursor')).rejects.toThrow(
      'Cursor must be a Stellar payments cursor.',
    );
    expect(query.call).toHaveBeenCalledTimes(1);
  });
});
