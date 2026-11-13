// claude's done signal: the task prompt asks it to end its final reply with a line that says DONE, and the transcript
// reader (tools/usage.js) marks the turn that ended so. Read by the runner under Node: no DOM here.

export const DONE_MARK = 'DONE';

// The line the task prompt ends with.
export const DONE_ASK = `When the task is complete, end your final reply with a line that says only ${DONE_MARK}. Leave it out while anything is unfinished or you need an answer from me.`;

// Whether a reply ends with the mark on its own line. Markdown around it (bold, code, a full stop) still counts.
/** @param {string} text @returns {boolean} */
export function saysDone(text) {
  const last = text.trimEnd().split('\n').at(-1) ?? '';
  return last.replace(/[*_`~.!\s]/g, '') === DONE_MARK;
}
