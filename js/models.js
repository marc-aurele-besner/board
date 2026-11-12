// Which model an AI task uses: the one pinned to it in Settings → Models & tasks, else the default. No DOM, so the
// runners' Cron steps read it too.
export function modelForTask(store, taskId) {
  const models = store.get('settings').models;
  const task = models?.tasks?.find((t) => t.id === taskId);
  return task?.model || models?.default || '';
}
