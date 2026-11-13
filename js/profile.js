// A project's profile: a short Markdown text saying what the project is, built once from its folder, repos and
// website and saved on the project, so AI features read it as context instead of guessing. The Cron "Refresh project
// profile" step calls buildProfile() too; nothing here touches the page.
/** @import { DataStore, Project } from '../types/data' */
/** @typedef {{ read: [string, string][], gaps: string[] }} ProfileSources */
import { ask } from './ai.js';
import { systemPrompt } from './prompts.js';
import { uid, now } from './ui.js';
import { listFolder, readFile, gitStatus } from './terminal.js';
import { fetchRepoOverview } from './github.js';
import { readPageText } from './sitecheck.js';
import { runnerOf } from './dev-core.js';

// Word caps on what is sent, so a large repo cannot run up the cost of a build.
const PAGE_WORDS = 1500;
const DOC_WORDS = 1000;
const TOTAL_WORDS = 6000;
const COMMITS = 30;
const MAX_REPOS = 2;
const MAX_PAGES = 4;

export const emptyProfile = () => ({ text: '', sources: [], updated: '', edited: false, usageId: '' });

// Data folders saved before profiles existed have none; they read as empty.
/** @param {Project | null | undefined} project */
export const profileOf = (project) => ({ ...emptyProfile(), ...(project?.profile ?? {}) });

// The extra pages read besides the website (a blog, docs).
/** @param {Project} project */
const pagesOf = (project) => [...new Set([project.website, ...profileOf(project).sources].filter(Boolean))].slice(0, MAX_PAGES);

// True when there is anything to read: a folder, a repo, the website or an extra URL.
/** @param {Project} project */
export const hasProfileSources = (project) => Boolean(project.localPath || project.github?.repos?.length || pagesOf(project).length);

// The saved profile texts of the given projects, keyed by id, for the prompts of Tidy, Plan my day and Triage.
// Projects without a profile are left out.
/** @param {Project[]} projects @param {Iterable<string | null>} ids */
export function profilesFor(projects, ids) {
  const wanted = new Set(ids);
  /** @type {Record<string, string>} */
  const out = {};
  for (const p of projects) {
    const text = profileOf(p).text.trim();
    if (wanted.has(p.id) && text) out[p.id] = text;
  }
  return out;
}

// The text cut after `max` words, keeping its line breaks.
/** @param {string} text @param {number} max */
export function clipWords(text, max) {
  const re = /\S+/g;
  let n = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    n += 1;
    if (n > max) return `${text.slice(0, m.index).trimEnd()}\n[…cut]`;
  }
  return text;
}

/** @param {string} text */
const countWords = (text) => (text.match(/\S+/g) ?? []).length;

/** @type {[string, RegExp, number][]} */
const DOCS = [
  ['readme', /^readme(\.md|\.markdown|\.txt)?$/i, PAGE_WORDS],
  ['agents', /^agents\.md$/i, DOC_WORDS],
  ['claude', /^claude\.md$/i, DOC_WORDS],
  ['package', /^package\.json$/i, 400],
];

// package.json says the most through its name, description, scripts and dependency names.
/** @param {string} text */
function packageSummary(text) {
  try {
    const pkg = JSON.parse(text);
    return JSON.stringify({
      name: pkg.name,
      description: pkg.description,
      scripts: pkg.scripts,
      dependencies: Object.keys(pkg.dependencies ?? {}),
      devDependencies: Object.keys(pkg.devDependencies ?? {}),
    }, null, 1);
  } catch {
    return text;
  }
}

