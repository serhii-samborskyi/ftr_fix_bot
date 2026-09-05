import crypto from 'node:crypto';
import { getRuntimeSettings } from './settings.js';
import { normalizePhone, phoneToBlueBubblesChatGuid } from '../utils/phone.js';
import { redactUrl, sanitizeMeta, serializeError, truncateText } from '../utils/errors.js';

function baseUrl(url) {
  return String(url || '').replace(/\/+$/, '');
}

export class BlueBubblesRequestError extends Error {
  constructor({ message, method, path, status, statusText, url, responseMessage, responseBody, responseJson, cause }) {
    super(message, cause ? { cause } : undefined);
    this.name = 'BlueBubblesRequestError';
    this.method = method;
    this.path = path;
    this.status = 502;
    this.statusCode = 502;
    this.statusText = 'Bad Gateway';
    this.upstreamStatus = status;
    this.upstreamStatusText = statusText;
    this.url = url;
    this.responseMessage = responseMessage;
    this.responseBody = responseBody;
    this.responseJson = responseJson;
  }
}

function responseMessage(json, response) {
  const parts = [];
  if (json?.message) parts.push(String(json.message));
  if (json?.error?.message) parts.push(String(json.error.message));
  else if (typeof json?.error === 'string') parts.push(json.error);
  if (json?.error?.type) parts.push(`type=${json.error.type}`);
  return parts.filter(Boolean).join(' - ') || response.statusText || 'BlueBubbles request failed';
}

async function parseBlueBubblesResponse(response, request) {
  const text = await response.text();
  let json = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }

  const blueBubblesStatus = Number(json.status);
  const blueBubblesFailed = Number.isFinite(blueBubblesStatus) && blueBubblesStatus >= 400;

  if (!response.ok || blueBubblesFailed) {
    const statusLabel = !response.ok
      ? `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}`
      : `BlueBubbles status ${json.status}`;
    const message = responseMessage(json, response);
    throw new BlueBubblesRequestError({
      message: `BlueBubbles ${request.method} ${request.path} failed: ${statusLabel}; ${message}`,
      method: request.method,
      path: request.path,
      status: !response.ok ? response.status : blueBubblesStatus,
      statusText: response.statusText || '',
      url: request.url,
      responseMessage: message,
      responseBody: truncateText(text || JSON.stringify(json), 2000),
      responseJson: json
    });
  }

  return json;
}

