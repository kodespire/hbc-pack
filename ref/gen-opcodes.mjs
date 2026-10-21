#!/usr/bin/env node
// gen-opcodes.mjs
//
// Parses hermes include/hermes/BCGen/HBC/BytecodeList.def (the X-macro list
// that defines the HBC opcodes) and emits opcodes.json.
//
// Usage:
//   node gen-opcodes.mjs [path/to/BytecodeList.def] [path/to/output.json]
// Defaults: BytecodeList.def and opcodes.json next to this script.
//
// Expansion rules (mirroring the C++ preprocessor, as used by
// BytecodeInstructionGenerator.h and BytecodeList.def at the pinned commit):
//   - DEFINE_OPERAND_TYPE(Name, ctype)      declares an operand type.
//   - DEFINE_OPCODE_N(name, t1..tN)         one opcode, N operands (N = 0..6).
//   - DEFINE_JUMP_1(name)                   two opcodes, in this order:
//                                             name      (Addr8  jump target)
//                                             nameLong  (Addr32 jump target)
//   - DEFINE_JUMP_2(name)                   name(Addr8,Reg8), nameLong(Addr32,Reg8)
//   - DEFINE_JUMP_3(name)                   name(Addr8,Reg8,Reg8), nameLong(Addr32,Reg8,Reg8)
//   - DEFINE_JUMP_LONG_VARIANT(a, b)        links short opcode a to long opcode b.
//   - DEFINE_RET_TARGET(name)               marks name as having a return target.
//   - OPERAND_STRING_ID(name, n)            operand n (1-based) is a string id.
//   - OPERAND_FUNCTION_ID(name, n)          operand n (1-based) is a function id.
//   - OPERAND_BIGINT_ID(name, n)            operand n (1-based) is a bigint id.
//   - ASSERT_EQUAL_LAYOUTn / ASSERT_MONOTONE_INCREASING  are checked, not emitted.
// Opcode numbers are assigned in order of expansion, starting at 0. That is
// the order of the `enum Operator { DEFINE_OPCODE(name) name##Op, ... }` in
// BytecodeInstructionGenerator.h, where every DEFINE_OPCODE_N and DEFINE_JUMP_N
// expansion routes to DEFINE_OPCODE(name).
//
// Preprocessor directives (#ifndef/#define/#undef/#endif and any backslash
// continuation lines) are skipped; the #define default bodies are not
// executed. Only the file-level invocations are expanded.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const defPath = process.argv[2] ?? path.join(here, 'BytecodeList.def');
const outPath = process.argv[3] ?? path.join(here, 'opcodes.json');

// C types used by DEFINE_OPERAND_TYPE and their sizes on the target
// (x86-64 / arm64, little-endian).
const CTYPE_SIZE = {
  uint8_t: 1,
  int8_t: 1,
  uint16_t: 2,
  int16_t: 2,
  uint32_t: 4,
  int32_t: 4,
  uint64_t: 8,
  int64_t: 8,
  double: 8,
};

// Semantic defaults inferred from operand type when no OPERAND_*_ID
// annotation exists (per the task brief).
function defaultSemantic(typeName) {
  switch (typeName) {
    case 'Reg8':
    case 'Reg32':
      return 'register';
    case 'Addr8':
    case 'Addr32':
      return 'jump_offset';
    case 'Imm32':
      return 'immediate';
    case 'Double':
      return 'double';
    default:
      return 'uint';
  }
}

const ANNOTATION_SEMANTIC = {
  OPERAND_STRING_ID: 'string_id',
  OPERAND_FUNCTION_ID: 'function_id',
  OPERAND_BIGINT_ID: 'bigint_id',
};

const src = fs.readFileSync(defPath, 'utf8');

// ---------------------------------------------------------------------------
// 1. Strip comments and preprocessor directives (including continuation lines).
// ---------------------------------------------------------------------------
function stripBlockComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
}

const lines = stripBlockComments(src).split('\n');
const body = [];
for (let i = 0; i < lines.length; i++) {
  let line = lines[i].replace(/\/\/.*$/, '');
  const trimmed = line.trim();
  if (trimmed.startsWith('#')) {
    // Skip the directive and any continuation lines (ending in backslash).
    let cont = trimmed.endsWith('\\');
    while (cont && i + 1 < lines.length) {
      i++;
      cont = lines[i].replace(/\/\/.*$/, '').trimEnd().endsWith('\\');
    }
    continue;
  }
  body.push(line);
}
const text = body.join('\n');

