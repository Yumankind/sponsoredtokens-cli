/**
 * The QR encoder, against known-good symbols.
 *
 * `tests/qr-fixture.ts` carries four whole matrices produced by a reference implementation; its
 * header says which and why those four. Everything here either compares against them or checks a
 * property the fixtures cannot express (capacity arithmetic, the drawn width, the refusal).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QR_FIXTURES } from './qr-fixture.ts';
import { MAX_VERSION, QUIET, QrTooLongError, capacity, encodeQr, qrColumns, qrLines, versionFor } from '../src/qr.ts';

/** The matrix as the fixture spells it, so a mismatch prints two readable pictures. */
function rowsOf(size: number, modules: boolean[]): string[] {
  const rows: string[] = [];
  for (let r = 0; r < size; r += 1) {
    let line = '';
    for (let c = 0; c < size; c += 1) line += modules[r * size + c] ? '1' : '0';
    rows.push(line);
  }
  return rows;
}

for (const fixture of QR_FIXTURES) {
  test(`${fixture.name}: every module matches the reference symbol (v${fixture.version})`, () => {
    const qr = encodeQr(fixture.text);
    assert.equal(qr.version, fixture.version);
    assert.equal(qr.size, fixture.size);
    assert.deepEqual(rowsOf(qr.size, qr.modules), [...fixture.rows]);
  });
}

// ── Capacity ──────────────────────────────────────────────────────────────────────────────────

test('byte-mode capacity at level L matches the standard’s table', () => {
  // ISO/IEC 18004 table 7, the L column, versions 1–20.
  assert.deepEqual(
    Array.from({ length: MAX_VERSION }, (_, i) => capacity(i + 1)),
    [17, 32, 53, 78, 106, 134, 154, 192, 230, 271, 321, 367, 425, 458, 520, 586, 644, 718, 792, 858],
  );
});

test('the version chosen is the smallest one that fits, on both sides of every boundary', () => {
  for (let version = 1; version <= MAX_VERSION; version += 1) {
    assert.equal(versionFor(capacity(version)), version, `${capacity(version)} bytes should be version ${version}`);
    if (version < MAX_VERSION) assert.equal(versionFor(capacity(version) + 1), version + 1);
  }
});

test('a payload past version 20 is refused by name rather than truncated', () => {
  const tooLong = 'x'.repeat(capacity(MAX_VERSION) + 1);
  assert.throws(() => encodeQr(tooLong), QrTooLongError);
  assert.equal(versionFor(tooLong.length), null);
});

test('a multi-byte character counts as its UTF-8 bytes, not as one character', () => {
  // 17 bytes is exactly version 1; the same count of three-byte characters is not.
  assert.equal(encodeQr('x'.repeat(17)).version, 1);
  assert.equal(encodeQr('☕'.repeat(6)).version, 2); // 18 bytes
});

// ── Drawing ───────────────────────────────────────────────────────────────────────────────────

test('the drawing is two module rows per line, with the quiet zone on every side', () => {
  const qr = encodeQr('https://sponsoredtokens.com');
  const lines = qrLines(qr);
  assert.equal(qrColumns(qr), qr.size + QUIET * 2);
  assert.equal(lines.length, Math.ceil(qrColumns(qr) / 2));
  for (const line of lines) {
    assert.equal(line.replace(/\[[0-9;]*m/g, '').length, qrColumns(qr), 'every line is the same visible width');
  }
});

test('a real Stripe-length link still fits an 80-column terminal', () => {
  const qr = encodeQr(QR_FIXTURES.find((f) => f.name === 'stripe')!.text);
  assert.equal(qr.version, 12);
  assert.ok(qrColumns(qr) <= 80, `${qrColumns(qr)} columns must fit 80`);
});

test('every cell is painted black or white explicitly, so the terminal theme cannot hide it', () => {
  const line = qrLines(encodeQr('HELLO'))[0]!;
  // 30/97 foreground and 40/107 background — never a default, never the ink's accent.
  for (const codes of line.matchAll(/\[([0-9;]+)m/g)) {
    assert.match(codes[1]!, /^(0|(30|97);(40|107))$/, `unexpected escape ${JSON.stringify(codes[1])}`);
  }
  assert.ok(line.endsWith('[0m'), 'each line resets the colour it set');
});
