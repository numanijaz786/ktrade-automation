import { createHash, randomBytes } from 'node:crypto';
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { type CryptoKey, importPKCS8, importSPKI, jwtVerify, SignJWT } from 'jose';
import type { Role } from '@ktrade/shared';
import { AppConfig } from '../config/config.module.js';

export interface AccessClaims {
  sub: string;
  role: Role;
  /** Session (refresh-token family) id — lets the guard reject revoked sessions immediately. */
  sid: string;
}

const ALG = 'EdDSA';

/** Ed25519-signed JWTs (access + step-up) and opaque refresh tokens. */
@Injectable()
export class TokenService implements OnModuleInit {
  private privateKey!: CryptoKey;
  private publicKey!: CryptoKey;

  constructor(private readonly config: AppConfig) {}

  async onModuleInit(): Promise<void> {
    const pem = (k: 'JWT_PRIVATE_KEY_B64' | 'JWT_PUBLIC_KEY_B64') =>
      Buffer.from(this.config.get(k), 'base64').toString('utf8');
    this.privateKey = await importPKCS8(pem('JWT_PRIVATE_KEY_B64'), ALG);
    this.publicKey = await importSPKI(pem('JWT_PUBLIC_KEY_B64'), ALG);
  }

  get accessTtlSeconds(): number {
    return this.config.get('ACCESS_TOKEN_TTL_SECONDS');
  }

  async signAccess(claims: AccessClaims): Promise<string> {
    return new SignJWT({ role: claims.role, sid: claims.sid, typ: 'access' })
      .setProtectedHeader({ alg: ALG })
      .setSubject(claims.sub)
      .setIssuer(this.config.get('JWT_ISSUER'))
      .setAudience(this.config.get('JWT_AUDIENCE'))
      .setIssuedAt()
      .setExpirationTime(`${this.accessTtlSeconds}s`)
      .sign(this.privateKey);
  }

  async verifyAccess(token: string): Promise<AccessClaims> {
    const { payload } = await jwtVerify(token, this.publicKey, {
      algorithms: [ALG],
      issuer: this.config.get('JWT_ISSUER'),
      audience: this.config.get('JWT_AUDIENCE'),
    });
    if (payload.typ !== 'access' || typeof payload.sub !== 'string' || typeof payload.sid !== 'string') {
      throw new Error('Not an access token');
    }
    if (payload.role !== 'OWNER' && payload.role !== 'VIEWER') throw new Error('Invalid role claim');
    return { sub: payload.sub, role: payload.role, sid: payload.sid };
  }

  /** Short-lived proof of a fresh second factor, required for sensitive actions (approve order, kill switch…). */
  async signStepUp(userId: string): Promise<string> {
    return new SignJWT({ typ: 'step_up' })
      .setProtectedHeader({ alg: ALG })
      .setSubject(userId)
      .setIssuer(this.config.get('JWT_ISSUER'))
      .setAudience(`${this.config.get('JWT_AUDIENCE')}:step-up`)
      .setIssuedAt()
      .setExpirationTime(`${this.config.get('STEP_UP_TTL_SECONDS')}s`)
      .sign(this.privateKey);
  }

  async verifyStepUp(token: string, userId: string): Promise<boolean> {
    try {
      const { payload } = await jwtVerify(token, this.publicKey, {
        algorithms: [ALG],
        issuer: this.config.get('JWT_ISSUER'),
        audience: `${this.config.get('JWT_AUDIENCE')}:step-up`,
      });
      return payload.typ === 'step_up' && payload.sub === userId;
    } catch {
      return false;
    }
  }

  /** 256-bit opaque refresh token; only its SHA-256 is stored. */
  newRefreshToken(): { raw: string; hash: string } {
    const raw = randomBytes(32).toString('base64url');
    return { raw, hash: TokenService.hash(raw) };
  }

  static hash(raw: string): string {
    return createHash('sha256').update(raw, 'utf8').digest('hex');
  }

  refreshExpiry(now = new Date()): Date {
    return new Date(now.getTime() + this.config.get('REFRESH_TOKEN_TTL_DAYS') * 86_400_000);
  }
}
