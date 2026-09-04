const maxLogEntries = 250;
const entries = [];

export function addWorkerLog(worker, level, message, meta = {}) {
  const entry = {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    createdAt: new Date().toISOString(),
    worker,
    level,
    message,
    meta
  };

  entries.unshift(entry);
  if (entries.length > maxLogEntries) entries.length = maxLogEntries;

  const prefix = `[${worker}]`;
  if (level === 'error') console.error(prefix, message, meta);
  else if (level === 'warn') console.warn(prefix, message, meta);
  else console.log(prefix, message, meta);

  return entry;
}

export function getWorkerLogs({ worker = '', limit = 100 } = {}) {
  const filtered = worker ? entries.filter((entry) => entry.worker === worker) : entries;
  return filtered.slice(0, Math.max(1, Math.min(Number(limit) || 100, maxLogEntries)));
}
