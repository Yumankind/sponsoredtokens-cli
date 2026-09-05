/**
 * A QR code, encoded and drawn in the terminal, with no dependency at all.
 *
 * `sponsoredtokens sponsor` prints a Stripe Checkout link that a HUMAN has to open and pay. An
 * agent on a server and a person with a phone are rarely at the same keyboard, so the link is also
 * drawn as a QR: the operator points a camera at the terminal and pays. That is the whole reason
 * this file exists, and it is also what fixes its parameters.
 *
 * ── WHY VERSIONS 1–20 AND NOT 1–6 ───────────────────────────────────────────────────────────────
 *
 * Versions 1–6 are the tidy subset — one alignment pattern, no version-information block — and they
 * were the plan. They cannot carry the payload. A Stripe Checkout URL is
 * `https://checkout.stripe.com/f/pay/cs_live_…#fid…` and the `#fid…` fragment is not optional: a
 * session minted against the live account on 2026-09-05 measured 479 bytes. Version 6 at error
 * level L holds 134. So the ceiling here is version 20 (858 bytes) — which is the difference
 * between a feature and a picture that never draws.
 *
 * WHAT THAT COSTS, MEASURED. 479 bytes lands on version 15: 77 modules, 85 terminal columns with
 * the quiet zone. So the symbol appears on a window 85 columns wide or more, and `index.ts` prints
 * nothing at all on a narrower one — a wrapped QR code is not a QR code. Shortening the link at the
 * pool (a `/p/<id>` redirect, say) would take the payload under 40 bytes and the drawing under 40
 * columns; that is a worker change, and until it exists this is the honest boundary.
 *
 * Error level L throughout: this symbol is read once, from a screen, at arm's length, by a phone
 * that can simply be moved. Spending a quarter of the capacity on recovery would push it past 90
 * columns for no gain a reader would ever notice.
 *
 * ── HOW IT IS VERIFIED ──────────────────────────────────────────────────────────────────────────
 *
 * `tests/qr.test.ts` compares whole matrices — every module, including the chosen mask — against
 * fixtures generated once from `node-qrcode` 1.5.4, a spec-conformant implementation. The four
 * fixtures are chosen to cover what actually differs between versions: v1 (one block), v2 (an
 * alignment pattern), v8 (the version-information block, two error blocks) and v12 (a 16-bit
 * character count, four blocks split across two group sizes). A mask chosen one step differently
 * changes every module, so the comparison is as strict as a test here can be.
 *
 * The penalty rules below are ISO/IEC 18004's, in node-qrcode's phrasing of them, because mask
 * selection has to agree with a reference implementation for the fixtures to mean anything. Note
 * that the widely-used `qrcode-generator` scores rule 1 differently and picks another mask for some
 * inputs; both symbols are valid and scan, but only one can be compared byte for byte.
 */

// ── GF(256), for Reed–Solomon ─────────────────────────────────────────────────────────────────

/** The field QR uses: x^8 + x^4 + x^3 + x^2 + 1, with α = 2. Doubled so a log sum needs no modulo. */
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i += 1) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i += 1) EXP[i] = EXP[i - 255]!;
}

function mul(a: number, b: number): number {
  return a === 0 || b === 0 ? 0 : EXP[LOG[a]! + LOG[b]!]!;
}

/** ∏ (x − α^i) for i < degree, coefficients high-order first. */
function generatorPoly(degree: number): Uint8Array {
  let poly = new Uint8Array([1]);
  for (let i = 0; i < degree; i += 1) {
    const next = new Uint8Array(poly.length + 1);
    for (let j = 0; j < poly.length; j += 1) {
      // Coefficients are high-order first: multiplying by `x` keeps the index, multiplying by α^i
      // moves it one place down. The other way round builds the generator backwards, which still
      // divides cleanly and produces error correction no scanner can use.
      next[j] = next[j]! ^ poly[j]!;
      next[j + 1] = next[j + 1]! ^ mul(poly[j]!, EXP[i]!);
    }
    poly = next;
  }
  return poly;
}

/** The remainder of `data · x^degree` divided by the generator: this block's error correction. */
function errorCorrection(data: Uint8Array, degree: number): Uint8Array {
  const gen = generatorPoly(degree);
  const buffer = new Uint8Array(data.length + degree);
  buffer.set(data);
  for (let i = 0; i < data.length; i += 1) {
    const factor = buffer[i]!;
    if (factor === 0) continue;
    for (let j = 0; j < gen.length; j += 1) buffer[i + j] = buffer[i + j]! ^ mul(gen[j]!, factor);
  }
  return buffer.slice(data.length);
}

