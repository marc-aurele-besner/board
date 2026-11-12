// @ts-check
// Images pasted or dropped on the board: on a task, or into a Dev terminal for claude to read.

// The kinds claude reads, and the runner saves.
export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

// The image files of a paste or a drop (a ClipboardEvent's clipboardData or a DragEvent's dataTransfer).
/** @param {{ files?: FileList | null } | null | undefined} data */
export function imageFiles(data) {
  return [...(data?.files ?? [])].filter((f) => IMAGE_TYPES.includes(f.type));
}

// Whether a drag carries files, so a drop target can accept it before the files can be read.
/** @param {DragEvent} e */
export const dragsFiles = (e) => [...(e.dataTransfer?.types ?? [])].includes('Files');

// The extension a saved image takes.
/** @param {string} type */
export const imageExt = (type) => (/** @type {Record<string, string>} */ ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }))[type] ?? 'png';