// ---------------------------------------------------------------------------
// 2. Extract top-level macro invocations NAME(args...), spanning lines.
// ---------------------------------------------------------------------------
const MACRO_NAMES = new Set([
  'DEFINE_OPERAND_TYPE',
  'DEFINE_OPCODE_0',
  'DEFINE_OPCODE_1',
  'DEFINE_OPCODE_2',
  'DEFINE_OPCODE_3',
  'DEFINE_OPCODE_4',
  'DEFINE_OPCODE_5',
  'DEFINE_OPCODE_6',
  'DEFINE_JUMP_1',
  'DEFINE_JUMP_2',
  'DEFINE_JUMP_3',
  'DEFINE_JUMP_LONG_VARIANT',
  'DEFINE_RET_TARGET',
  'OPERAND_STRING_ID',
  'OPERAND_FUNCTION_ID',
  'OPERAND_BIGINT_ID',
  'ASSERT_EQUAL_LAYOUT1',
  'ASSERT_EQUAL_LAYOUT2',
  'ASSERT_EQUAL_LAYOUT3',
  'ASSERT_EQUAL_LAYOUT4',
  'ASSERT_MONOTONE_INCREASING',
]);

const invocations = [];
{
  const re = /\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const name = m[1];
    if (!MACRO_NAMES.has(name)) continue;
    // Find the matching close paren.
    let depth = 0;
    let j = m.index + m[0].length - 1; // index of '('
    let end = -1;
    for (; j < text.length; j++) {
      if (text[j] === '(') depth++;
      else if (text[j] === ')') {
        depth--;
        if (depth === 0) {
          end = j;
          break;
        }
      }
    }
    if (end < 0) throw new Error(`unterminated ${name}( at offset ${m.index}`);
    const inner = text.slice(m.index + m[0].length, end);
    const args = inner
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    invocations.push({ name, args, offset: m.index });
    re.lastIndex = end + 1;
  }
}

// ---------------------------------------------------------------------------
// 3. Expand in file order.
// ---------------------------------------------------------------------------
const operandTypes = {}; // name -> { ctype, size, signed, float }
const opcodes = []; // { name, operandTypes: [..], annotations: {n: semantic}, longOf?, shortOf?, ... }
const byName = new Map();
const retTargetNames = [];
const annotations = []; // { kind, name, n }
const longLinks = []; // { short, long }
const monotoneLists = [];
const layoutAssertions = [];

function addOpcode(name, opTypes) {
  if (byName.has(name)) throw new Error(`duplicate opcode name ${name}`);
  const op = {
    opcode: opcodes.length,
    name,
    operandTypes: opTypes,
    annotations: {},
    hasRetTarget: false,
    longVariant: null,
    shortVariant: null,
  };
  opcodes.push(op);
  byName.set(name, op);
  return op;
}

for (const inv of invocations) {
  const { name, args } = inv;
  switch (name) {
    case 'DEFINE_OPERAND_TYPE': {
      if (args.length !== 2) throw new Error('DEFINE_OPERAND_TYPE arity');
      const [tname, ctype] = args;
      if (!(ctype in CTYPE_SIZE)) throw new Error(`unknown ctype ${ctype}`);
      operandTypes[tname] = {
        ctype,
        size: CTYPE_SIZE[ctype],
        signed: ctype.startsWith('int'),
        float: ctype === 'double',
      };
      break;
    }
    case 'DEFINE_OPCODE_0':
    case 'DEFINE_OPCODE_1':
    case 'DEFINE_OPCODE_2':
    case 'DEFINE_OPCODE_3':
    case 'DEFINE_OPCODE_4':
    case 'DEFINE_OPCODE_5':
    case 'DEFINE_OPCODE_6': {
      const n = Number(name.slice(-1));
      if (args.length !== n + 1) throw new Error(`${name} arity ${args.length}`);
      addOpcode(args[0], args.slice(1));
      break;
    }
    case 'DEFINE_JUMP_1':
    case 'DEFINE_JUMP_2':
    case 'DEFINE_JUMP_3': {
      // Expansion of the macro bodies in BytecodeList.def, in order:
      //   DEFINE_OPCODE_N(name, Addr8, <rest>)
      //   DEFINE_OPCODE_N(name##Long, Addr32, <rest>)
      //   DEFINE_JUMP_LONG_VARIANT(name, name##Long)
      const n = Number(name.slice(-1));
      if (args.length !== 1) throw new Error(`${name} arity`);
      const base = args[0];
      const rest = Array.from({ length: n - 1 }, () => 'Reg8');
      const shortOp = addOpcode(base, ['Addr8', ...rest]);
      const longOp = addOpcode(base + 'Long', ['Addr32', ...rest]);
      shortOp.longVariant = longOp.name;
      longOp.shortVariant = shortOp.name;
      longLinks.push({ short: base, long: base + 'Long', via: name });
      break;
    }
    case 'DEFINE_JUMP_LONG_VARIANT': {
      const [a, b] = args;
      const sop = byName.get(a);
      const lop = byName.get(b);
      if (!sop || !lop) throw new Error(`DEFINE_JUMP_LONG_VARIANT unknown ${a} ${b}`);
      sop.longVariant = b;
      lop.shortVariant = a;
      longLinks.push({ short: a, long: b, via: name });
      break;
    }
    case 'DEFINE_RET_TARGET': {
      retTargetNames.push(args[0]);
      break;
    }
    case 'OPERAND_STRING_ID':
    case 'OPERAND_FUNCTION_ID':
    case 'OPERAND_BIGINT_ID': {
      annotations.push({ kind: name, name: args[0], n: Number(args[1]) });
      break;
    }
    case 'ASSERT_MONOTONE_INCREASING': {
      monotoneLists.push(args);
      break;
    }
    default: {
      // ASSERT_EQUAL_LAYOUTn(a, b): record only, checked below.
      if (name.startsWith('ASSERT_EQUAL_LAYOUT')) layoutAssertions.push({ name, args });
    }
  }
}