// ── The three version tables ──────────────────────────────────────────────────────────────────

/**
 * Total codewords per version (data + error correction). Independent of the error level.
 *
 * With the two tables below this is everything needed: the block split is DERIVED rather than
 * tabulated (see `codewords`), which is one table instead of four and cannot disagree with itself.
 */
const TOTAL_CODEWORDS = [26, 44, 70, 100, 134, 172, 196, 242, 292, 346, 404, 466, 532, 581, 655, 733, 815, 901, 991, 1085] as const;

/** Error-correction codewords at level L, per version. */
const EC_CODEWORDS_L = [7, 10, 15, 20, 26, 36, 40, 48, 60, 72, 80, 96, 104, 120, 132, 144, 168, 180, 196, 224] as const;

/** Error-correction blocks at level L, per version. */
const EC_BLOCKS_L = [1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8] as const;

/** Alignment-pattern centre coordinates, per version. Version 1 has none. */
const ALIGNMENT = [
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
  [6, 30, 54],
  [6, 32, 58],
  [6, 34, 62],
  [6, 26, 46, 66],
  [6, 26, 48, 70],
  [6, 26, 50, 74],
  [6, 30, 54, 78],
  [6, 30, 56, 82],
  [6, 30, 58, 86],
  [6, 34, 62, 90],
] as const;

/** The highest version this encoder draws. See the header for why it is 20 and not 6. */
export const MAX_VERSION = ALIGNMENT.length;

const dataCodewords = (version: number): number => TOTAL_CODEWORDS[version - 1]! - EC_CODEWORDS_L[version - 1]!;

/** Bits in the byte-mode character count: 8 up to version 9, 16 from version 10. */
const countBits = (version: number): number => (version < 10 ? 8 : 16);

/** How many bytes a version holds in byte mode at level L, after the mode and count header. */
export function capacity(version: number): number {
  return Math.floor((dataCodewords(version) * 8 - 4 - countBits(version)) / 8);
}

/** The smallest version that holds `byteLength`, or null when nothing here does. */
export function versionFor(byteLength: number): number | null {
  for (let version = 1; version <= MAX_VERSION; version += 1) {
    if (byteLength <= capacity(version)) return version;
  }
  return null;
}

const symbolSize = (version: number): number => version * 4 + 17;

// ── Codewords ─────────────────────────────────────────────────────────────────────────────────

/**
 * Data + error correction, interleaved, ready to place.
 *
 * The block split is derived the way `node-qrcode` derives it: the remainder of the total over the
 * block count is how many blocks belong to the LONGER group, and both groups carry the same number
 * of error-correction codewords. That reproduces the standard's table for every version without
 * writing the table down.
 */
function codewords(bytes: Uint8Array, version: number): Uint8Array {
  const total = TOTAL_CODEWORDS[version - 1]!;
  const ecTotal = EC_CODEWORDS_L[version - 1]!;
  const blocks = EC_BLOCKS_L[version - 1]!;
  const dataTotal = total - ecTotal;

  const longBlocks = total % blocks;
  const shortBlocks = blocks - longBlocks;
  const shortData = Math.floor(dataTotal / blocks);
  const ecPerBlock = Math.floor(total / blocks) - shortData;

  // ── The bit stream: mode, count, the bytes, a terminator, then the two pad codewords.
  const bits: number[] = [];
  const put = (value: number, width: number): void => {
    for (let i = width - 1; i >= 0; i -= 1) bits.push((value >>> i) & 1);
  };
  put(0b0100, 4);
  put(bytes.length, countBits(version));
  for (const byte of bytes) put(byte, 8);

  const capacityBits = dataTotal * 8;
  if (bits.length + 4 <= capacityBits) put(0, 4);
  while (bits.length % 8 !== 0) bits.push(0);

  const buffer = new Uint8Array(dataTotal);
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j += 1) byte = (byte << 1) | bits[i + j]!;
    buffer[i / 8] = byte;
  }
  for (let i = bits.length / 8; i < dataTotal; i += 1) {
    buffer[i] = (i - bits.length / 8) % 2 === 0 ? 0xec : 0x11;
  }

  // ── Split, encode, interleave.
  const data: Uint8Array[] = [];
  const ec: Uint8Array[] = [];
  let offset = 0;
  for (let b = 0; b < blocks; b += 1) {
    const size = b < shortBlocks ? shortData : shortData + 1;
    const block = buffer.slice(offset, offset + size);
    offset += size;
    data.push(block);
    ec.push(errorCorrection(block, ecPerBlock));
  }

  const out = new Uint8Array(total);
  let index = 0;
  const longest = shortData + (longBlocks > 0 ? 1 : 0);
  for (let i = 0; i < longest; i += 1) {
    for (const block of data) if (i < block.length) out[index++] = block[i]!;
  }
  for (let i = 0; i < ecPerBlock; i += 1) {
    for (const block of ec) out[index++] = block[i]!;
  }
  return out;
}

