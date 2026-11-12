// @ts-check
// A task's images: pasted, dropped or picked, kept in the data folder (tasks/<task id>-<id>.<ext>) and listed on the
// task as images: [{ path, name, type }]. A Dev session on the task hands them to claude as files it can read.
/** @import { Store, Task, TaskImage } from '../types/data' */
import { h, icon, uid } from './ui.js';
import { toast } from './toast.js';
import { openDialog } from './modal.js';
import { saveImage } from './terminal.js';
import { IMAGE_TYPES, imageFiles, dragsFiles, imageExt } from './images.js';

const COLLECTION = 'todos';

/** @param {Task} item @returns {TaskImage[]} */
export const imagesOf = (item) => item.images ?? [];

// Object URLs by path, so a re-render shows a thumbnail at once instead of reading the file again.
/** @type {Map<string, Promise<string>>} */
const urls = new Map();
/** @param {Store} store @param {string} path */
function urlOf(store, path) {
  if (!urls.has(path)) urls.set(path, store.files.read(path).then((file) => URL.createObjectURL(file)));
  return /** @type {Promise<string>} */ (urls.get(path));
}

/** @param {Store} store @param {string} id @param {File[]} files */
export async function addImages(store, id, files) {
  /** @type {TaskImage[]} */
  const images = [];
  for (const file of files) {
    const path = `tasks/${id}-${uid()}.${imageExt(file.type)}`;
    try {
      await store.files.write(path, file);
      images.push({ path, name: file.name || 'Pasted image', type: file.type });
    } catch (err) {
      toast(`Could not save the image: ${/** @type {Error} */ (err).message}`);
    }
  }
  if (!images.length) return null;
  store.update(COLLECTION, (d) => {
    const item = d.items.find((i) => i.id === id);
    if (item) item.images = [...imagesOf(item), ...images];
  });
  toast(images.length === 1 ? 'Image added to the task' : `${images.length} images added to the task`);
  return store.get(COLLECTION).items.find((i) => i.id === id) ?? null;
}

// The page waits to rebuild while a field has focus (the description being edited), so the strip is redrawn in place.
/** @param {Store} store @param {string} id @param {File[]} files @param {HTMLElement} el */
async function addAndShow(store, id, files, el) {
  const item = await addImages(store, id, files);
  const strip = item && el?.querySelector('.task-images');
  if (strip) strip.replaceWith(imageStrip(store, item));
}

/** @param {Store} store @param {string} id @param {string} path */
async function removeImage(store, id, path) {
  store.update(COLLECTION, (d) => {
    const item = d.items.find((i) => i.id === id);
    if (item) item.images = imagesOf(item).filter((img) => img.path !== path);
  });
  urls.get(path)?.then((url) => URL.revokeObjectURL(url)).catch(() => {});
  urls.delete(path);
  await store.files.remove(path).catch(() => {});
}

// Paste and drop handlers for an element that takes images for the task. Text pastes pass through to the field.
/** @param {Store} store @param {Task} item */
export function imageDrop(store, item) {
  return {
    /** @param {ClipboardEvent & { currentTarget: HTMLElement }} e */
    onpaste: (e) => {
      const files = imageFiles(e.clipboardData);
      if (!files.length) return;
      e.preventDefault();
      addAndShow(store, item.id, files, e.currentTarget);
    },
    /** @param {DragEvent & { currentTarget: HTMLElement }} e */
    ondragover: (e) => {
      if (!dragsFiles(e)) return;
      e.preventDefault();
      e.currentTarget.classList.add('image-drop');
    },
    /** @param {DragEvent & { currentTarget: HTMLElement }} e */
    ondragleave: (e) => !e.currentTarget.contains(/** @type {Node | null} */ (e.relatedTarget)) && e.currentTarget.classList.remove('image-drop'),
    /** @param {DragEvent & { currentTarget: HTMLElement }} e */
    ondrop: (e) => {
      if (!dragsFiles(e)) return;
      e.preventDefault();
      e.stopPropagation();
      e.currentTarget.classList.remove('image-drop');
      const files = imageFiles(e.dataTransfer);
      if (files.length) addAndShow(store, item.id, files, e.currentTarget);
      else toast('Only PNG, JPEG, GIF and WebP images can be added');
    },
  };
}

/** @param {Store} store @param {TaskImage} img */
function showImage(store, img) {
  const body = h('div', { class: 'stack' });
  openDialog({ title: img.name, wide: true, body });
  urlOf(store, img.path).then(
    (src) => body.append(h('img', { class: 'bill-img', src, alt: img.name })),
    () => body.append(h('p', { class: 'muted' }, 'This image is no longer in the data folder.')),
  );
}

/** @param {Store} store @param {Task} item @param {TaskImage} img */
function thumb(store, item, img) {
  const pic = h('img', { alt: img.name });
  urlOf(store, img.path).then((src) => (pic.src = src), () => pic.replaceWith(h('span', { class: 'muted small' }, 'Missing')));
  return h('div', { class: 'task-image' },
    h('button', { type: 'button', class: 'task-image-open', title: img.name, 'aria-label': `Open ${img.name}`, onclick: () => showImage(store, img) }, pic),
    h('button', {
      type: 'button',
      class: 'icon-btn task-image-remove',
      title: 'Remove the image',
      'aria-label': `Remove ${img.name}`,
      onclick: () => removeImage(store, item.id, img.path),
    }, icon('x')));
}

// The task's images, and a button to add more; pasting or dropping works on the whole details panel.
/** @param {Store} store @param {Task} item */
export function imageStrip(store, item) {
  const input = h('input', {
    type: 'file',
    accept: IMAGE_TYPES.join(','),
    multiple: true,
    hidden: true,
    onchange: (/** @type {Event & { target: HTMLInputElement }} */ e) => addImages(store, item.id, imageFiles(e.target)),
  });
  return h('div', { class: 'task-images' },
    imagesOf(item).map((img) => thumb(store, item, img)),
    h('button', {
      type: 'button',
      class: 'btn-small task-image-add',
      title: 'Add images; you can also paste or drop them here',
      onclick: () => input.click(),
    }, icon('image'), imagesOf(item).length ? 'Add' : 'Add image (or paste, drop)'),
    input);
}

// Saves the tasks' images on this machine through the runner, so claude can read them: Map of task id → paths.
/** @param {Store} store @param {string} base @param {Task[]} items */
export async function imagePathsFor(store, base, items) {
  /** @type {Map<string, string[]>} */
  const out = new Map();
  for (const item of items) {
    /** @type {string[]} */
    const paths = [];
    for (const img of imagesOf(item)) {
      const file = await store.files.read(img.path).catch(() => null);
      if (!file) continue;
      const blob = file.type ? file : new Blob([file], { type: img.type });
      paths.push((await saveImage(base, blob)).path);
    }
    if (paths.length) out.set(item.id, paths);
  }
  return out;
}
