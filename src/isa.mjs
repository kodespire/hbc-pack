// Instruction set tables per HBC version, loaded from the profile's opcodes.json (generated from
// Hermes's BytecodeList.def by ref/gen-opcodes.mjs). Instruction walking and exact re-emission.
import { readFileSync } from 'node:fs';
import { profileFor } from './profiles.mjs';

export const OPERAND_SIZE = { Reg8: 1, Reg32: 4, UInt8: 1, UInt16: 2, UInt32: 4, Addr8: 1, Addr32: 4, Imm32: 4, Double: 8 };

// Operand stream key: semantic class + width (shared by the codec and the native decoder).
const CLASS_OF = { register: 'reg', uint: 'u', string_id: 'str', function_id: 'fn', bigint_id: 'bi', jump_offset: 'addr', immediate: 'imm', double: 'dbl' };
export const OPERAND_STREAMS = ['reg8', 'reg32', 'u8', 'u16', 'u32', 'str8', 'str16', 'str32', 'fn16', 'fn32', 'bi16', 'bi32', 'addr8', 'addr32', 'imm32', 'dbl64'];
export const streamKey = (o) => `${CLASS_OF[o.semantic] ?? o.semantic}${o.size * 8}`;

const tables = new Map();

// The opcode table for a bytecode version: array[256] of
//   { opcode, name, operands: [{type, size, semantic, key, streamIndex}], length, switchKind, cache }
// cache = { si, ci, write } for property-cache instructions (a string id plus a 1-byte cache index).
export function opcodes(version) {
  if (tables.has(version)) return tables.get(version);
  const profile = profileFor(version);
  const json = JSON.parse(readFileSync(profile.opcodesFile, 'utf8'));
  const list = Array.isArray(json) ? json : json.opcodes;
  const table = new Array(256).fill(null);
  for (const op of list) {
    const operands = op.operands.map((o) => {
      const size = o.size ?? OPERAND_SIZE[o.type];
      const key = streamKey({ ...o, size });
      return { ...o, size, key, streamIndex: OPERAND_STREAMS.indexOf(key) };
    });
    if (operands.some((o) => o.streamIndex < 0)) throw new Error(`${op.name}: unknown operand class`);
    const si = operands.findIndex((o) => o.semantic === 'string_id');
    const ci = operands.findIndex((o) => o.semantic === 'uint' && o.size === 1);
    const cache = si >= 0 && ci >= 0 && /ById/.test(op.name) ? { si, ci, write: /Put|Define/.test(op.name) } : null;
    table[op.opcode] = { ...op, operands, length: 1 + operands.reduce((a, o) => a + o.size, 0), switchKind: profile.switchOps[op.name] ?? null, cache };
  }
  tables.set(version, table);
  return table;
}

export function readOperand(buf, pos, type) {
  switch (type) {
    case 'Reg8': case 'UInt8': return buf[pos];
    case 'Addr8': return (buf[pos] << 24) >> 24;
    case 'UInt16': return buf[pos] | (buf[pos + 1] << 8);
    case 'Reg32': case 'UInt32': return (buf[pos] | (buf[pos + 1] << 8) | (buf[pos + 2] << 16) | (buf[pos + 3] << 24)) >>> 0;
    case 'Addr32': case 'Imm32': return buf[pos] | (buf[pos + 1] << 8) | (buf[pos + 2] << 16) | (buf[pos + 3] << 24);
    case 'Double': return new DataView(buf.buffer, buf.byteOffset + pos, 8).getFloat64(0, true);
    default: throw new Error(`operand type ${type}`);
  }
}

export function writeOperand(buf, pos, type, v) {
  switch (type) {
    case 'Reg8': case 'UInt8': case 'Addr8': buf[pos] = v & 0xff; return;
    case 'UInt16': buf[pos] = v & 0xff; buf[pos + 1] = (v >>> 8) & 0xff; return;
    case 'Reg32': case 'UInt32': case 'Addr32': case 'Imm32':
      buf[pos] = v & 0xff; buf[pos + 1] = (v >>> 8) & 0xff; buf[pos + 2] = (v >>> 16) & 0xff; buf[pos + 3] = (v >>> 24) & 0xff; return;
    case 'Double': new DataView(buf.buffer, buf.byteOffset + pos, 8).setFloat64(0, v, true); return;
    default: throw new Error(`operand type ${type}`);
  }
}

// Walks one function's bytecode [start, end). Returns the instruction list.
export function walk(ops, code, start, end) {
  const out = [];
  let pos = start;
  while (pos < end) {
    const opcode = code[pos];
    const op = ops[opcode];
    if (!op) throw new Error(`unknown opcode ${opcode} at ${pos}`);
    if (pos + op.length > end) throw new Error(`instruction ${op.name} at ${pos} runs past ${end}`);
    const operands = new Array(op.operands.length);
    let p = pos + 1;
    for (let i = 0; i < op.operands.length; i++) {
      operands[i] = readOperand(code, p, op.operands[i].type);
      p += op.operands[i].size;
    }
    out.push({ opcode, offset: pos, operands });
    pos = p;
  }
  return { ops: out, end: pos };
}

export function emit(ops, instructions, out, pos) {
  for (const ins of instructions) {
    const op = ops[ins.opcode];
    out[pos++] = ins.opcode;
    for (let i = 0; i < op.operands.length; i++) {
      writeOperand(out, pos, op.operands[i].type, ins.operands[i]);
      pos += op.operands[i].size;
    }
  }
  return pos;
}

// Bytes of switch tables appended after a body's opcodes, from its switch instructions.
// Both 'uint' switches (SwitchImm/UIntSwitchImm: ..., min, max) and 'string' switches
// (StringSwitchImm: ..., size) use operands 3/4 resp. 4.
export function switchTableBytes(ops, instructions) {
  let bytes = 0;
  for (const ins of instructions) {
    const kind = ops[ins.opcode].switchKind;
    if (kind === 'uint') bytes += 4 * (ins.operands[4] - ins.operands[3] + 1);
    else if (kind === 'string') bytes += 8 * ins.operands[4];
  }
  return bytes;
}
