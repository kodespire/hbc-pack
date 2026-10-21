// Instruction set tables for HBC v98, loaded from ref/opcodes.json (generated from Hermes's
// BytecodeList.def by ref/gen-opcodes.mjs). Provides instruction walking and exact re-emission.
import { readFileSync } from 'node:fs';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname);

export const OPERAND_SIZE = { Reg8: 1, Reg32: 4, UInt8: 1, UInt16: 2, UInt32: 4, Addr8: 1, Addr32: 4, Imm32: 4, Double: 8 };
export const SIGNED = new Set(['Addr8', 'Addr32', 'Imm32']);

let table = null;
export function loadOpcodes(file = path.join(HERE, '../ref/opcodes.json')) {
  if (table) return table;
  const json = JSON.parse(readFileSync(file, 'utf8'));
  const list = Array.isArray(json) ? json : json.opcodes;
  table = new Array(256).fill(null);
  for (const op of list) {
    const operands = op.operands.map((o) => ({ ...o, size: o.size ?? OPERAND_SIZE[o.type] }));
    table[op.opcode] = { ...op, operands, length: 1 + operands.reduce((a, o) => a + o.size, 0) };
  }
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

// Walks one function's bytecode. Returns the instruction list plus the byte range of anything
// after the last decodable instruction (switch jump tables live there, 4-byte aligned).
// `stopAt` lets the caller cut the walk before an inline table (first SwitchImm table offset).
export function walk(code, start, end, stopAt = end) {
  const ops = loadOpcodes();
  const out = [];
  let pos = start;
  while (pos < stopAt) {
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

export function emit(instructions, out, pos) {
  const ops = loadOpcodes();
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