// The project's folder through the runner: the top-level entries, the docs above, and the last commit subjects.
/** @param {DataStore} store @param {Project} project @param {[string, string][]} read @param {string[]} gaps */
async function readLocal(store, project, read, gaps) {
  const base = runnerOf(store);
  // Only called when the project has a local folder.
  const root = /** @type {string} */ (project.localPath).replace(/\/+$/, '');
  const [listing, git] = await Promise.allSettled([listFolder(base, root), gitStatus(base, root)]);
  if (listing.status === 'rejected') {
    gaps.push(`The local folder ${root} (${listing.reason.message})`);
    return;
  }
  /** @type {{ name: string, dir?: boolean }[]} */
  const entries = listing.value.entries ?? [];
  read.push(['Top-level folder', entries.slice(0, 80).map((e) => (e.dir ? `${e.name}/` : e.name)).join('\n')]);
  // The filter leaves only the docs found.
  const files = /** @type {[string, { name: string }, number][]} */ (DOCS.map(([key, pattern, words]) => [key, entries.find((e) => !e.dir && pattern.test(e.name)), words]).filter(([, e]) => e));
  const texts = await Promise.allSettled(files.map(([, e]) => readFile(base, `${root}/${e.name}`)));
  texts.forEach((r, i) => {
    const [key, entry, words] = files[i];
    if (r.status === 'rejected' || typeof r.value.text !== 'string') {
      gaps.push(`${entry.name} in the local folder (${r.status === 'rejected' ? r.reason.message : 'too large or not text'})`);
      return;
    }
    const text = key === 'package' ? packageSummary(r.value.text) : r.value.text;
    read.push([`Local ${entry.name}`, clipWords(text, words)]);
  });
  if (git.status === 'rejected') gaps.push(`Recent commits (${git.reason.message})`);
  else if (!git.value.repo) gaps.push('Recent commits (the local folder is not a git repository)');
  else read.push(['Recent commit subjects', (git.value.log ?? []).slice(0, COMMITS).map((/** @type {{ subject: string }} */ c) => `- ${c.subject}`).join('\n') || '(none)']);
}

// Each repo's GitHub details. The README is skipped when the local folder already gave one.
/** @param {Project} project @param {[string, string][]} read @param {string[]} gaps @param {boolean} haveReadme */
async function readGithub(project, read, gaps, haveReadme) {
  const repos = project.github.repos.slice(0, MAX_REPOS);
  const results = await Promise.allSettled(repos.map((repo) => fetchRepoOverview(repo)));
  results.forEach((r, i) => {
    const repo = repos[i];
    if (r.status === 'rejected') {
      gaps.push(`GitHub ${repo} (${r.reason.message})`);
      return;
    }
    const d = r.value;
    const lines = [
      d.description ? `Description: ${d.description}` : '',
      d.topics.length ? `Topics: ${d.topics.join(', ')}` : '',
      d.languages.length ? `Languages: ${d.languages.join(', ')}` : '',
      d.files.length ? `Files: ${d.files.map((/** @type {{ name: string, type: string }} */ f) => (f.type === 'dir' ? `${f.name}/` : f.name)).join(', ')}` : '',
      !haveReadme && d.readme ? `README:\n${clipWords(d.readme, PAGE_WORDS)}` : '',
    ].filter(Boolean);
    if (!d.contentAccess) gaps.push(`The README and files of GitHub ${repo} (the token cannot read its contents)`);
    read.push([`GitHub ${repo}`, lines.join('\n') || '(no details)']);
  });
}

/** @param {Project} project @param {[string, string][]} read @param {string[]} gaps */
async function readPages(project, read, gaps) {
  const urls = pagesOf(project);
  const results = await Promise.allSettled(urls.map((url) => readPageText(url)));
  results.forEach((r, i) => {
    if (r.status === 'rejected') gaps.push(`The page ${urls[i]} (${r.reason.message})`);
    else read.push([`Web page ${urls[i]}${r.value.title ? ` — ${r.value.title}` : ''}`, clipWords(r.value.text, PAGE_WORDS)]);
  });
}

