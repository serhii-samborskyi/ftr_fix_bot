import { parsePhoneNumberFromString } from 'libphonenumber-js';

export function normalizePhone(input, defaultCountry = 'US') {
  if (!input) return '';

  const raw = String(input).trim();
  const parsed = parsePhoneNumberFromString(raw, defaultCountry);
  if (parsed?.isValid()) return parsed.number;

  const digits = raw.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (raw.startsWith('+') && digits.length >= 8) return `+${digits}`;
  return raw;
}

export function phoneToBlueBubblesChatGuid(phone, service = 'iMessage') {
  const normalized = normalizePhone(phone);
  const resolvedService = String(service || 'iMessage').trim() || 'iMessage';
  return normalized ? `${resolvedService};-;${normalized}` : '';
}

export function formatPhoneForDisplay(phone) {
  const normalized = normalizePhone(phone);
  if (!normalized.startsWith('+1') || normalized.length !== 12) return normalized || phone || '';
  return `+1 (${normalized.slice(2, 5)}) ${normalized.slice(5, 8)}-${normalized.slice(8)}`;
}
