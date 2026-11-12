// Three-way merge of a collection: what this tab last read from disk (base), what it holds now (ours) and what is
// on disk now (theirs). Another tab or browser on the same folder saves whole files too, so without this the last
// save erased whatever the other one added. Ours is changed in place, so objects the sections still hold (a task
// open in a dialog) stay the ones in the store.

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const same = (a, b) => a === b || JSON.stringify(a) === JSON.stringify(b);
const hasIds = (arr) => arr.every((x) => isObj(x) && x.id != null);
const isPlainList = (arr) => arr.every((x) => x === null || typeof x !== 'object') && new Set(arr).size === arr.length;

export function merge(base, ours, theirs) {
  if (same(ours, theirs)) return ours;
  if (isObj(ours) && isObj(theirs)) return mergeObject(base, ours, theirs);
  if (Array.isArray(ours) && Array.isArray(theirs)) {
    if (ours.length + theirs.length && hasIds(ours) && hasIds(theirs)) return mergeById(base, ours, theirs);
    if (isPlainList(ours) && isPlainList(theirs)) return mergeList(base, ours, theirs);
  }
  // Both changed the same value: the edit made here wins.
  return same(base, ours) ? theirs : ours;
}

function mergeObject(base, ours, theirs) {
  const b = isObj(base) ? base : {};
  for (const key of new Set([...Object.keys(ours), ...Object.keys(theirs)])) {
    if (key in ours && key in theirs) {
      ours[key] = merge(b[key], ours[key], theirs[key]);
    } else if (key in theirs) {
      // Added there, or changed there while removed here: keep it.
      if (!(key in b) || !same(b[key], theirs[key])) ours[key] = theirs[key];
    } else if (key in b && same(b[key], ours[key])) {
      delete ours[key]; // removed there, untouched here
    }
  }
  return ours;
}

// Lists of things with an id (tasks, projects, entries) merge item by item. Order follows ours, and an item only
// the other side has goes after the item it follows there.
function mergeById(base, ours, theirs) {
  const index = (arr) => new Map(arr.map((x) => [x.id, x]));
  const b = index(Array.isArray(base) ? base.filter(isObj) : []);
  const o = index(ours);
  const t = index(theirs);
  const kept = [];
  for (const item of ours) {
    if (t.has(item.id)) kept.push(merge(b.get(item.id), item, t.get(item.id)));
    else if (!b.has(item.id) || !same(b.get(item.id), item)) kept.push(item); // new here, or edited here
  }
  theirs.forEach((item, i) => {
    if (o.has(item.id)) return;
    if (b.has(item.id) && same(b.get(item.id), item)) return; // removed here, untouched there
    let at = 0;
    for (let j = i - 1; j >= 0; j--) {
      const k = kept.findIndex((x) => x.id === theirs[j].id);
      if (k >= 0) {
        at = k + 1;
        break;
      }
    }
    kept.splice(at, 0, item);
  });
  ours.splice(0, ours.length, ...kept);
  return ours;
}

// Lists of names (categories, hidden ids) merge as sets: keep what either side added, drop what either removed.
function mergeList(base, ours, theirs) {
  const b = Array.isArray(base) ? base : [];
  const kept = ours.filter((x) => theirs.includes(x) || !b.includes(x));
  for (const x of theirs) if (!b.includes(x) && !kept.includes(x)) kept.push(x);
  ours.splice(0, ours.length, ...kept);
  return ours;
}