// ── Format and version information ────────────────────────────────────────────────────────────

function bchDigit(value: number): number {
  let digit = 0;
  let rest = value;
  while (rest !== 0) {
    digit += 1;
    rest >>>= 1;
  }
  return digit;
}

/** 15 bits: level (L = 01) and mask, BCH(15,5)-coded and XOR'd with the standard's mask. */
function formatBits(mask: number): number {
  const data = (0b01 << 3) | mask;
  let d = data << 10;
  while (bchDigit(d) - bchDigit(0x537) >= 0) d ^= 0x537 << (bchDigit(d) - bchDigit(0x537));
  return ((data << 10) | d) ^ 0x5412;
}

/** 18 bits: the version, BCH(18,6)-coded. Only versions 7 and above carry it. */
function versionBits(version: number): number {
  let d = version << 12;
  while (bchDigit(d) - bchDigit(0x1f25) >= 0) d ^= 0x1f25 << (bchDigit(d) - bchDigit(0x1f25));
  return (version << 12) | d;
}

// ── The matrix ────────────────────────────────────────────────────────────────────────────────

export interface QrCode {
  version: number;
  /** Modules per side, not counting the quiet zone. */
  size: number;
  /** The mask the penalty rules chose, 0–7. Reported for the tests, not for the reader. */
  mask: number;
  /** Row-major, `true` where the module is dark. */
  modules: boolean[];
}

/** A payload no version up to `MAX_VERSION` can hold. Thrown by name so a caller can say so. */
export class QrTooLongError extends Error {
  readonly byteLength: number;
  constructor(byteLength: number) {
    super(`${byteLength} bytes is more than a version-${MAX_VERSION} QR code holds (${capacity(MAX_VERSION)})`);
    this.name = 'QrTooLongError';
    this.byteLength = byteLength;
  }
}

interface Grid {
  size: number;
  dark: boolean[];
  reserved: boolean[];
}

function grid(size: number): Grid {
  return { size, dark: new Array<boolean>(size * size).fill(false), reserved: new Array<boolean>(size * size).fill(false) };
}

function set(g: Grid, row: number, col: number, dark: boolean, reserve = false): void {
  g.dark[row * g.size + col] = dark;
  if (reserve) g.reserved[row * g.size + col] = true;
}

const isDark = (g: Grid, row: number, col: number): boolean => g.dark[row * g.size + col]!;
const isReserved = (g: Grid, row: number, col: number): boolean => g.reserved[row * g.size + col]!;

function finderPatterns(g: Grid): void {
  for (const [row, col] of [
    [0, 0],
    [0, g.size - 7],
    [g.size - 7, 0],
  ] as const) {
    for (let r = -1; r <= 7; r += 1) {
      if (row + r < 0 || row + r >= g.size) continue;
      for (let c = -1; c <= 7; c += 1) {
        if (col + c < 0 || col + c >= g.size) continue;
        const dark =
          (r >= 0 && r <= 6 && (c === 0 || c === 6)) ||
          (c >= 0 && c <= 6 && (r === 0 || r === 6)) ||
          (r >= 2 && r <= 4 && c >= 2 && c <= 4);
        set(g, row + r, col + c, dark, true);
      }
    }
  }
}

function timingPatterns(g: Grid): void {
  for (let i = 8; i < g.size - 8; i += 1) {
    const dark = i % 2 === 0;
    set(g, i, 6, dark, true);
    set(g, 6, i, dark, true);
  }
}

function alignmentPatterns(g: Grid, version: number): void {
  const centres = ALIGNMENT[version - 1]!;
  for (let i = 0; i < centres.length; i += 1) {
    for (let j = 0; j < centres.length; j += 1) {
      // The three that would sit on a finder pattern are simply not drawn.
      const corner = (i === 0 && j === 0) || (i === 0 && j === centres.length - 1) || (i === centres.length - 1 && j === 0);
      if (corner) continue;
      const row = centres[i]!;
      const col = centres[j]!;
      for (let r = -2; r <= 2; r += 1) {
        for (let c = -2; c <= 2; c += 1) {
          set(g, row + r, col + c, r === -2 || r === 2 || c === -2 || c === 2 || (r === 0 && c === 0), true);
        }
      }
    }
  }
}

