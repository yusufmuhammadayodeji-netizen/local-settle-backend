import { ConfigService } from '@nestjs/config';
import { AxiosError, AxiosResponse } from 'axios';
import * as StellarSdk from '@stellar/stellar-sdk';
import { TrustlessWorkService } from './trustless-work.service';

describe('TrustlessWorkService resilience', () => {
  function setup() {
    const service = new TrustlessWorkService({ get: jest.fn() } as unknown as ConfigService);
    const http = {
      get: jest.fn(),
      post: jest.fn(),
    };
    Object.defineProperty(service, 'http', { value: http });
    return { service, http };
  }

  function unavailable() {
    const error = new AxiosError('service unavailable');
    error.response = {
      status: 503,
      data: { message: 'upstream unavailable' },
    } as AxiosResponse;
    return error;
  }

  it('retries a transient GET failure and returns the later success', async () => {
    const { service, http } = setup();
    http.get
      .mockRejectedValueOnce(unavailable())
      .mockResolvedValueOnce({ data: [{ contractId: 'contract-1' }] });

    await expect(service.getEscrowByContractId('contract-1')).resolves.toEqual([
      { contractId: 'contract-1' },
    ]);
    expect(http.get).toHaveBeenCalledTimes(2);
  });

  it('opens the read circuit after repeated failures and never retries POST', async () => {
    const { service, http } = setup();
    http.get.mockRejectedValue(unavailable());

    await expect(service.getEscrowByContractId('contract-1')).rejects.toThrow(
      'Escrow operation failed: upstream unavailable',
    );
    expect(http.get).toHaveBeenCalledTimes(3);
    await expect(service.getEscrowByContractId('contract-1')).rejects.toThrow(
      'temporarily unavailable',
    );
    expect(http.get).toHaveBeenCalledTimes(3);

    http.post.mockRejectedValue(unavailable());
    await expect(service.sendTransaction('signed-xdr')).rejects.toThrow(
      'Escrow operation failed: upstream unavailable',
    );
    expect(http.post).toHaveBeenCalledTimes(1);
  });
});

describe('TrustlessWorkService backend signing guard', () => {
  const signerAddress = 'G_OPERATOR';
  const signer = { publicKey: () => signerAddress };

  function setupSigning(operation: Record<string, unknown>) {
    const service = new TrustlessWorkService({
      get: jest.fn((key: string) => (key === 'STELLAR_NETWORK' ? 'testnet' : undefined)),
    } as unknown as ConfigService);
    const transaction = {
      source: signerAddress,
      operations: [operation],
      sign: jest.fn(),
      toXDR: jest.fn().mockReturnValue('signed-xdr'),
    };
    jest.spyOn(StellarSdk.Keypair, 'fromSecret').mockReturnValue(signer as never);
    jest
      .spyOn(StellarSdk.TransactionBuilder, 'fromXDR')
      .mockReturnValue(transaction as never);
    const broadcast = jest
      .spyOn(service, 'sendTransaction')
      .mockResolvedValue({ status: 'SUCCESS' });
    return { service, transaction, broadcast };
  }

  afterEach(() => jest.restoreAllMocks());

  it('signs the known escrow deployment operation when source and network match', async () => {
    const { service, transaction, broadcast } = setupSigning({
      type: 'invokeHostFunction',
      func: { createContract: () => ({}) },
    });

    await expect(
      service.signAndBroadcast(
        'fixture-deploy-xdr',
        'fixture-secret',
        'Test SDF Network ; September 2015',
        'deploy',
      ),
    ).resolves.toEqual({ status: 'SUCCESS' });
    expect(transaction.sign).toHaveBeenCalledWith(signer);
    expect(broadcast).toHaveBeenCalledWith('signed-xdr');
  });

  it('rejects an unexpected source before signing', async () => {
    const { service, transaction, broadcast } = setupSigning({
      type: 'invokeHostFunction',
      func: { createContract: () => ({}) },
    });
    transaction.source = 'G_UNEXPECTED';

    await expect(
      service.signAndBroadcast(
        'fixture-deploy-xdr',
        'fixture-secret',
        'Test SDF Network ; September 2015',
        'deploy',
      ),
    ).rejects.toThrow('source is not the configured operator');
    expect(transaction.sign).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('rejects an unexpected operation before signing', async () => {
    const { service, transaction, broadcast } = setupSigning({ type: 'payment' });

    await expect(
      service.signAndBroadcast(
        'fixture-payment-xdr',
        'fixture-secret',
        'Test SDF Network ; September 2015',
        'deploy',
      ),
    ).rejects.toThrow('unexpected transaction operation');
    expect(transaction.sign).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('rejects an unexpected configured network before signing', async () => {
    const { service, transaction, broadcast } = setupSigning({
      type: 'invokeHostFunction',
      func: { createContract: () => ({}) },
    });

    await expect(
      service.signAndBroadcast(
        'fixture-deploy-xdr',
        'fixture-secret',
        'Public Global Stellar Network ; September 2015',
        'deploy',
      ),
    ).rejects.toThrow('unexpected Stellar network');
    expect(transaction.sign).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();
  });
});
