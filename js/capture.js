// Reads a line of text as a task: "fix the footer #atlas !high friday".
// Used by the search palette and by tasks sent through Telegram, so both understand the same words.
import { todayISO, uid, now } from './ui.js';

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const iso = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);

// The date a trailing word means: today, tomorrow, a weekday (the next one), or a YYYY-MM-DD date.
function dateFromWord(word) {
  const w = word.toLowerCase();
  const d = new Date();
  if (w === 'today') return todayISO();
  if (w === 'tomorrow') {
    d.setDate(d.getDate() + 1);
    return iso(d);
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(w)) return w;
  const day = WEEKDAYS.findIndex((name) => name === w || name.slice(0, 3) === w);
  if (day < 0) return '';
  d.setDate(d.getDate() + (((day - d.getDay() + 7) % 7) || 7));
  return iso(d);
}

// A "#tag" matches a project by its name without spaces, by the start of its name, or by one of its words.
const squash = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
export function findProject(projects, tag) {
  const t = squash(tag);
  if (!t) return null;
  return projects.find((p) => squash(p.name) === t)
    ?? projects.find((p) => squash(p.name).startsWith(t))
    ?? projects.find((p) => p.name.toLowerCase().split(/\s+/).some((word) => squash(word) === t))
    ?? null;
}

// Returns { text, projectId, tag, priority, due }. `tag` is set when "#tag" named no existing project.
export function parseTask(raw, projects) {
  let text = String(raw ?? '').trim();
  let priority = 'none';
  let due = '';
  text = text.replace(/(?:^|\s)!(high|medium|low)\b/i, (_, p) => {
    priority = p.toLowerCase();
    return ' ';
  });
  const tagMatch = text.match(/(?:^|\s)#([\w-]+)/);
  if (tagMatch) text = text.replace(tagMatch[0], ' ');
  text = text.replace(/\s+/g, ' ').trim();
  const last = text.split(' ').pop() ?? '';
  const date = dateFromWord(last);
  if (date && text.includes(' ')) {
    due = date;
    text = text.slice(0, text.length - last.length).trim();
  }
  const project = tagMatch ? findProject(projects, tagMatch[1]) : null;
  return { text, projectId: project?.id ?? null, tag: tagMatch && !project ? tagMatch[1] : '', priority, due };
}

// The stored shape of a task. Every place that creates one goes through here, so new fields have one default.
export function makeTask(fields = {}) {
  return { id: uid(), text: '', description: '', status: 'todo', priority: 'none', category: '', projectId: null, due: '', created: now(), ...fields };
}