function writeVersionInfo(g: Grid, version: number): void {
  if (version < 7) return;
  const bits = versionBits(version);
  for (let i = 0; i < 18; i += 1) {
    const row = Math.floor(i / 3);
    const col = (i % 3) + g.size - 11;
    const dark = ((bits >> i) & 1) === 1;
    set(g, row, col, dark, true);
    set(g, col, row, dark, true);
  }
}

function writeFormatInfo(g: Grid, mask: number): void {
  const bits = formatBits(mask);
  for (let i = 0; i < 15; i += 1) {
    const dark = ((bits >> i) & 1) === 1;
    if (i < 6) set(g, i, 8, dark, true);
    else if (i < 8) set(g, i + 1, 8, dark, true);
    else set(g, g.size - 15 + i, 8, dark, true);

    if (i < 8) set(g, 8, g.size - i - 1, dark, true);
    else if (i < 9) set(g, 8, 15 - i, dark, true);
    else set(g, 8, 14 - i, dark, true);
  }
  // The one module that is dark in every symbol ever made.
  set(g, g.size - 8, 8, true, true);
}

/** The zig-zag: column pairs from the right, skipping the timing column, alternating direction. */
function writeData(g: Grid, data: Uint8Array): void {
  let inc = -1;
  let row = g.size - 1;
  let bit = 7;
  let byte = 0;
  for (let col = g.size - 1; col > 0; col -= 2) {
    if (col === 6) col -= 1;
    for (;;) {
      for (let c = 0; c < 2; c += 1) {
        if (isReserved(g, row, col - c)) continue;
        const dark = byte < data.length ? ((data[byte]! >>> bit) & 1) === 1 : false;
        set(g, row, col - c, dark);
        bit -= 1;
        if (bit === -1) {
          byte += 1;
          bit = 7;
        }
      }
      row += inc;
      if (row < 0 || row >= g.size) {
        row -= inc;
        inc = -inc;
        break;
      }
    }
  }
}

