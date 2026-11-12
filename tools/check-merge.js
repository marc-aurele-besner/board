// The worker and a board tab write the same file: each changes its own field, and both changes must survive.
// The tab is played the way js/store.js saves: read, change in memory, then merge what is on disk and write.
// `node tools/check-merge.js`: exits 1 when a change is lost.
/** @import { InboxMessage } from '../types/data' */
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNodeStore } from './worker/store.js';
import { merge } from '../js/merge.js';

const dir = mkdtempSync(join(tmpdir(), 'board-merge-'));
const file = join(dir, 'inbox.json');
const read = () => JSON.parse(readFileSync(file, 'utf8'));
let failed = 0;
/** @param {boolean} ok @param {string} text */
const expect = (ok, text) => {
  if (!ok) failed += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${text}`);
};

try {
  writeFileSync(file, JSON.stringify({ emails: [{ id: 'a', subject: 'Hello', status: 'received', starred: false }], syncedAt: '' }));

  // The tab loads the file, then the user stars the email while the worker syncs.
  const tabBase = readFileSync(file, 'utf8');
  const tab = JSON.parse(tabBase);
  tab.emails[0].starred = true;

  const store = createNodeStore(dir);
  store.update('inbox', (d) => {
    d.emails[0].status = 'delivered';
    d.emails.push(/** @type {InboxMessage} */ ({ id: 'b', subject: 'New', status: 'received' })); // only the fields this test reads
    d.syncedAt = 'now';
  });
  store.flush();

  // The tab saves: merge what is on disk (the worker's write) into its own change, then write.
  merge(JSON.parse(tabBase), tab, read());
  writeFileSync(file, JSON.stringify(tab));

  let disk = read();
  expect(disk.emails[0].starred === true, 'the tab’s star survives the worker’s write');
  expect(disk.emails[0].status === 'delivered', 'the worker’s status survives the tab’s write');
  expect(disk.emails.length === 2 && disk.syncedAt === 'now', 'the worker’s new email and sync time survive');

  // Now the other way round: the tab wrote last, the worker writes again and must keep the tab's change.
  tab.emails[1].archived = true;
  merge(read(), tab, read());
  writeFileSync(file, JSON.stringify(tab));
  store.update('inbox', (d) => {
    d.emails[1].status = 'delivered';
  });
  store.flush();
  disk = read();
  expect(disk.emails[1].archived === true && disk.emails[1].status === 'delivered', 'the worker keeps a field the tab wrote after its last read');
  expect(disk.emails[0].starred === true, 'the earlier star is still there');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
