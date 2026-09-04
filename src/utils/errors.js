const secretKeyPattern = /(password|token|secret|api[_-]?key|authorization|cookie)/i;

export function truncateText(value, max = 1200) {
  const text = String(value ?? '');
  if (text.length <= max) return text;
  return `${text.slice(0, max)}...`;
}

export function redactUrl(value) {
  const text = String(value || '');
  if (!text) return '';

  try {
    const url = new URL(text);
    for (const key of [...url.searchParams.keys()]) {
      if (secretKeyPattern.test(key)) url.searchParams.set(key, 'redacted');
    }
    return url.toString();
  } catch {
    return text
      .replace(/([?&](?:password|token|secret|api[_-]?key|key)=)[^&\s]+/gi, '$1redacted')
      .replace(/(authorization:\s*bearer\s+)[^\s]+/gi, '$1redacted');
  }
}

function redactValue(value, key = '', depth = 0) {
  if (secretKeyPattern.test(key)) return '<redacted>';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return truncateText(redactUrl(value), 2000);
  if (typeof value !== 'object') return value;
  if (depth >= 5) return '[truncated]';

  if (Array.isArray(value)) {
    return value.slice(0, 30).map((item) => redactValue(item, key, depth + 1));
  }

  return Object.fromEntries(
    Object.entries(value)
      .slice(0, 80)
      .map(([childKey, childValue]) => [childKey, redactValue(childValue, childKey, depth + 1)])
  );
}

export function sanitizeMeta(meta = {}) {
  return redactValue(meta);
}

export function serializeError(error) {
  if (!error || typeof error !== 'object') {
    return { name: 'Error', message: String(error || 'Unknown error') };
  }

  const details = {
    name: error.name || 'Error',
    message: error.message || String(error)
  };

  for (const field of [
    'code',
    'type',
    'status',
    'statusCode',
    'statusText',
    'upstreamStatus',
    'upstreamStatusText',
    'method',
    'path',
    'url',
    'responseMessage',
    'responseBody',
    'responseJson',
    'attemptErrors'
  ]) {
    if (error[field] !== undefined && error[field] !== null && error[field] !== '') {
      details[field] = error[field];
    }
  }

  if (error.cause) details.cause = serializeError(error.cause);
  return sanitizeMeta(details);
}

export function errorToLogMeta(error, extra = {}) {
  return sanitizeMeta({ ...extra, error: serializeError(error) });
}

export function errorToStoredMessage(error, max = 1000) {
  const details = serializeError(error);
  const request = [details.method, details.path].filter(Boolean).join(' ');
  const status = [
    details.upstreamStatus || details.status || details.statusCode,
    details.upstreamStatusText || details.statusText
  ]
    .filter(Boolean)
    .join(' ');
  const parts = [
    details.message,
    status ? `status=${status}` : '',
    request ? `request=${request}` : '',
    details.responseMessage ? `bluebubbles=${details.responseMessage}` : '',
    details.responseBody ? `body=${details.responseBody}` : ''
  ].filter(Boolean);

  return truncateText(parts.join(' | '), max);
}
