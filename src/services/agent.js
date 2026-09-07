import { getRuntimeSettings } from './settings.js';
import { addWorkerLog } from './workerLogs.js';
import { errorToLogMeta, truncateText } from '../utils/errors.js';

const concernKeywords = [
  'not fixed',
  'not working',
  "doesn't work",
  'does not work',
  'wont work',
  "won't work",
  'cant get',
  "can't get",
  'cannot get',
  'can you help',
  'could you help',
  'need help',
  'stopped working',
  'not done',
  'not complete',
  'not resolved',
  'bad',
  'terrible',
  'awful',
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
  'missed',
  'wire',
  'wires',
  'cable',
  'line',
  'loose',
  'hanging',
  'mess',
  'trash'
];

const satisfiedKeywords = [
  'good',
  'great',
  'fine',
  'satisfied',
  'happy',
  'thanks',
  'thank you',
  'all set',
  'works',
  'no problem',
  'no issue',
  'no issues',
  'nothing else'
];

const concernPatterns = [
  /\bnot\s+(fixed|working|done|complete|resolved|happy|satisfied)\b/,
  /\b(not|wasn'?t|isn'?t)\s+(good|ok|okay|fine|great)\b/,
  /\b(doesn'?t|does not|isn'?t|is not|won'?t|will not|cant|can't|cannot|can not)\s+(work|working|turn on|connect|respond|function)\b/,
  /\b(can|could)\s+you\s+(help|send|fix|check)\b/,
  /\b(stopped|quit)\s+working\b/,
  /\bstill\s+(not|broken|down|out|loose|hanging|bad|wrong|doesn'?t|isn'?t)\b/,
  /\b(left|leaving)\b.*\b(wire|wires|cable|line|trash|mess|equipment|box|yard|backyard)\b/,
  /\b(wire|wires|cable|line|equipment|box)\b.*\b(left|loose|hanging|outside|yard|backyard|damaged|broken)\b/,
  /\b(damage|damaged|broken|hole|mess|trash|unsafe|dangerous)\b/,
  /\b(refund|credit|bill|billing|charged|charge)\b/,
  /\b(manager|supervisor|complaint|complain)\b/,
  /\b(no show|missed|never came)\b/,
  /\b(bad|worse|terrible|awful|angry|upset|unhappy)\b/
];

const satisfiedPatterns = [
  /\b(no|not any)\s+(problem|problems|issue|issues|concern|concerns)\b/,
  /\bnothing\s+(else|more|wrong)\b/,
  /\ball\s+(good|set|fixed|working)\b/,
  /\beverything\s+(is\s+)?(good|fine|working|works)\b/,
  /\bworks?\s+(now|great|good|fine)\b/
];

