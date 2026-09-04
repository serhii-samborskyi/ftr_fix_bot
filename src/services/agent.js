import { getRuntimeSettings } from './settings.js';
import { addWorkerLog } from './workerLogs.js';
import { errorToLogMeta, truncateText } from '../utils/errors.js';

const concernKeywords = [
  'not fixed',
  'still',
  'again',
  'bad',
  'worse',
  'angry',
  'upset',
  'unhappy',
  'problem',
  'issue',
  'concern',
  'damage',
  'broken',
  'complaint',
  'supervisor',
  'manager',
  'refund',
  'credit',
  'bill',
  'billing',
  'no show',
  'missed'
];

const satisfiedKeywords = ['good', 'great', 'fine', 'satisfied', 'happy', 'thanks', 'thank you', 'all set', 'works'];

function renderTemplate(template, job) {
  return String(template || '')
    .replaceAll('{{name}}', job.customer_name || job.customerName || 'there')
    .replaceAll('{{address}}', job.address || 'your address')
    .replaceAll('{{accountNumber}}', job.account_number || job.accountNumber || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function jobValue(job, camelKey, snakeKey = camelKey) {
  return job?.[camelKey] || job?.[snakeKey] || '';
}

function cleanInitialFollowup(content, fallback) {
  const text = String(content || '').trim().replace(/^["']|["']$/g, '');
  const lower = text.toLowerCase();

  if (!text) return fallback;
  if (lower.includes('missing information')) return fallback;
  if (lower.includes('provide') && (lower.includes('customer') || lower.includes('name') || lower.includes('address'))) {
    return fallback;
  }

  return text;
}

function extractJsonObject(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

function normalizeDecision(value) {
  const status = ['satisfied', 'concern', 'needs_followup'].includes(value?.status)
    ? value.status
    : 'needs_followup';
  return {
    status,
    reply: String(value?.reply || '').trim(),
    concernSummary: String(value?.concern_summary || value?.concernSummary || '').trim()
  };
}

async function callOllama(settings, messages, json = false) {
  const response = await fetch(`${settings.ollamaBaseUrl.replace(/\/+$/, '')}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: settings.ollamaModel,
      messages,
      stream: false,
      ...(json ? { format: 'json' } : {})
    })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Ollama request failed: ${response.status} ${response.statusText} ${truncateText(body, 700)}`);
  }
  const data = await response.json();
  return data.message?.content || data.response || '';
}

async function callGemini(settings, messages, json = false) {
  if (!settings.geminiApiKey) throw new Error('Gemini API key is not configured.');

  const system = messages.find((message) => message.role === 'system')?.content || '';
  const contents = messages
    .filter((message) => message.role !== 'system')
    .map((message) => ({
      role: message.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: message.content }]
    }));

  const url = new URL(
    `https://generativelanguage.googleapis.com/v1beta/models/${settings.geminiModel}:generateContent`
  );
  url.searchParams.set('key', settings.geminiApiKey);

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: system ? { parts: [{ text: system }] } : undefined,
      contents,
      generationConfig: json ? { responseMimeType: 'application/json' } : undefined
    })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Gemini request failed: ${response.status} ${body}`);
  }

  const data = await response.json();
  return data.candidates?.[0]?.content?.parts?.map((part) => part.text || '').join('') || '';
}

async function callModel(settings, messages, json = false) {
  if (settings.llmProvider === 'gemini') return callGemini(settings, messages, json);
  return callOllama(settings, messages, json);
}

function heuristicDecision(customerText) {
  const lower = String(customerText || '').toLowerCase();
  if (concernKeywords.some((word) => lower.includes(word))) {
    return {
      status: 'concern',
      reply: 'Thanks for letting us know. I will pass this to a manager so they can follow up with you.',
      concernSummary: customerText
    };
  }

  if (satisfiedKeywords.some((word) => lower.includes(word))) {
    return { status: 'satisfied', reply: 'Thank you. We appreciate the feedback.', concernSummary: '' };
  }

  return {
    status: 'needs_followup',
    reply: 'Thanks for the update. Is there anything about the visit that still needs attention?',
    concernSummary: ''
  };
}

export async function buildInitialFollowup(job) {
  const settings = await getRuntimeSettings();
  const fallback = renderTemplate(settings.initialMessageTemplate, job);

  if (!settings.llmProvider || settings.llmProvider === 'disabled') return fallback;

  try {
    const content = await callModel(settings, [
      { role: 'system', content: settings.systemPrompt },
      {
        role: 'user',
        content: `Write one short initial SMS follow-up for this customer. No JSON.
Customer name: ${jobValue(job, 'customerName', 'customer_name') || 'there'}
Phone: ${jobValue(job, 'phone')}
Account: ${jobValue(job, 'accountNumber', 'account_number')}
Address: ${jobValue(job, 'address') || 'the service address'}

Do not ask the customer to provide their name, address, account number, or other internal job details.
Only ask whether they were satisfied with the service visit.`
      }
    ]);
    return cleanInitialFollowup(content, fallback);
  } catch (error) {
    addWorkerLog('agent', 'warn', 'Initial follow-up model failed; using template', errorToLogMeta(error, {
      provider: settings.llmProvider,
      model: settings.llmProvider === 'gemini' ? settings.geminiModel : settings.ollamaModel
    }));
    return fallback;
  }
}

export async function classifyCustomerReply({ job, conversation, customerText }) {
  const settings = await getRuntimeSettings();

  if (!settings.llmProvider || settings.llmProvider === 'disabled') return heuristicDecision(customerText);

  const transcript = conversation
    .map((message) => `${message.direction === 'outbound' ? 'Agent' : 'Customer'}: ${message.body}`)
    .join('\n');

  try {
    const content = await callModel(
      settings,
      [
        { role: 'system', content: settings.systemPrompt },
        {
          role: 'user',
          content: `Customer/job context:
Name: ${jobValue(job, 'customerName', 'customer_name')}
Phone: ${job.phone || ''}
Account: ${jobValue(job, 'accountNumber', 'account_number')}
Address: ${job.address || ''}

Conversation:
${transcript}

Latest customer reply:
${customerText}

Classify the latest reply. Return strict JSON only.`
        }
      ],
      true
    );
    return normalizeDecision(extractJsonObject(content));
  } catch (error) {
    addWorkerLog('agent', 'warn', 'Classification model failed; using heuristic', errorToLogMeta(error, {
      provider: settings.llmProvider,
      model: settings.llmProvider === 'gemini' ? settings.geminiModel : settings.ollamaModel,
      jobId: job.id || ''
    }));
    return heuristicDecision(customerText);
  }
}
