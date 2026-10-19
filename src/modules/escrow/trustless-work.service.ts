/**
 * trustless-work.service.ts
 *
 * HTTP client for the Trustless Work REST API.
 *
 * Changes from the original version:
 *  - All payloads now use the canonical types from trustless-work.types.ts
 *  - `roles` is a plain object with the exact keys the API expects
 *    (no `client` key — that field does not exist in the TW schema)
 *  - `trustline` is always an object { address, symbol }; never null/undefined
 *  - `initializeEscrow` param type now enforces `MultiReleaseRoles` directly,
 *    eliminating the `Record<string, string>` footgun
 *  - Response types are explicit instead of `any`
 *
 * SECURITY: This service NEVER handles private keys except in signAndBroadcast,
 * which must only be called with secrets sourced from env vars.
 */

import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance, AxiosError, AxiosResponse } from 'axios';
import { randomUUID } from 'crypto';
import { AppException, ErrorCode } from '../../common/errors';
import { ProviderRequestQueue } from '../../common/provider-request-queue';
import * as StellarSdk from '@stellar/stellar-sdk';
import {
  InitializeMultiReleaseEscrowPayload,
  FundEscrowPayload,
  ChangeMilestoneStatusPayload,
  ApproveMilestonePayload,
  ReleaseMilestoneFundsPayload,
  UnsignedTransactionResponse,
  SendTransactionResponse,
  EscrowIndexerEntry,
  EscrowBalanceResponse,
} from './trustless-work.types';

@Injectable()
export class TrustlessWorkService {
  private readonly http: AxiosInstance;
  private readonly trustlessQueue: ProviderRequestQueue;
  private readonly logger = new Logger(TrustlessWorkService.name);
  private readonly requestMeta = new WeakMap<object, { id: string; startedAt: number }>();
  private consecutiveReadFailures = 0;
  private readCircuitOpenedAt = 0;

  constructor(private readonly config: ConfigService) {
    const baseURL =
      this.config.get<string>('TRUSTLESS_WORK_API_URL') ??
      'https://api.trustlesswork.com';
    const apiKey =
      this.config.get<string>('TRUSTLESS_WORK_API_KEY') ?? 'mock-key';

    this.http = axios.create({
      baseURL,
      timeout: 60_000,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
      },
    });
    this.trustlessQueue = new ProviderRequestQueue(
      Number(this.config.get<string>('TRUSTLESS_WORK_MAX_CONCURRENT_REQUESTS') ?? 3),
      Number(this.config.get<string>('TRUSTLESS_WORK_MAX_QUEUED_REQUESTS') ?? 15),
      Number(this.config.get<string>('TRUSTLESS_WORK_QUEUE_TIMEOUT_MS') ?? 10_000),
    );

