#!/usr/bin/env node
/**
 * The executable. It exists so that `index.ts` can be imported by a test without launching a
 * harness: an entry point that runs on import is an entry point you cannot test.
 *
 * `process.exitCode` rather than `process.exit()` — the harness's output is on inherited stdio and
 * an immediate `exit()` can truncate a final write that has not drained. Setting the code and
 * letting the event loop empty gives the same exit status without the lost line.
 */
import { main } from './index.ts';
import { ApiError } from './api.ts';

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    const message = err instanceof ApiError ? err.message : `sponsoredtokens: ${err instanceof Error ? err.message : String(err)}`;
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
