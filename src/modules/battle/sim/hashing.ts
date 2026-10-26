// Byte-exact helpers shared with the C# simulation: a .NET BinaryWriter (content hash, BattleCheckpoint.cs) and the
// 32-bit FNV-1a of BattleStateHash.cs.

import { createHash } from "node:crypto";

const scratch = new DataView(new ArrayBuffer(8));

/** Writes like System.IO.BinaryWriter: little endian, strings as 7-bit encoded UTF-8 length + bytes, bool as 1 byte. */
export class BinaryWriter {
  private readonly bytes: number[] = [];

  int(value: number): this {
    scratch.setInt32(0, value, true);
    for (let i = 0; i < 4; i++) this.bytes.push(scratch.getUint8(i));
    return this;
  }

  uint(value: number): this {
    scratch.setUint32(0, value >>> 0, true);
    for (let i = 0; i < 4; i++) this.bytes.push(scratch.getUint8(i));
    return this;
  }

  double(value: number): this {
    scratch.setFloat64(0, value, true);
    for (let i = 0; i < 8; i++) this.bytes.push(scratch.getUint8(i));
    return this;
  }

  bool(value: boolean): this {
    this.bytes.push(value ? 1 : 0);
    return this;
  }

  string(value: string): this {
    const utf8 = Buffer.from(value, "utf8");
    let length = utf8.length;
    while (length >= 0x80) {
      this.bytes.push((length & 0x7f) | 0x80);
      length >>>= 7;
    }
    this.bytes.push(length);
    for (const b of utf8) this.bytes.push(b);
    return this;
  }

  toBuffer(): Buffer {
    return Buffer.from(this.bytes);
  }
}

/** SHA-256 as uppercase hex (C#: BitConverter.ToString(hash).Replace("-", "")). */
export function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex").toUpperCase();
}

/** 32-bit FNV-1a over little-endian values; doubles by their IEEE bits, zero without its sign. */
export class Fnv1a {
  private hash = 0x811c9dc5;

  get value(): number {
    return this.hash >>> 0;
  }

  private byte(b: number): void {
    this.hash = Math.imul((this.hash ^ (b & 0xff)) >>> 0, 16777619) >>> 0;
  }

  int(v: number): this {
    this.byte(v);
    this.byte(v >> 8);
    this.byte(v >> 16);
    this.byte(v >> 24);
    return this;
  }

  uint(v: number): this {
    return this.int(v | 0);
  }

  /** A non-negative safe integer (C# long): low then high 32 bits. */
  long(v: number): this {
    const low = v % 4294967296;
    return this.int(low | 0).int(Math.floor(v / 4294967296) | 0);
  }

  double(v: number): this {
    if (v === 0) return this.int(0).int(0);
    scratch.setFloat64(0, v, true);
    return this.int(scratch.getInt32(0, true)).int(scratch.getInt32(4, true));
  }

  text(s: string | null | undefined): this {
    if (s === null || s === undefined) return this.int(-1);
    this.int(s.length);
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      this.byte(c);
      this.byte(c >> 8);
    }
    return this;
  }
}
