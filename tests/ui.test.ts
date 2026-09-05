/**
 * Colour detection, money, and the spinner's promise that it leaves nothing behind.
 *
 * The detection matrix is the interesting half: every one of these combinations is somebody's real
 * terminal, and the failure they produce — escape codes in a log file, or a plain-looking CLI on a
 * capable terminal — is invisible on the machine this was written on. Which is why `colorLevel`
 * takes a probe: the whole matrix is a table test with no terminal anywhere in it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ASCII_FRAMES,
  BRAILLE_FRAMES,
  banner,
  colorLevel,
  createSpinner,
  inkFor,
  money,
  row,
  spinnerFrames,
  suggestHarness,
  type ColorLevel,
} from '../src/ui.ts';

const probe = (env: NodeJS.ProcessEnv, isTTY: boolean, platform: NodeJS.Platform = 'darwin') => ({ env, isTTY, platform });

// ── Detection ─────────────────────────────────────────────────────────────────────────────────

test('a pipe gets no colour, a terminal does', () => {
  assert.equal(colorLevel(probe({ TERM: 'xterm-256color' }, false)), 0);
  assert.equal(colorLevel(probe({ TERM: 'xterm-256color' }, true)), 2);
});

test('NO_COLOR silences a terminal, and an empty NO_COLOR does not', () => {
  assert.equal(colorLevel(probe({ TERM: 'xterm-256color', NO_COLOR: '1' }, true)), 0);
  assert.equal(colorLevel(probe({ TERM: 'xterm-256color', NO_COLOR: '' }, true)), 2);
});

test('NO_COLOR beats FORCE_COLOR — two contradictory requests resolve to the harmless one', () => {
  assert.equal(colorLevel(probe({ NO_COLOR: '1', FORCE_COLOR: '3' }, true)), 0);
});

test('TERM=dumb is off however capable everything else claims to be', () => {
  assert.equal(colorLevel(probe({ TERM: 'dumb', COLORTERM: 'truecolor' }, true)), 0);
});

test('FORCE_COLOR turns colour on for a pipe, and its number picks the level', () => {
  assert.equal(colorLevel(probe({ FORCE_COLOR: '1' }, false)), 1);
  assert.equal(colorLevel(probe({ FORCE_COLOR: '2' }, false)), 2);
  assert.equal(colorLevel(probe({ FORCE_COLOR: '3' }, false)), 3);
  assert.equal(colorLevel(probe({ FORCE_COLOR: '0', COLORTERM: 'truecolor' }, true)), 0);
});

test('COLORTERM is what promotes a terminal to truecolour', () => {
  assert.equal(colorLevel(probe({ TERM: 'xterm-256color', COLORTERM: 'truecolor' }, true)), 3);
  assert.equal(colorLevel(probe({ TERM: 'xterm-256color', COLORTERM: '24bit' }, true)), 3);
  assert.equal(colorLevel(probe({ TERM: 'xterm' }, true)), 1);
});

test('Windows is detected, never enabled: Terminal is truecolour, conhost gets the 256 cube', () => {
  assert.equal(colorLevel(probe({ WT_SESSION: 'x' }, true, 'win32')), 3);
  assert.equal(colorLevel(probe({}, true, 'win32')), 2);
  assert.equal(colorLevel(probe({}, false, 'win32')), 0);
});

// ── The palette ───────────────────────────────────────────────────────────────────────────────

test('level 0 is the identity — no escape byte reaches a pipe', () => {
  const style = inkFor(0);
  assert.equal(style.accent('x') + style.muted('y') + style.code('z') + style.link('u'), 'xyzu');
});

test('the accent is the brand orange at 24-bit, its cube neighbour at 256, and bold below that', () => {
  assert.equal(inkFor(3).accent('$5'), '\u001b[38;2;217;119;87m$5\u001b[0m');
  assert.equal(inkFor(2).accent('$5'), '\u001b[38;5;209m$5\u001b[0m');
  assert.equal(inkFor(1).accent('$5'), '\u001b[1m$5\u001b[0m');
});

test('the wordmark is one word with a coloured slash, and reads plainly without colour', () => {
  assert.equal(banner('0.1.0', inkFor(0)), '  sponsored/tokens  0.1.0');
  const coloured = banner('0.1.0', inkFor(3));
  assert.ok(coloured.includes('\u001b[38;2;217;119;87m/\u001b[0m'));
  assert.equal(coloured.replace(/\u001b\[[0-9;]*m/g, ''), '  sponsored/tokens  0.1.0');
});

test('a row is padded before it is coloured, so the column survives the escape codes', () => {
  for (const level of [0, 1, 2, 3] as ColorLevel[]) {
    const line = row('Pool', 'x', inkFor(level));
    assert.equal(line.replace(/\u001b\[[0-9;]*m/g, ''), '  Pool      x');
  }
});

// ── Money ─────────────────────────────────────────────────────────────────────────────────────

test('cents appear only when there are cents', () => {
  assert.equal(money(162_450), '$1,624.50');
  assert.equal(money(326_200), '$3,262');
  assert.equal(money(48_200), '$482');
  assert.equal(money(22_750), '$227.50');
  assert.equal(money(9_000), '$90');
  assert.equal(money(5), '$0.05');
  assert.equal(money(0), '$0');
});

test('grouping starts at four digits and keeps up', () => {
  assert.equal(money(99_900), '$999');
  assert.equal(money(100_000), '$1,000');
  assert.equal(money(123_456_789), '$1,234,567.89');
});

test('a negative balance is signed rather than mangled, and nonsense is $0', () => {
  assert.equal(money(-1_050), '-$10.50');
  assert.equal(money(Number.NaN), '$0');
  assert.equal(money(Number.POSITIVE_INFINITY), '$0');
});

// ── The spinner ───────────────────────────────────────────────────────────────────────────────

function fakeStream(isTTY: boolean): { isTTY: boolean; chunks: string[]; write(chunk: string): void } {
  const chunks: string[] = [];
  return {
    isTTY,
    chunks,
    write(chunk: string): void {
      chunks.push(chunk);
    },
  };
}

test('on a terminal the spinner rewrites one line and erases it on stop', () => {
  const stream = fakeStream(true);
  const spinner = createSpinner(stream, 'Waiting for approval…', { intervalMs: 1_000_000 });
  spinner.start();
  spinner.tick();
  spinner.tick();
  spinner.stop();

  assert.equal(stream.chunks.at(-1), '\r\u001b[K', 'the last thing written must erase the line');
  const all = stream.chunks.join('');
  assert.ok(!all.includes('\n'), 'a spinner that emits a newline is a spinner that scrolls');
  assert.ok(all.includes(BRAILLE_FRAMES[0]!) && all.includes(BRAILLE_FRAMES[1]!), 'the frames advance');
  assert.equal(stream.chunks.filter((chunk) => chunk.includes('Waiting for approval…')).length, 3);
});

test('off a terminal it says it once and then nothing at all — logs must not collect frames', () => {
  const stream = fakeStream(false);
  const spinner = createSpinner(stream, 'Waiting for approval…');
  spinner.start();
  spinner.tick();
  spinner.tick();
  spinner.stop();
  assert.deepEqual(stream.chunks, ['  Waiting for approval…\n']);
});

test('stopping one that never started writes nothing, and a second stop erases nothing twice', () => {
  const never = fakeStream(true);
  createSpinner(never, 'x', { intervalMs: 1_000_000 }).stop();
  assert.deepEqual(never.chunks, []);

  const stream = fakeStream(true);
  const spinner = createSpinner(stream, 'x', { intervalMs: 1_000_000 });
  spinner.start();
  spinner.stop();
  spinner.stop();
  assert.equal(stream.chunks.filter((chunk) => chunk === '\r\u001b[K').length, 1);
});

test('braille everywhere except a Windows console with no evidence it can draw it', () => {
  assert.equal(spinnerFrames({}, 'darwin'), BRAILLE_FRAMES);
  assert.equal(spinnerFrames({ WT_SESSION: 'x' }, 'win32'), BRAILLE_FRAMES);
  assert.equal(spinnerFrames({}, 'win32'), ASCII_FRAMES);
});

// ── The suggestion ────────────────────────────────────────────────────────────────────────────

test('`Try:` names a harness the user already has, in preference order', () => {
  assert.equal(suggestHarness((bin) => bin === 'codex'), 'codex');
  assert.equal(suggestHarness((bin) => bin === 'codex' || bin === 'claude'), 'claude');
  assert.equal(suggestHarness(() => false), 'claude');
  assert.equal(
    suggestHarness(() => {
      throw new Error('PATH exploded');
    }),
    'claude',
  );
});