function maskAt(mask: number, i: number, j: number): boolean {
  switch (mask) {
    case 0:
      return (i + j) % 2 === 0;
    case 1:
      return i % 2 === 0;
    case 2:
      return j % 3 === 0;
    case 3:
      return (i + j) % 3 === 0;
    case 4:
      return (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0;
    case 5:
      return ((i * j) % 2) + ((i * j) % 3) === 0;
    case 6:
      return (((i * j) % 2) + ((i * j) % 3)) % 2 === 0;
    default:
      return (((i * j) % 3) + ((i + j) % 2)) % 2 === 0;
  }
}

function applyMask(g: Grid, mask: number): void {
  for (let row = 0; row < g.size; row += 1) {
    for (let col = 0; col < g.size; col += 1) {
      if (isReserved(g, row, col)) continue;
      if (maskAt(mask, row, col)) g.dark[row * g.size + col] = !g.dark[row * g.size + col]!;
    }
  }
}

/** ISO/IEC 18004's four rules. Lower is better; the numbers are the standard's. */
function penalty(g: Grid): number {
  const n = g.size;
  let points = 0;

  // 1 — runs of five or more of one colour, in both directions.
  for (let a = 0; a < n; a += 1) {
    let runRow = 0;
    let runCol = 0;
    let lastRow: boolean | null = null;
    let lastCol: boolean | null = null;
    for (let b = 0; b < n; b += 1) {
      const inRow = isDark(g, a, b);
      if (inRow === lastRow) runRow += 1;
      else {
        if (runRow >= 5) points += 3 + (runRow - 5);
        lastRow = inRow;
        runRow = 1;
      }
      const inCol = isDark(g, b, a);
      if (inCol === lastCol) runCol += 1;
      else {
        if (runCol >= 5) points += 3 + (runCol - 5);
        lastCol = inCol;
        runCol = 1;
      }
    }
    if (runRow >= 5) points += 3 + (runRow - 5);
    if (runCol >= 5) points += 3 + (runCol - 5);
  }

  // 2 — every 2×2 block of one colour.
  for (let row = 0; row < n - 1; row += 1) {
    for (let col = 0; col < n - 1; col += 1) {
      const sum =
        Number(isDark(g, row, col)) + Number(isDark(g, row, col + 1)) + Number(isDark(g, row + 1, col)) + Number(isDark(g, row + 1, col + 1));
      if (sum === 0 || sum === 4) points += 3;
    }
  }

  // 3 — the finder-lookalike 1:1:3:1:1 with four light modules either side.
  for (let a = 0; a < n; a += 1) {
    let row = 0;
    let col = 0;
    for (let b = 0; b < n; b += 1) {
      row = ((row << 1) & 0x7ff) | Number(isDark(g, a, b));
      if (b >= 10 && (row === 0x5d0 || row === 0x05d)) points += 40;
      col = ((col << 1) & 0x7ff) | Number(isDark(g, b, a));
      if (b >= 10 && (col === 0x5d0 || col === 0x05d)) points += 40;
    }
  }

  // 4 — how far the proportion of dark modules is from half.
  let dark = 0;
  for (const module of g.dark) if (module) dark += 1;
  points += Math.abs(Math.ceil(((dark * 100) / g.dark.length) / 5) - 10) * 10;

  return points;
}

/**
 * Encode `text` as a QR symbol at error level L.
 *
 * Throws `QrTooLongError` when the payload is past version 20, which the caller treats as "print
 * the link without a picture" rather than as a failure of the command.
 */
export function encodeQr(text: string): QrCode {
  const bytes = new TextEncoder().encode(text);
  const version = versionFor(bytes.length);
  if (version === null) throw new QrTooLongError(bytes.length);

  const size = symbolSize(version);
  const g = grid(size);
  finderPatterns(g);
  timingPatterns(g);
  alignmentPatterns(g, version);
  // Written with mask 0 first only to RESERVE the format modules, so masking cannot touch them.
  writeFormatInfo(g, 0);
  writeVersionInfo(g, version);
  writeData(g, codewords(bytes, version));

  let mask = 0;
  let best = Infinity;
  for (let candidate = 0; candidate < 8; candidate += 1) {
    // The format modules carry the candidate's own bits while it is scored: they are part of the
    // symbol, and scoring them with mask 0's bits would rank the eight against the wrong picture.
    writeFormatInfo(g, candidate);
    applyMask(g, candidate);
    const score = penalty(g);
    applyMask(g, candidate);
    if (score < best) {
      best = score;
      mask = candidate;
    }
  }
  applyMask(g, mask);
  writeFormatInfo(g, mask);

  return { version, size, mask, modules: g.dark.slice() };
}

// ── Drawing it ────────────────────────────────────────────────────────────────────────────────

/** The standard's quiet zone: four light modules on every side, and scanners rely on it. */
export const QUIET = 4;

/** How many terminal columns the drawing needs, quiet zone included. */
export function qrColumns(qr: QrCode, quiet = QUIET): number {
  return qr.size + quiet * 2;
}

/**
 * The symbol as terminal lines, two module rows per line.
 *
 * `▀` paints its top half in the foreground colour and its bottom half in the background, so one
 * character cell carries two vertical modules — and since a cell is about twice as tall as it is
 * wide, that is what makes the printed square actually square.
 *
 * THE COLOURS ARE EXPLICIT AND NOT THE INK'S. A QR code has to be dark-on-light whatever the
 * reader's terminal theme is; drawing it in the foreground colour would render it black-on-black
 * for half the world. So: black and white, named, on every cell. Callers that cannot emit ANSI
 * must not call this — there is no way to guarantee contrast without it (see `index.ts`).
 */
export function qrLines(qr: QrCode, quiet = QUIET): string[] {
  const span = qrColumns(qr, quiet);
  const dark = (row: number, col: number): boolean => {
    const r = row - quiet;
    const c = col - quiet;
    if (r < 0 || c < 0 || r >= qr.size || c >= qr.size) return false;
    return qr.modules[r * qr.size + c]!;
  };

  const lines: string[] = [];
  for (let row = 0; row < span; row += 2) {
    let line = '';
    let pen = '';
    for (let col = 0; col < span; col += 1) {
      // 30/97 are black and bright-white foreground; 40/107 the same two as background.
      const codes = `${dark(row, col) ? 30 : 97};${dark(row + 1, col) ? 40 : 107}`;
      if (codes !== pen) {
        line += `\u001b[${codes}m`;
        pen = codes;
      }
      line += '▀';
    }
    lines.push(`${line}\u001b[0m`);
  }
  return lines;
}
