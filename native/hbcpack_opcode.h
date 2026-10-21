/* Opcode descriptor shared by the generated per-version tables (hbcpack_opcodes96.h, hbcpack_opcodes98.h). */
#ifndef HBCPACK_OPCODE_H
#define HBCPACK_OPCODE_H
#include <stdint.h>

#define HBCPACK_MAX_OPERANDS 6
#define HBCPACK_NUM_OPERAND_STREAMS 16
/* Operand stream indices: 0=reg8 1=reg32 2=u8 3=u16 4=u32 5=str8 6=str16 7=str32 8=fn16 9=fn32 10=bi16 11=bi32 12=addr8 13=addr32 14=imm32 15=dbl64 */

typedef struct {
  const char *name;      /* NULL for unassigned opcodes */
  uint8_t n;             /* operand count */
  uint8_t width[6];      /* bytes per operand */
  int8_t stream[6];      /* operand stream index */
  int8_t cache_si;       /* string-id operand index for property-cache ops, else -1 */
  int8_t cache_ci;       /* cache-index operand index, else -1 */
  uint8_t cache_write;   /* 1 = write cache (Put/Define) */
  uint8_t sw;            /* 0 none, 1 uint switch (SwitchImm/UIntSwitchImm), 2 string switch */
} hbcpack_opcode;

#endif