// Reads every source the project has. One failing source never stops the others; it is listed in `gaps`.
// Returns { read: [[title, text]], gaps: [text] }.
/** @param {DataStore} store @param {Project} project @returns {Promise<ProfileSources>} */
export async function readProfileSources(store, project) {
  /** @type {[string, string][]} */
  const local = [];
  /** @type {[string, string][]} */
  const remote = [];
  /** @type {string[]} */
  const gaps = [];
  if (!project.localPath) gaps.push('No local folder is set');
  if (!project.github?.repos?.length) gaps.push('No GitHub repository is set');
  if (!pagesOf(project).length) gaps.push('No website or extra URL is set');
  // The local README is read first, so GitHub's copy of it is not sent twice.
  const localDone = project.localPath ? readLocal(store, project, local, gaps).catch((err) => gaps.push(`The local folder (${err.message})`)) : Promise.resolve();
  const pages = readPages(project, remote, gaps);
  await localDone;
  const haveReadme = local.some(([title]) => /^Local readme/i.test(title));
  const github = project.github?.repos?.length ? readGithub(project, remote, gaps, haveReadme) : Promise.resolve();
  await Promise.allSettled([pages, github]);
  return { read: [...local, ...remote], gaps };
}

// The user message: the sources in order, each cut to what is left of the total word budget.
/** @param {Project} project @param {ProfileSources} sources */
export function profileInput(project, { read, gaps }) {
  let left = TOTAL_WORDS;
  const parts = [`# ${project.name}`, project.description ? `Description: ${project.description}` : ''];
  for (const [title, text] of read) {
    if (left <= 0) {
      gaps.push(`${title} (left out: the input was already at its size limit)`);
      continue;
    }
    const body = clipWords(text, left);
    left -= countWords(body);
    // Tags, not headings: the sources' own Markdown headings would blur where one source ends.
    parts.push(`<source name="${title}">\n${body}\n</source>`);
  }
  parts.push(`Sources that could not be read:\n${gaps.length ? gaps.map((g) => `- ${g}`).join('\n') : '(none)'}`);
  return parts.filter(Boolean).join('\n\n');
}

// A reply wrapped in a code fence is unwrapped; the profile itself is Markdown.
/** @param {string} text */
const unfence = (text) => text.trim().replace(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/i, '$1').trim();

// A profile edited by hand goes to the model as the base, so a rebuild updates it without losing what the user wrote.
const EDITED_NOTE = 'The current profile below was edited by hand. Keep its wording, facts and any sections the user added; '
  + 'change only what the sources show is out of date or missing, and keep the six headings.';

// Reads the sources, asks the model once, and saves the profile on the project. Returns the saved profile.
// onStep(text) tells the caller what is being done, for a busy line. keepEdits: a profile edited by hand is updated
// from its own text instead of replaced, and stays marked as edited.
/** @param {DataStore} store @param {Project} project @param {{ onStep?: (text: string) => void, keepEdits?: boolean }} [options] */
export async function buildProfile(store, project, { onStep = () => {}, keepEdits = false } = {}) {
  if (!hasProfileSources(project)) throw new Error('Add a local folder, a repository or a website to the project first.');
  onStep('Reading README, commits and website…');
  const sources = await readProfileSources(store, project);
  if (!sources.read.length) throw new Error(`None of the sources could be read: ${sources.gaps.join('; ')}.`);
  onStep('Writing the profile…');
  const usageId = uid();
  const current = profileOf(project);
  const merge = keepEdits && current.edited && current.text.trim();
  const input = profileInput(project, sources);
  const reply = await ask(store, 'task-summary', [
    { role: 'system', content: systemPrompt(store, 'project-profile') },
    { role: 'user', content: merge ? `${input}\n\n${EDITED_NOTE}\n\n<current-profile>\n${current.text}\n</current-profile>` : input },
  ], { usageId, projectId: project.id });
  const edited = Boolean(merge);
  const profile = { ...current, text: unfence(reply), updated: now(), edited, usageId };
  store.update('projects', (d) => {
    const p = d.projects.find((x) => x.id === project.id);
    if (p) p.profile = { ...profileOf(p), text: profile.text, updated: profile.updated, edited, usageId };
  });
  return profile;
}
