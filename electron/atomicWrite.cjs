'use strict';

const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

// Monotonic per-process counter so two concurrent writes to the SAME target
// (e.g. an accidental double Save) never share a temp filename.
let seq = 0;

/**
 * Atomically write `data` to `resolvedPath` -- an ALREADY-VALIDATED, resolved
 * absolute path; callers must run the write-policy checks (writePathPolicy.cjs)
 * BEFORE calling this (F2).
 *
 * Writes to a sibling temp file `<basename>.<pid>.<seq>.<random>.tmp` in the
 * SAME directory as resolvedPath (so the final rename is same-volume and
 * atomic), fsyncs it, closes it, then renames it over the target -- Node's
 * fs.rename replaces an existing destination file on Windows in one
 * filesystem operation, so there is never a truncated (O_TRUNC) window where
 * the original is gone but the new data isn't fully on disk yet.
 *
 * The temp file is opened with the exclusive 'wx' flag (O_CREAT | O_EXCL),
 * not plain 'w': 'w' would silently open (and follow) a symlink pre-planted
 * at the temp path, while 'wx' fails closed if ANYTHING already exists there
 * (file or symlink). The random suffix (on top of pid+seq) means the name
 * can't be guessed in advance, so there's nothing for an attacker to
 * pre-plant a symlink at in the first place (review fix round 1, MINOR 3).
 *
 * On ANY failure (open/write/fsync/rename), the temp file is removed
 * (best-effort -- a cleanup failure never masks the original error) and the
 * target is left completely untouched; the triggering error is rethrown.
 * The cleanup unlink only runs if OUR open() call actually succeeded (review
 * fix round 2, MINOR 3): if open() itself is what failed, nothing was created
 * by this call, and unconditionally unlinking the (guessed/unwritten) temp
 * path could otherwise delete an unrelated pre-existing entry we never touched.
 *
 * The temp path is derived purely from resolvedPath's own directory and
 * basename -- never from separate renderer-supplied input -- so it can't be
 * used to bypass the policy that already validated resolvedPath, and its
 * '.tmp' suffix is never itself checked against (or accepted from) the
 * renderer-facing write-extension allow-list.
 *
 * `fsImpl` is injectable for unit tests (default: real node:fs.promises);
 * only `open`, `rename`, and `unlink` are used from it, matching the
 * fsImpl-injection pattern already used by writePathPolicy.cjs.
 */
async function atomicWriteFile(resolvedPath, data, fsImpl = fs.promises) {
  const dir = path.dirname(resolvedPath);
  const randomSuffix = crypto.randomBytes(4).toString('hex');
  const tempPath = path.join(
    dir,
    `${path.basename(resolvedPath)}.${process.pid}.${++seq}.${randomSuffix}.tmp`
  );

  let fh = null;
  let created = false;
  try {
    fh = await fsImpl.open(tempPath, 'wx');
    created = true; // open() succeeded -- WE own this path now, safe to clean up
    await fh.writeFile(data);
    await fh.sync();
    await fh.close();
    fh = null; // closed -- the catch block below must not double-close it
    await fsImpl.rename(tempPath, resolvedPath);
  } catch (err) {
    if (fh) {
      await fh.close().catch(() => {});
    }
    if (created) {
      await fsImpl.unlink(tempPath).catch(() => {});
    }
    throw err;
  }
}

module.exports = { atomicWriteFile };
