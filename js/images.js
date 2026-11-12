// Images pasted or dropped on the board: on a task, or into a Dev terminal for claude to read.

// The kinds claude reads, and the runner saves.
export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

// The image files of a paste or a drop (a ClipboardEvent's clipboardData or a DragEvent's dataTransfer).
export function imageFiles(data) {
  return [...(data?.files ?? [])].filter((f) => IMAGE_TYPES.includes(f.type));
}

// Whether a drag carries files, so a drop target can accept it before the files can be read.
export const dragsFiles = (e) => [...(e.dataTransfer?.types ?? [])].includes('Files');

// The extension a saved image takes.
export const imageExt = (type) => ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' })[type] ?? 'png';
