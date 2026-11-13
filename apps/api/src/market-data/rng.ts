import { createHash } from 'node:crypto';
import { type Decimal, d, fromInt } from '@ktrade/finance-core';

const TWO_POW_32 = d('4294967296');
const SIX = d('6');

/**
 * Deterministic integer PRNG: SHA-256 in counter mode over a string seed. Same seed → same stream on
 * every machine and Node version (no platform float behaviour involved). It only ever yields uint32
 * integers; conversion to decimals goes through finance-core (`fromInt`, `d`), so no JS float touches a price.
 * Not cryptographically meaningful here — it only has to be reproducible and well mixed.
 */
export class SeededRng {
  private block: Buffer = Buffer.alloc(0);
  private offset = 0;
  private counter = 0;

  constructor(private readonly seed: string) {}

  nextU32(): number {
    if (this.offset + 4 > this.block.length) {
      this.block = createHash('sha256').update(`${this.seed}#${this.counter++}`).digest();
      this.offset = 0;
    }
    const v = this.block.readUInt32BE(this.offset);
    this.offset += 4;
    return v;
  }

  /** Integer in [0, n). Modulo bias is < 2^-20 for the small n used here. */
  intBelow(n: number): number {
    if (!Number.isSafeInteger(n) || n <= 0)
      throw new RangeError(`intBelow expects a positive integer, got ${n}`);
    return this.nextU32() % n;
  }

  /** Uniform decimal in [0, 1). */
  uniform(): Decimal {
    return fromInt(this.nextU32()).div(TWO_POW_32);
  }

  /**
   * Approximately standard normal (Irwin–Hall: sum of 12 uniforms − 6), bounded to (−6, 6), which
   * conveniently rules out absurd moves. The integer sum stays below 2^36, well within safe-integer range.
   */
  normal(): Decimal {
    let s = 0;
    for (let i = 0; i < 12; i++) s += this.nextU32();
    return fromInt(s).div(TWO_POW_32).minus(SIX);
  }
}
