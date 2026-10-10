/**
 * NBT（Named Binary Tag）读写器。读取覆盖标准 0..12 标签并自动识别 gzip/zlib，
 * 因而既可读未压缩 servers.dat，也可安全读取压缩的世界 level.dat。
 * 写入器只暴露启动器当前需要的 servers.dat 子集。
 */

import zlib from 'node:zlib';
import { translate as t } from '../../shared/i18n';

export interface NbtCompound {
  [key: string]: unknown;
}

// ---------------- 读 ----------------
class Reader {
  private off = 0;
  constructor(private buf: Buffer) {}

  private ensure(bytes: number): void {
    if (!Number.isInteger(bytes) || bytes < 0 || this.off + bytes > this.buf.length) {
      throw new Error(t('nbt.error.truncated'));
    }
  }

  type(): number {
    this.ensure(1);
    return this.buf.readUInt8(this.off++);
  }

  byte(): number {
    this.ensure(1);
    return this.buf.readInt8(this.off++);
  }
  short(): number {
    this.ensure(2);
    const v = this.buf.readInt16BE(this.off);
    this.off += 2;
    return v;
  }
  unsignedShort(): number {
    this.ensure(2);
    const v = this.buf.readUInt16BE(this.off);
    this.off += 2;
    return v;
  }
  int(): number {
    this.ensure(4);
    const v = this.buf.readInt32BE(this.off);
    this.off += 4;
    return v;
  }
  long(): number | string {
    this.ensure(8);
    const value = this.buf.readBigInt64BE(this.off);
    this.off += 8;
    return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value.toString();
  }
  float(): number {
    this.ensure(4);
    const value = this.buf.readFloatBE(this.off);
    this.off += 4;
    return value;
  }
  double(): number {
    this.ensure(8);
    const value = this.buf.readDoubleBE(this.off);
    this.off += 8;
    return value;
  }
  string(): string {
    const len = this.unsignedShort();
    this.ensure(len);
    const s = this.buf.toString('utf-8', this.off, this.off + len);
    this.off += len;
    return s;
  }

  private collectionLength(): number {
    const length = this.int();
    if (length < 0 || length > 1_000_000) throw new Error(t('nbt.error.collection_length', { length }));
    return length;
  }

  payload(type: number, depth = 0): unknown {
    if (depth > 64) throw new Error(t('nbt.error.too_deep'));
    switch (type) {
      case 1:
        return this.byte();
      case 2:
        return this.short();
      case 3:
        return this.int();
      case 4:
        return this.long();
      case 5:
        return this.float();
      case 6:
        return this.double();
      case 7: {
        const length = this.collectionLength();
        this.ensure(length);
        const value = Buffer.from(this.buf.subarray(this.off, this.off + length));
        this.off += length;
        return value;
      }
      case 8:
        return this.string();
      case 9: {
        const itemType = this.type();
        const len = this.collectionLength();
        const arr: unknown[] = [];
        for (let i = 0; i < len; i++) arr.push(this.payload(itemType, depth + 1));
        return arr;
      }
      case 10: {
        const obj: NbtCompound = {};
        for (;;) {
          const tagId = this.type();
          if (tagId === 0) break;
          const name = this.string();
          obj[name] = this.payload(tagId, depth + 1);
        }
        return obj;
      }
      case 11: {
        const length = this.collectionLength();
        return Array.from({ length }, () => this.int());
      }
      case 12: {
        const length = this.collectionLength();
        return Array.from({ length }, () => this.long());
      }
      default:
        throw new Error(t('nbt.error.unsupported_type', { type }));
    }
  }
}

const MAX_DECOMPRESSED_NBT = 64 * 1024 * 1024;