    // Request bodies include signed XDR, wallet addresses and evidence. Never log
    // them; the method and path are enough to correlate an upstream request.
    this.http.interceptors.request.use((req) => {
      const meta = { id: randomUUID(), startedAt: Date.now() };
      this.requestMeta.set(req, meta);
      this.logger.debug(`Trustless Work request ${meta.id} ${req.method?.toUpperCase()} ${req.url}`);
      return req;
    });
    this.http.interceptors.response.use((res: AxiosResponse) => {
      const meta = this.requestMeta.get(res.config);
      this.logger.debug(`Trustless Work response ${meta?.id ?? 'unknown'} status=${res.status} durationMs=${meta ? Date.now() - meta.startedAt : 'unknown'}`);
      return res;
    });
  }

  // ─── Deploy ────────────────────────────────────────────────────────────────

  /**
   * POST /deployer/multi-release
   *
   * Builds an unsigned XDR that deploys a new multi-release escrow contract.
   * The caller must sign and broadcast via sendTransaction().
   *
   * API required fields: signer, engagementId, title, description,
   *                       roles, platformFee, milestones, trustline
   *
   * Roles must be a plain object — never an array or a Record<string,string>.
   * Valid keys: approver, serviceProvider, platformAddress, releaseSigner, disputeResolver
   *
   * Trustline must be { address: string, symbol: string } — never null.
   * For native XLM use { address: '', symbol: 'XLM' }.
   */
  async initializeEscrow(
    payload: InitializeMultiReleaseEscrowPayload,
  ): Promise<UnsignedTransactionResponse> {
    const assetSymbol = payload.trustline?.symbol?.toUpperCase();
    if (assetSymbol !== 'USDC') {
      throw new AppException(
        ErrorCode.UNSUPPORTED_ASSET,
        `Only USDC is supported for escrow. Received: "${payload.trustline?.symbol}"`,
      );
    }
    return this.post<UnsignedTransactionResponse>(
      '/deployer/multi-release',
      payload,
    );
  }

  // ─── Fund ──────────────────────────────────────────────────────────────────

  /**
   * POST /escrow/multi-release/fund-escrow
   *
   * Builds an unsigned XDR for the seller to fund the escrow.
   * `amount` should equal the sum of all milestone amounts.
   */
  async fundEscrow(
    payload: FundEscrowPayload,
  ): Promise<UnsignedTransactionResponse> {
    return this.post<UnsignedTransactionResponse>(
      '/escrow/multi-release/fund-escrow',
      payload,
    );
  }

  // ─── Milestone ─────────────────────────────────────────────────────────────

  /**
   * POST /escrow/multi-release/change-milestone-status
   *
   * Service provider marks a milestone as completed and attaches evidence.
   * `newEvidence` is required by the API schema (use a placeholder if not applicable).
   */
  async changeMilestoneStatus(
    payload: ChangeMilestoneStatusPayload,
  ): Promise<UnsignedTransactionResponse> {
    return this.post<UnsignedTransactionResponse>(
      '/escrow/multi-release/change-milestone-status',
      payload,
    );
  }

  /**
   * POST /escrow/multi-release/approve-milestone
   *
   * Approver validates completed milestone work.
   * Must be called before releaseMilestoneFunds when milestone status is 'completed'.
   */
  async approveMilestone(
    payload: ApproveMilestonePayload,
  ): Promise<UnsignedTransactionResponse> {
    return this.post<UnsignedTransactionResponse>(
      '/escrow/multi-release/approve-milestone',
      payload,
    );
  }

  /**
   * POST /escrow/multi-release/release-milestone-funds
   *
   * Releases funds for an approved milestone to the milestone's receiver address.
   */
  async releaseMilestoneFunds(
    payload: ReleaseMilestoneFundsPayload,
  ): Promise<UnsignedTransactionResponse> {
    return this.post<UnsignedTransactionResponse>(
      '/escrow/multi-release/release-milestone-funds',
      payload,
    );
  }

  // ─── Broadcast ─────────────────────────────────────────────────────────────

  /**
   * POST /helper/send-transaction
   *
   * Broadcasts a client-signed XDR to the Stellar network.
   * This is the ONLY operation that actually executes on-chain.
   *
   * Response shape:
   *   - Deploy tx success → { status, contractId, escrow }
   *   - Other tx success  → { status, message }
   */
  async sendTransaction(signedXdr: string): Promise<SendTransactionResponse> {
    return this.post<SendTransactionResponse>('/helper/send-transaction', {
      signedXdr,
    });
  }

  /**
   * Sign an unsigned XDR with a backend-controlled secret key and broadcast it.
   *
   * Decode, sign, and re-encode the envelope through the Stellar SDK so XDR
   * parsing and decorated-signature serialization stay aligned with the SDK.
   *
   * SECURITY: signerSecret must come from a backend env var, never from the client.
   */
  async signAndBroadcast(
    unsignedXdr: string,
    signerSecret: string,
    networkPassphrase: string,
    expectedOperation: 'deploy' | 'approve',
    expectedContractId?: string,
  ): Promise<SendTransactionResponse> {
    const keypair = StellarSdk.Keypair.fromSecret(signerSecret);
    const transaction = StellarSdk.TransactionBuilder.fromXDR(
      unsignedXdr,
      networkPassphrase,
    );

    this.validateBackendSigningRequest(
      transaction,
      keypair.publicKey(),
      networkPassphrase,
      expectedOperation,
      expectedContractId,
    );

    transaction.sign(keypair);
    const signedXdr = transaction.toXDR();

    this.logger.debug(
      `Broadcasting backend-signed tx for signer ${keypair.publicKey().substring(0, 8)}…`,
    );

    return this.sendTransaction(signedXdr);
  }

  /**
   * Trustless Work returns unsigned XDR, but the backend must only add its
   * operator signature to the one operation it requested. Check the network
   * configured by the application, source account, operation kind, and (for
   * approvals) the target contract and function before touching the key.
   */
  private validateBackendSigningRequest(
    transaction: StellarSdk.Transaction,
    signerAddress: string,
    networkPassphrase: string,
    expectedOperation: 'deploy' | 'approve',
    expectedContractId?: string,
  ): void {
    if (transaction.constructor.name === 'FeeBumpTransaction') {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        'Refusing to sign an unexpected fee-bump transaction envelope.',
      );
    }

    const configuredNetwork = (
      this.config.get<string>('STELLAR_NETWORK') ?? 'testnet'
    ).toLowerCase();
    const configuredPassphrase =
      configuredNetwork === 'public'
        ? 'Public Global Stellar Network ; September 2015'
        : 'Test SDF Network ; September 2015';

    if (networkPassphrase !== configuredPassphrase) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        'Refusing to sign a transaction for an unexpected Stellar network.',
      );
    }

    if (transaction.source !== signerAddress) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        'Refusing to sign a transaction whose source is not the configured operator.',
      );
    }

    if (
      transaction.operations.length !== 1 ||
      transaction.operations[0]?.type !== 'invokeHostFunction'
    ) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        'Refusing to sign an unexpected transaction operation.',
      );
    }

    const hostFunction = transaction.operations[0].func as unknown as Record<
      string,
      () => unknown
    >;
    if (expectedOperation === 'deploy') {
      if (
        !this.matchesHostFunction(hostFunction, [
          'createContract',
          'createContractV2',
        ])
      ) {
        throw new AppException(
          ErrorCode.VALIDATION_ERROR,
          'Refusing to sign an XDR that does not deploy the expected escrow contract.',
        );
      }
      return;
    }

    if (!expectedContractId || !this.matchesHostFunction(hostFunction, ['invokeContract'])) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        'Refusing to sign an XDR that does not invoke the expected escrow contract.',
      );
    }

    try {
      const invoke = hostFunction.invokeContract() as {
        contractAddress: () => { contractId: () => { toXDR: () => Uint8Array } };
        functionName: () => { toString: () => string };
      };
      const rawContractId = invoke.contractAddress().contractId().toXDR();
      const contractId = StellarSdk.StrKey.encodeContract(Buffer.from(rawContractId));
      if (
        contractId !== expectedContractId ||
        invoke.functionName().toString() !== 'approve_milestone'
      ) {
        throw new Error('Unexpected contract or function');
      }
    } catch {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        'Refusing to sign an XDR that does not approve the expected escrow milestone.',
      );
    }
  }

  /** XDR union accessors throw when the requested arm is not selected. */
  private matchesHostFunction(
    hostFunction: Record<string, () => unknown>,
    allowedArms: string[],
  ): boolean {
    return allowedArms.some((arm) => {
      try {
        return typeof hostFunction[arm] === 'function' && Boolean(hostFunction[arm]());
      } catch {
        return false;
      }
    });
  }

  // ─── Query ─────────────────────────────────────────────────────────────────

  /**
   * GET /helper/get-escrow-by-contract-ids?contractIds[]=…&validateOnChain=…
   */
  async getEscrowByContractId(
    contractId: string,
    validateOnChain = false,
  ): Promise<EscrowIndexerEntry[]> {
    const params = new URLSearchParams();
    params.append('contractIds[]', contractId);
    params.append('validateOnChain', String(validateOnChain));

    return this.get<EscrowIndexerEntry[]>(
      `/helper/get-escrow-by-contract-ids?${params.toString()}`,
    );
  }

  /**
   * GET /helper/get-multiple-escrow-balance?addresses=…
   */
  async getEscrowBalance(
    contractAddress: string,
  ): Promise<EscrowBalanceResponse[]> {
    return this.get<EscrowBalanceResponse[]>(
      '/helper/get-multiple-escrow-balance',
      { params: { addresses: [contractAddress] } },
    );
  }

  // ─── HTTP helpers ──────────────────────────────────────────────────────────

  private async post<T>(url: string, data: unknown): Promise<T> {
    return this.trustlessQueue.run(async () => {
      try {
        const res = await this.http.post<T>(url, data);
        return res.data;
      } catch (err) {
        this.handleError(err, `POST ${url}`);
      }
    });
  }

  private async get<T>(url: string, config?: object): Promise<T> {
    return this.trustlessQueue.run(async () => {
      const circuitCooldownMs = 30_000;
      if (
        this.readCircuitOpenedAt &&
        Date.now() - this.readCircuitOpenedAt < circuitCooldownMs
      ) {
        throw new AppException(
          ErrorCode.ESCROW_CREATION_FAILED,
          'Trustless Work is temporarily unavailable. Retry the read request later.',
        );
      }

      // GET requests are safe to retry. POST calls use `post()` and are never
      // retried because some endpoints create or broadcast transactions.
      const maxAttempts = 3;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
          const res = await this.http.get<T>(url, config);
          this.consecutiveReadFailures = 0;
          this.readCircuitOpenedAt = 0;
          return res.data;
        } catch (err) {
          const status = err instanceof AxiosError ? err.response?.status : undefined;
          const retryable =
            err instanceof AxiosError &&
            (status === undefined || status === 429 || status >= 500);

          if (!retryable || attempt === maxAttempts) {
            if (retryable) {
              this.consecutiveReadFailures += 1;
              if (this.consecutiveReadFailures >= 3) {
                this.readCircuitOpenedAt = Date.now();
              }
            }
            this.handleError(err, `GET ${url}`);
          }

          if (retryable) {
            this.consecutiveReadFailures += 1;
            if (this.consecutiveReadFailures >= 3) {
              this.readCircuitOpenedAt = Date.now();
            }
          }
          await new Promise((resolve) => setTimeout(resolve, attempt * 100));
        }
      }

      throw new AppException(
        ErrorCode.ESCROW_CREATION_FAILED,
        'Trustless Work read request failed.',
      );
    });
  }

  private handleError(err: unknown, context: string): never {
    if (err instanceof AxiosError) {
      const status = err.response?.status ?? HttpStatus.BAD_GATEWAY;
      const meta = err.config ? this.requestMeta.get(err.config) : undefined;
      this.logger.error(
        `Trustless Work API error [${context}] requestId=${meta?.id ?? 'unknown'} status=${status} durationMs=${meta ? Date.now() - meta.startedAt : 'unknown'}`,
      );

      throw new AppException(
        ErrorCode.ESCROW_CREATION_FAILED,
        `Escrow operation failed (upstream status ${status})`,
      );
    }

    this.logger.error(`Unexpected error [${context}]`);
    throw new AppException(
      ErrorCode.INTERNAL_SERVER_ERROR,
      'Unexpected error communicating with Trustless Work',
    );
  }
}