function renderTemplate(template, job) {
  return String(template || '')
    .replaceAll('{{name}}', job.customer_name || job.customerName || 'there')
    .replaceAll('{{tech}}', job.techName || job.tech_name || 'technician')
    .replaceAll('{{address}}', job.address || 'your address')
    .replaceAll('{{primaryPhone}}', job.primaryPhone || job.primary_phone || '')
    .replaceAll('{{accountNumber}}', job.account_number || job.accountNumber || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function jobValue(job, camelKey, snakeKey = camelKey) {
  return job?.[camelKey] || job?.[snakeKey] || '';
}

function cleanInitialFollowup(content, fallback, { requiredText = '' } = {}) {
  const text = String(content || '').trim().replace(/^["']|["']$/g, '');
  const lower = text.toLowerCase();
  const required = String(requiredText || '').trim().toLowerCase();

  if (!text) return fallback;
  if (lower.includes('missing information')) return fallback;
  if (lower.includes('provide') && (lower.includes('customer') || lower.includes('name') || lower.includes('address'))) {
    return fallback;
  }
  if (required && String(fallback || '').toLowerCase().includes(required) && !lower.includes(required)) return fallback;

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

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[’‘`]/g, "'")
    .replace(/[^\p{L}\p{N}' ]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function lastOutboundMessage(conversation = []) {
  for (let index = conversation.length - 1; index >= 0; index -= 1) {
    if (conversation[index]?.direction === 'outbound') return conversation[index];
  }
  return null;
}

function asksSatisfactionQuestion(text) {
  const lower = normalizeText(text);
  return /\b(satisfied|happy)\b/.test(lower) || /\bhow\s+was\b/.test(lower);
}

function asksNeedsAttentionQuestion(text) {
  const lower = normalizeText(text);
  return (
    /\bneeds?\s+attention\b/.test(lower) ||
    /\bstill\s+needs?\b/.test(lower) ||
    /\banything\b.*\b(attention|wrong|problem|issue|concern)\b/.test(lower) ||
    /\bwhat\b.*\b(wrong|problem|issue|concern)\b/.test(lower)
  );
}

function isCourtesyOnly(text) {
  const lower = normalizeText(text);
  if (!lower) return false;
  return /^(thanks|thank you|thank u|thx|ty|youre welcome|you're welcome|you are welcome|welcome|you too|u too|you as well|same to you|same for you|likewise|have a good one|have a good day too|ok|okay|k|got it|sounds good|appreciate it|no problem|np)$/i.test(lower);
}

function isClosingAgentMessage(text) {
  const lower = normalizeText(text);
  if (!lower) return false;
  return (
    /\bglad\s+to\s+hear\b/.test(lower) ||
    /\bthank(s| you)\b.*\b(feedback|confirming)\b/.test(lower) ||
    /\bwe\s+appreciate\s+the\s+feedback\b/.test(lower) ||
    /\bhave\s+a\s+good\s+day\b/.test(lower)
  );
}

function hasClosingAgentMessage(conversation = []) {
  return conversation.some((message) => message.direction === 'outbound' && isClosingAgentMessage(message.body));
}

function jobIsSatisfied(job) {
  return job?.status === 'satisfied' || job?.followupStatus === 'satisfied' || job?.followup_status === 'satisfied';
}

function isLowInformationPostCloseReply(text) {
  const raw = String(text || '').trim();
  const lower = normalizeText(raw);
  if (!raw) return false;
  if (/[?]/.test(raw)) return false;
  if (!lower) return true;

  const words = lower.split(' ').filter(Boolean);
  if (isCourtesyOnly(lower)) return true;
  if (words.length > 5) return false;
  return /^(you too|u too|you as well|same to you|same for you|same here|likewise|thank you too|thanks you too|thanks too|you have a good|have a good|sounds good|ok thanks|okay thanks|all good thanks|no thanks|no thank you)$/.test(lower);
}

function isShortYes(text) {
  return /^(yes|yeah|yep|yup|correct|right|there is|there are|it does|they did)\b/.test(normalizeText(text));
}

function isShortNo(text) {
  return /^(no|nope|nah|not really|nothing|nothing else)\b/.test(normalizeText(text));
}

function hasConcernSignal(text) {
  const lower = normalizeText(text);
  if (!lower) return false;
  if (concernPatterns.some((pattern) => pattern.test(lower))) return true;
  if (satisfiedPatterns.some((pattern) => pattern.test(lower))) return false;
  return concernKeywords.some((word) => lower.includes(word));
}

function hasSatisfiedSignal(text) {
  const lower = normalizeText(text);
  if (!lower) return false;
  return satisfiedPatterns.some((pattern) => pattern.test(lower)) || satisfiedKeywords.some((word) => lower.includes(word));
}

function concernDecision(customerText) {
  return {
    status: 'concern',
    reply: 'Thanks for letting us know. I will pass this to a manager so they can follow up with you.',
    concernSummary: customerText
  };
}

function needsIssueDetailsDecision() {
  return {
    status: 'needs_followup',
    reply: "I'm sorry to hear that. What still needs attention from the visit?",
    concernSummary: ''
  };
}

function satisfiedDecision(reply = 'Thanks for confirming. Have a good day.') {
  return { status: 'satisfied', reply, concernSummary: '' };
}

export function deterministicDecision({ job = {}, conversation = [], customerText = '' } = {}) {
  const lastAgentText = lastOutboundMessage(conversation)?.body || '';
  const hasDetails = normalizeText(customerText).split(' ').length > 2;

  if (hasConcernSignal(customerText)) return concernDecision(customerText);

  if ((jobIsSatisfied(job) || hasClosingAgentMessage(conversation)) && isLowInformationPostCloseReply(customerText)) {
    return satisfiedDecision('');
  }

  if (jobIsSatisfied(job) && (isCourtesyOnly(customerText) || hasSatisfiedSignal(customerText))) {
    return satisfiedDecision('');
  }

  if (isCourtesyOnly(customerText) && isClosingAgentMessage(lastAgentText)) {
    return satisfiedDecision('');
  }

  if (asksNeedsAttentionQuestion(lastAgentText)) {
    if (isShortNo(customerText)) return satisfiedDecision();
    if (isShortYes(customerText) && !hasDetails) {
      return {
        status: 'needs_followup',
        reply: 'Could you briefly tell me what still needs attention?',
        concernSummary: ''
      };
    }
    if (isShortYes(customerText) && hasDetails) return concernDecision(customerText);
  }

  if (asksSatisfactionQuestion(lastAgentText)) {
    if (hasSatisfiedSignal(customerText)) {
      return satisfiedDecision(isCourtesyOnly(customerText) ? '' : 'Glad to hear it. Thank you for the feedback.');
    }
    if (isShortNo(customerText)) return needsIssueDetailsDecision();
    if (isCourtesyOnly(customerText)) return satisfiedDecision('');
    if (isShortYes(customerText)) {
      return satisfiedDecision('Glad to hear it. Thank you for the feedback.');
    }
  }

  if (hasSatisfiedSignal(customerText)) {
    return satisfiedDecision(isCourtesyOnly(customerText) ? '' : 'Thank you. We appreciate the feedback.');
  }

  return null;
}

function preventRepeatedFollowup(decision, conversation = [], customerText = '') {
  const normalized = normalizeDecision(decision);
  const lastAgentText = normalizeText(lastOutboundMessage(conversation)?.body || '');
  const replyText = normalizeText(normalized.reply);

  if (normalized.status !== 'concern' && hasClosingAgentMessage(conversation) && isLowInformationPostCloseReply(customerText)) {
    return satisfiedDecision('');
  }

  if (normalized.status === 'satisfied' && isCourtesyOnly(customerText) && isClosingAgentMessage(lastAgentText)) {
    normalized.reply = '';
  }

  if (normalized.status === 'concern' && !normalized.reply) {
    normalized.reply = 'Thanks for letting us know. I will pass this to a manager so they can follow up with you.';
  }
  if (normalized.status === 'concern' && !normalized.concernSummary) {
    normalized.concernSummary = customerText;
  }

  if (normalized.status === 'needs_followup' && replyText && replyText === lastAgentText) {
    normalized.reply = 'Could you briefly tell me what still needs attention?';
  }

  return normalized;
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
  if (hasConcernSignal(customerText)) return concernDecision(customerText);

  if (hasSatisfiedSignal(customerText)) {
    return satisfiedDecision(isCourtesyOnly(customerText) ? '' : 'Thank you. We appreciate the feedback.');
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
Primary phone: ${jobValue(job, 'primaryPhone', 'primary_phone')}
Account: ${jobValue(job, 'accountNumber', 'account_number')}
Address: ${jobValue(job, 'address') || 'the service address'}
Technician: ${jobValue(job, 'techName', 'tech_name') || 'technician'}

Do not ask the customer to provide their name, address, account number, or other internal job details.
If no technician name is available, refer to the technician as "technician".
Only ask whether they were satisfied with the service visit.`
      }
    ]);
    return cleanInitialFollowup(content, fallback, { requiredText: jobValue(job, 'techName', 'tech_name') });
  } catch (error) {
    addWorkerLog('agent', 'warn', 'Initial follow-up model failed; using template', errorToLogMeta(error, {
      provider: settings.llmProvider,
      model: settings.llmProvider === 'gemini' ? settings.geminiModel : settings.ollamaModel
    }));
    return fallback;
  }
}

export async function classifyCustomerReply({ job, conversation, customerText }) {
  const deterministic = deterministicDecision({ job, conversation, customerText });
  if (deterministic) return deterministic;

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
Primary phone: ${jobValue(job, 'primaryPhone', 'primary_phone') || ''}
Account: ${jobValue(job, 'accountNumber', 'account_number')}
Address: ${job.address || ''}

Conversation:
${transcript}

Latest customer reply:
${customerText}

Classification guardrails:
- Interpret "yes" and "no" based on the Agent's latest question.
- If Agent asked whether the customer was satisfied and Customer says "no", status is "needs_followup" and ask what still needs attention.
- If the latest reply contains both a positive answer and a problem, classify the problem. For example, "it was OK, but my remote does not work" is "concern".
- If Agent asked whether anything still needs attention and Customer says "no", status is "satisfied".
- If Agent asked whether anything still needs attention and Customer says "yes" plus any details, status is "concern".
- If the customer already confirmed satisfaction and then sends only courtesy like "thanks", "thank you", "you're welcome", "you are welcome", "you too", "same to you", "ok", or "no problem", status is "satisfied" and reply is "".
- Once the conversation has a satisfied closing acknowledgement, do not send another message unless the customer raises a new concern.
- Any unresolved work, device/equipment that does not work, request for help, damage, loose/hanging/left wires, equipment left behind, billing issue, missed appointment, or manager request is "concern".
- Never repeat the same Agent question already present in the conversation.

Classify the latest reply. Return strict JSON only.`
        }
      ],
      true
    );
    return preventRepeatedFollowup(extractJsonObject(content), conversation, customerText);
  } catch (error) {
    addWorkerLog('agent', 'warn', 'Classification model failed; using heuristic', errorToLogMeta(error, {
      provider: settings.llmProvider,
      model: settings.llmProvider === 'gemini' ? settings.geminiModel : settings.ollamaModel,
      jobId: job.id || ''
    }));
    return heuristicDecision(customerText);
  }
}