export async function blueBubblesRequest(path, options = {}) {
  const settings = await getRuntimeSettings();
  if (!settings.bluebubblesServerUrl) throw new Error('BlueBubbles server URL is not configured.');
  if (!settings.bluebubblesPassword) throw new Error('BlueBubbles password is not configured.');

  const method = options.method || (options.body ? 'POST' : 'GET');
  const requestPath = `/api/v1${path}`;
  const url = new URL(`${baseUrl(settings.bluebubblesServerUrl)}${requestPath}`);
  url.searchParams.set('password', settings.bluebubblesPassword);

  let response;
  try {
    response = await fetch(url, {
      ...options,
      method,
      headers: {
        ...(options.body && !(options.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
        ...(options.headers || {})
      }
    });
  } catch (error) {
    throw new BlueBubblesRequestError({
      message: `BlueBubbles ${method} ${requestPath} network error: ${error.message}`,
      method,
      path: requestPath,
      url: redactUrl(url.toString()),
      cause: error
    });
  }

  return parseBlueBubblesResponse(response, {
    method,
    path: requestPath,
    url: redactUrl(url.toString())
  });
}

export async function pingBlueBubbles() {
  return blueBubblesRequest('/ping', { method: 'GET' });
}

export async function getBlueBubblesMessage(guid) {
  if (!guid) throw new Error('BlueBubbles message GUID is required.');

  const result = await blueBubblesRequest('/message/query', {
    method: 'POST',
    body: JSON.stringify({
      limit: 1,
      offset: 0,
      with: ['chat', 'handle'],
      where: [{ statement: 'message.guid = :guid', args: { guid } }],
      sort: 'DESC'
    })
  });
  const message = Array.isArray(result.data) ? result.data[0] : result.data;
  return { result, message: message || null };
}

function parseAddressFallback(value) {
  if (value === undefined || value === null || value === '') return true;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function parseBlueBubblesServiceOrder(value) {
  const valid = new Set(['iMessage', 'SMS']);
  const seen = new Set();
  const services = String(value || 'iMessage,SMS')
    .split(',')
    .map((item) => item.trim())
    .filter((service) => valid.has(service) && !seen.has(service) && seen.add(service));
  return services.length ? services : ['iMessage', 'SMS'];
}

function attemptForLog(attempt) {
  return {
    index: attempt.index,
    kind: attempt.kind,
    label: attempt.label,
    service: attempt.service || '',
    chatGuid: attempt.chatGuid || '',
    addresses: attempt.addresses || [],
    method: attempt.method || ''
  };
}

function isCreateChatAttempt(attempt) {
  return attempt.kind === 'createChat' || attempt.kind === 'addresses';
}

export function buildBlueBubblesTextAttempts({ phone, chatGuid }, settings = {}) {
  const method = String(settings.bluebubblesSendMethod || 'private-api').trim();

  if (chatGuid) {
    return [
      {
        index: 0,
        kind: 'chatGuid',
        label: `chatGuid:${chatGuid}`,
        chatGuid,
        method
      }
    ];
  }

  const normalized = normalizePhone(phone);
  if (!normalized) return [];

  const attempts = parseBlueBubblesServiceOrder(settings.bluebubblesServiceOrder).map((service, index) => ({
    index,
    kind: 'service',
    label: service,
    service,
    chatGuid: phoneToBlueBubblesChatGuid(normalized, service),
    method
  }));

  if (parseAddressFallback(settings.bluebubblesAddressFallback)) {
    for (const service of parseBlueBubblesServiceOrder(settings.bluebubblesServiceOrder)) {
      attempts.push({
        index: attempts.length,
        kind: 'createChat',
        label: `new ${service} chat`,
        service,
        addresses: [normalized],
        method
      });
    }
  }

  return attempts;
}

function blueBubblesTextPath(attempt) {
  return isCreateChatAttempt(attempt) ? '/chat/new' : '/message/text';
}

function blueBubblesTextPayload(attempt, message) {
  if (isCreateChatAttempt(attempt)) {
    return {
      addresses: attempt.addresses,
      message,
      tempGuid: `temp-${crypto.randomUUID()}`,
      ...(attempt.service ? { service: attempt.service } : {}),
      ...(attempt.method ? { method: attempt.method } : {})
    };
  }

  return {
    chatGuid: attempt.chatGuid,
    tempGuid: `temp-${crypto.randomUUID()}`,
    message,
    ...(attempt.method ? { method: attempt.method } : {})
  };
}

export function getBlueBubblesSentMessage(result) {
  const data = result?.data || result || {};
  if (Array.isArray(data?.messages) && data.messages[0]) return data.messages[0];
  if (data?.message && typeof data.message === 'object') return data.message;
  const messageFields = ['isSent', 'isFromMe', 'dateCreated', 'isDelivered', 'dateDelivered', 'error', 'handle'];
  if (data?.guid && messageFields.some((field) => Object.hasOwn(data, field))) {
    return data;
  }
  return null;
}

export function getBlueBubblesChatGuid(result, fallback = '') {
  const data = result?.data || result || {};
  const message = getBlueBubblesSentMessage(result);
  return (
    data?.chats?.[0]?.guid ||
    data?.chat?.guid ||
    data?.chatGuid ||
    message?.chats?.[0]?.guid ||
    message?.chat?.guid ||
    message?.chatGuid ||
    (Array.isArray(data?.messages) ? data?.guid : '') ||
    fallback ||
    ''
  );
}

export function getBlueBubblesExternalGuid(result, fallback = '') {
  return getBlueBubblesSentMessage(result)?.guid || result?.data?.messageGuid || fallback || '';
}

function immediateSendError(result) {
  const message = getBlueBubblesSentMessage(result);
  const errorText = String(message?.error ?? result?.data?.error ?? '').trim();
  return errorText && !['0', 'false', 'null'].includes(errorText.toLowerCase()) ? errorText : '';
}

export async function sendBlueBubblesTextAttempt({ attempt, message, allAttempts = [], previousErrors = [] }) {
  if (!message?.trim()) throw new Error('Message text is required.');
  const path = blueBubblesTextPath(attempt);
  const result = await blueBubblesRequest(path, {
    method: 'POST',
    body: JSON.stringify(blueBubblesTextPayload(attempt, message))
  });

  return {
    ...result,
    deliveryAttempt: attemptForLog(attempt),
    deliveryAttempts: (allAttempts.length ? allAttempts : [attempt]).map(attemptForLog),
    deliveryAttemptErrors: previousErrors.map((entry) => sanitizeMeta(entry))
  };
}

export async function sendBlueBubblesText({ phone, chatGuid, message }) {
  const settings = await getRuntimeSettings();
  const attempts = buildBlueBubblesTextAttempts({ phone, chatGuid }, settings);
  if (!attempts.length) throw new Error('A phone number or BlueBubbles chat GUID is required.');
  if (!message?.trim()) throw new Error('Message text is required.');

  const errors = [];
  for (const attempt of attempts) {
    try {
      const result = await sendBlueBubblesTextAttempt({
        attempt,
        message,
        allAttempts: attempts,
        previousErrors: errors
      });
      const errorCode = immediateSendError(result);
      if (!errorCode) return result;

      errors.push({
        attempt: attemptForLog(attempt),
        error: {
          name: 'BlueBubblesImmediateDeliveryError',
          message: `BlueBubbles returned message error ${errorCode} immediately.`,
          responseJson: sanitizeMeta({
            status: result.status,
            message: result.message,
            data: result.data,
            deliveryAttempt: result.deliveryAttempt
          })
        }
      });
    } catch (error) {
      errors.push({ attempt: attemptForLog(attempt), error: serializeError(error) });
    }
  }

  const error = new Error('All BlueBubbles send attempts failed.');
  error.name = 'BlueBubblesSendAttemptsError';
  error.status = 502;
  error.statusCode = 502;
  error.attemptErrors = errors;
  throw error;
}
