import { getRuntimeSettings } from './settings.js';
import { truncateText } from '../utils/errors.js';

const openAIBaseUrl = 'https://api.openai.com/v1';

const followupDecisionSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    status: {
      type: 'string',
      enum: ['satisfied', 'concern', 'needs_followup']
    },
    reply: {
      type: 'string'
    },
    concern_summary: {
      type: 'string'
    }
  },
  required: ['status', 'reply', 'concern_summary']
};

export class OpenAIRequestError extends Error {
  constructor({ message, method, path, status, statusText, responseBody, responseJson, cause }) {
    super(message, cause ? { cause } : undefined);
    this.name = 'OpenAIRequestError';
    this.method = method;
    this.path = path;
    this.status = status || 502;
    this.statusCode = status || 502;
    this.statusText = statusText || '';
    this.responseBody = responseBody || '';
    this.responseJson = responseJson || {};
  }
}

function openAIMessage(json, response) {
  return String(json?.error?.message || json?.message || response.statusText || 'OpenAI request failed');
}

async function parseOpenAIResponse(response, request) {
  const text = await response.text();
  let json = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }

  if (!response.ok) {
    const message = openAIMessage(json, response);
    throw new OpenAIRequestError({
      message: `OpenAI ${request.method} ${request.path} failed: HTTP ${response.status} ${response.statusText}; ${message}`,
      method: request.method,
      path: request.path,
      status: response.status,
      statusText: response.statusText,
      responseBody: truncateText(text || JSON.stringify(json), 2000),
      responseJson: json
    });
  }

  return json;
}

export async function openAIRequest(path, options = {}) {
  const { apiKey: providedApiKey, method: requestedMethod, headers = {}, ...fetchOptions } = options;
  const settings = providedApiKey ? {} : await getRuntimeSettings();
  const apiKey = String(providedApiKey || settings.openaiApiKey || '').trim();
  if (!apiKey) throw new Error('OpenAI API key is not configured.');

  const method = requestedMethod || (fetchOptions.body ? 'POST' : 'GET');
  const signal = fetchOptions.signal || AbortSignal.timeout(20000);
  let response;
  try {
    response = await fetch(`${openAIBaseUrl}${path}`, {
      ...fetchOptions,
      method,
      signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...(fetchOptions.body ? { 'Content-Type': 'application/json' } : {}),
        ...headers
      }
    });
  } catch (error) {
    throw new OpenAIRequestError({
      message: `OpenAI ${method} ${path} network error: ${error.message}`,
      method,
      path,
      cause: error
    });
  }

  return parseOpenAIResponse(response, { method, path });
}

export async function listOpenAIModels({ apiKey } = {}) {
  const result = await openAIRequest('/models', { method: 'GET', apiKey });
  return (Array.isArray(result.data) ? result.data : [])
    .map((model) => ({
      id: String(model.id || ''),
      ownedBy: String(model.owned_by || ''),
      created: model.created || null,
      shutdownDate: model.shutdown_date || null
    }))
    .filter((model) => model.id)
    .sort((a, b) => a.id.localeCompare(b.id));
}

function responseInput(messages = []) {
  return messages.map((message) => ({
    role: message.role === 'assistant' ? 'assistant' : message.role === 'system' ? 'system' : 'user',
    content: String(message.content || '')
  }));
}

function extractResponseText(result) {
  if (typeof result.output_text === 'string') return result.output_text;

  const parts = [];
  for (const item of Array.isArray(result.output) ? result.output : []) {
    if (typeof item.content === 'string') parts.push(item.content);
    for (const content of Array.isArray(item.content) ? item.content : []) {
      if (typeof content.text === 'string') parts.push(content.text);
    }
  }

  return parts.join('').trim();
}

export async function createOpenAIResponse(settings, messages, json = false) {
  if (!settings.openaiApiKey) throw new Error('OpenAI API key is not configured.');
  const model = String(settings.openaiModel || 'gpt-4.1-mini').trim() || 'gpt-4.1-mini';

  const result = await openAIRequest('/responses', {
    method: 'POST',
    apiKey: settings.openaiApiKey,
    body: JSON.stringify({
      model,
      input: responseInput(messages),
      ...(json
        ? {
            text: {
              format: {
                type: 'json_schema',
                name: 'followup_decision',
                strict: true,
                schema: followupDecisionSchema
              }
            }
          }
        : {})
    })
  });

  const text = extractResponseText(result);
  if (!text) throw new Error(`OpenAI response did not include text output: ${truncateText(JSON.stringify(result), 700)}`);
  return text;
}
