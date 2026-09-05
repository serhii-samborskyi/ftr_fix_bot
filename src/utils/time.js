const fallbackTimeZone = 'America/Chicago';

export function normalizeTimeZone(value, fallback = fallbackTimeZone) {
  const timeZone = String(value || '').trim() || fallback;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date());
    return timeZone;
  } catch {
    return fallback;
  }
}

function datePartsInTimeZone(date, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: normalizeTimeZone(timeZone),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    hourCycle: 'h23'
  });

  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour === '24' ? '0' : parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second)
  };
}

function timeZoneOffsetMs(instant, timeZone) {
  const parts = datePartsInTimeZone(instant, timeZone);
  const localAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return localAsUtc - instant.getTime();
}

function zonedDateTimeToUtc({ year, month, day, hour = 0, minute = 0, second = 0 }, timeZone) {
  const localAsUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  let utcMs = localAsUtc;

  for (let index = 0; index < 3; index += 1) {
    utcMs = localAsUtc - timeZoneOffsetMs(new Date(utcMs), timeZone);
  }

  return new Date(utcMs);
}

export function localDateString(date = new Date(), timeZone = fallbackTimeZone) {
  const parts = datePartsInTimeZone(date, timeZone);
  return [
    String(parts.year).padStart(4, '0'),
    String(parts.month).padStart(2, '0'),
    String(parts.day).padStart(2, '0')
  ].join('-');
}

export function addDaysToLocalDate(ymd, days) {
  const [year, month, day] = String(ymd).split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days, 12, 0, 0));
  return [
    String(date.getUTCFullYear()).padStart(4, '0'),
    String(date.getUTCMonth() + 1).padStart(2, '0'),
    String(date.getUTCDate()).padStart(2, '0')
  ].join('-');
}

export function startOfLocalDayUtc(ymd, timeZone = fallbackTimeZone) {
  const [year, month, day] = String(ymd).split('-').map(Number);
  if (!year || !month || !day) return null;
  return zonedDateTimeToUtc({ year, month, day }, normalizeTimeZone(timeZone));
}

export function dateRangeForFilter({ range = 'today', from = '', to = '', timeZone = fallbackTimeZone } = {}) {
  const appTimeZone = normalizeTimeZone(timeZone);
  const today = localDateString(new Date(), appTimeZone);
  let startDate = '';
  let endDate = '';

  if (range === 'today') {
    startDate = today;
    endDate = addDaysToLocalDate(today, 1);
  } else if (range === 'yesterday') {
    startDate = addDaysToLocalDate(today, -1);
    endDate = today;
  } else if (range === 'lastweek') {
    startDate = addDaysToLocalDate(today, -6);
    endDate = addDaysToLocalDate(today, 1);
  } else if (range === 'custom') {
    startDate = from || '';
    endDate = to ? addDaysToLocalDate(to, 1) : '';
  }

  return {
    timeZone: appTimeZone,
    start: startDate ? startOfLocalDayUtc(startDate, appTimeZone) : null,
    end: endDate ? startOfLocalDayUtc(endDate, appTimeZone) : null,
    startDate,
    endDate
  };
}
