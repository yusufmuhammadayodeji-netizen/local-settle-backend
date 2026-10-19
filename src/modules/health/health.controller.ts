import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  ServiceUnavailableException,
} from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../../prisma/prisma.service';

export interface HealthResponse {
  status: 'ok' | 'degraded';
  db: 'up' | 'down';
  uptime: number;
  timestamp: string;
  stellar: {
    network: 'testnet' | 'public';
    horizonHost: string | null;
    sorobanHost: string | null;
  };
}

@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  @SkipThrottle()
  @Get('live')
  getLiveness() {
    return { status: 'ok', uptime: Math.floor(process.uptime()) };
  }

  @SkipThrottle()
  @Get('ready')
  @HttpCode(HttpStatus.OK)
  async getReadiness() {
    const missing = [
      'DATABASE_URL',
      'JWT_SECRET',
      'STELLAR_RPC_URL',
      'TRUSTLESS_WORK_API_URL',
      'TRUSTLESS_WORK_API_KEY',
    ].filter((key) => !this.config.get<string>(key)?.trim());
    let db: 'up' | 'down' = 'up';
    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch {
      db = 'down';
    }

    const ready = db === 'up' && missing.length === 0;
    const response = {
      status: ready ? 'ok' : 'degraded',
      db,
      missingConfiguration: missing,
      uptime: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
    };
    if (!ready) throw new ServiceUnavailableException(response);
    return response;
  }

  private getStellarIdentity(): HealthResponse['stellar'] {
    const network = this.config.get<string>('STELLAR_NETWORK') === 'public'
      ? 'public'
      : 'testnet';
    const hostOnly = (value: string | undefined, fallback: string): string | null => {
      try {
        return new URL(value ?? fallback).host || null;
      } catch {
        return null;
      }
    };
    return {
      network,
      horizonHost: hostOnly(this.config.get<string>('STELLAR_HORIZON_URL'), 'https://horizon-testnet.stellar.org'),
      sorobanHost: hostOnly(this.config.get<string>('STELLAR_RPC_URL'), 'https://soroban-testnet.stellar.org'),
    };
  }

  @SkipThrottle()
  @Get()
  @HttpCode(HttpStatus.OK)
  async getHealth(): Promise<HealthResponse> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return {
        status: 'ok',
        db: 'up',
        uptime: Math.floor(process.uptime()),
        timestamp: new Date().toISOString(),
        stellar: this.getStellarIdentity(),
      };
    } catch {
      throw new ServiceUnavailableException({
        status: 'degraded',
        db: 'down',
        uptime: Math.floor(process.uptime()),
        timestamp: new Date().toISOString(),
        stellar: this.getStellarIdentity(),
      });
    }
  }
}