function decompressNbt(buf: Buffer): Buffer {
  if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
    return zlib.gunzipSync(buf, { maxOutputLength: MAX_DECOMPRESSED_NBT });
  }
  if (buf.length >= 2 && buf[0] === 0x78) {
    try {
      return zlib.inflateSync(buf, { maxOutputLength: MAX_DECOMPRESSED_NBT });
    } catch {
      // 0x78 也可能恰好是未压缩数据的一部分，按原数据继续解析。
    }
  }
  if (buf.length > MAX_DECOMPRESSED_NBT) throw new Error(t('nbt.error.too_large'));
  return buf;
}

/** 解析未压缩、gzip 或 zlib NBT 为根 Compound。 */
export function parseNbt(buf: Buffer): NbtCompound {
  const r = new Reader(decompressNbt(buf));
  const rootType = r.type();
  if (rootType !== 10) throw new Error(t('nbt.error.root_not_compound'));
  r.string(); // root name（通常为空）
  return r.payload(10) as NbtCompound;
}

// ---------------- 写 ----------------
class Writer {
  private parts: Buffer[] = [];
  byte(v: number): void {
    const b = Buffer.alloc(1);
    b.writeInt8(v);
    this.parts.push(b);
  }
  short(v: number): void {
    const b = Buffer.alloc(2);
    b.writeInt16BE(v);
    this.parts.push(b);
  }
  int(v: number): void {
    const b = Buffer.alloc(4);
    b.writeInt32BE(v);
    this.parts.push(b);
  }
  long(v: bigint): void {
    const b = Buffer.alloc(8);
    b.writeBigInt64BE(v);
    this.parts.push(b);
  }
  string(v: string): void {
    const b = Buffer.from(v, 'utf-8');
    this.short(b.length);
    this.parts.push(b);
  }
  buffer(): Buffer {
    return Buffer.concat(this.parts);
  }
}

function writePayload(w: Writer, type: number, value: unknown): void {
  switch (type) {
    case 1:
      w.byte(value as number);
      break;
    case 3:
      w.int(value as number);
      break;
    case 4:
      w.long(value as bigint);
      break;
    case 9: {
      const list = value as NbtList;
      w.byte(list.itemType);
      w.int(list.values.length);
      for (const item of list.values) writePayload(w, list.itemType, item);
      break;
    }
    case 8:
      w.string(value as string);
      break;
    case 10: {
      for (const [k, v] of Object.entries(value as NbtCompound)) {
        const tagId = tagTypeOf(v);
        w.byte(tagId);
        w.string(k);
        writePayload(w, tagId, v);
      }
      w.byte(0);
      break;
    }
    default:
      throw new Error(t('nbt.error.unsupported_write_type', { type }));
  }
}

function tagTypeOf(v: unknown): number {
  if (v instanceof NbtList) return 9;
  if (typeof v === 'bigint') return 4;
  if (typeof v === 'string') return 8;
  if (typeof v === 'number') return Number.isInteger(v) && Math.abs(v) < 128 ? 1 : 3;
  if (typeof v === 'object' && v !== null) return 10;
  throw new Error(t('nbt.error.unknown_type'));
}

export class NbtList {
  constructor(
    public itemType: number,
    public values: unknown[]
  ) {}
}

/** 序列化根 Compound 为 NBT 二进制 */
export function writeNbt(root: NbtCompound): Buffer {
  const w = new Writer();
  w.byte(10);
  w.string('');
  writePayload(w, 10, root);
  return w.buffer();
}

/** 构造 servers.dat 内容：servers: List[Compound{name, ip}] */
export function buildServersDat(list: Array<{ name: string; ip: string }>): Buffer {
  const w = new Writer();
  w.byte(10); // root compound
  w.string('');
  // "servers" list of compound(10)
  w.byte(9);
  w.string('servers');
  w.byte(10); // item type: compound
  w.int(list.length);
  for (const s of list) {
    w.byte(8);
    w.string('name');
    w.string(s.name);
    w.byte(8);
    w.string('ip');
    w.string(s.ip);
    w.byte(0); // end compound item
  }
  w.byte(0); // end root
  return w.buffer();
}