// ---------------------------------------------------------------------------
// 4. Apply post-hoc annotations and sanity checks.
// ---------------------------------------------------------------------------
for (const a of annotations) {
  const op = byName.get(a.name);
  if (!op) throw new Error(`annotation for unknown opcode ${a.name}`);
  if (a.n < 1 || a.n > op.operandTypes.length)
    throw new Error(`annotation ${a.kind}(${a.name}, ${a.n}) out of range`);
  op.annotations[a.n] = ANNOTATION_SEMANTIC[a.kind];
}
for (const r of retTargetNames) {
  const op = byName.get(r);
  if (!op) throw new Error(`DEFINE_RET_TARGET unknown ${r}`);
  op.hasRetTarget = true;
}
const monotoneViolations = [];
for (const list of monotoneLists) {
  let prev = -1;
  for (const nm of list) {
    const op = byName.get(nm);
    if (!op) throw new Error(`ASSERT_MONOTONE_INCREASING unknown ${nm}`);
    if (op.opcode <= prev) monotoneViolations.push(nm);
    prev = op.opcode;
  }
}
if (monotoneViolations.length) throw new Error(`monotone violation: ${monotoneViolations}`);

// Layout assertions: ASSERT_EQUAL_LAYOUTn(a, b) requires the first n operand
// types of a and b to be identical (n is the digit in the macro name, which
// matches the operand count of the pair in the file). Verified here.
const layoutFailures = [];
for (const la of layoutAssertions) {
  const n = Number(la.name.slice(-1));
  const [a, b] = la.args;
  const oa = byName.get(a);
  const ob = byName.get(b);
  if (!oa || !ob) {
    layoutFailures.push(`${la.name}(${a}, ${b}) unknown name`);
    continue;
  }
  const ta = oa.operandTypes.slice(0, n).join(',');
  const tb = ob.operandTypes.slice(0, n).join(',');
  if (ta !== tb) layoutFailures.push(`${la.name}(${a}, ${b}): [${ta}] vs [${tb}]`);
}

// ---------------------------------------------------------------------------
// 5. Emit JSON.
// ---------------------------------------------------------------------------
const out = {
  generatedBy: 'hbc-pack/ref/gen-opcodes.mjs',
  sourceFile: 'include/hermes/BCGen/HBC/BytecodeList.def',
  hermesCommit: '7f41c52586c320ef8341fa3a7ba10c6c3212bc6f',
  hermesTag: 'hermes-v250829098.0.9',
  bytecodeVersion: 98,
  opcodeIdByte: 'opcode is one byte (opcode_atom_t = uint8_t); operands follow immediately, little-endian',
  operandTypes: Object.fromEntries(
    Object.entries(operandTypes).map(([k, v]) => [k, { ctype: v.ctype, size: v.size, signed: v.signed }]),
  ),
  opcodeCount: opcodes.length,
  layoutAssertionsChecked: layoutAssertions.length,
  layoutAssertionFailures: layoutFailures,
  opcodes: opcodes.map((op) => {
    const operands = op.operandTypes.map((t, idx) => {
      const ot = operandTypes[t];
      if (!ot) throw new Error(`opcode ${op.name} uses undeclared operand type ${t}`);
      const n = idx + 1;
      return {
        index: n,
        type: t,
        size: ot.size,
        signed: ot.signed,
        semantic: op.annotations[n] ?? defaultSemantic(t),
      };
    });
    const size = 1 + operands.reduce((s, o) => s + o.size, 0);
    const entry = {
      opcode: op.opcode,
      name: op.name,
      size,
      operands,
      isJump: operands.some((o) => o.semantic === 'jump_offset'),
      hasRetTarget: op.hasRetTarget,
    };
    if (op.longVariant) entry.longVariant = op.longVariant;
    if (op.shortVariant) entry.shortVariant = op.shortVariant;
    return entry;
  }),
};

fs.writeFileSync(outPath, JSON.stringify(out, null, 2) + '\n');
const jumps = out.opcodes.filter((o) => o.isJump).length;
const rets = out.opcodes.filter((o) => o.hasRetTarget).length;
console.log(
  `wrote ${outPath}: ${out.opcodeCount} opcodes, ${jumps} jump-like, ${rets} with ret target, ` +
    `${layoutAssertions.length} layout asserts (${layoutFailures.length} failures)`,
);
if (layoutFailures.length) {
  console.error(layoutFailures.join('\n'));
  process.exitCode = 1;
}
