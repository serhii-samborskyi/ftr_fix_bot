const state = {
  range: 'today',
  jobs: [],
  selectedJob: null,
  settings: null,
  worker: null
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      ...(options.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
      ...(options.headers || {})
    }
  });
  if (response.status === 401) window.location.href = '/login';
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || response.statusText);
  return payload;
}

function showView(viewId, title) {
  $$('.view').forEach((view) => view.classList.toggle('active', view.id === viewId));
  $$('.nav-button').forEach((button) => button.classList.toggle('active', button.dataset.view === viewId));
  $('#viewTitle').textContent = title;
}

function statusClass(job) {
  if (job.status === 'concern' || job.followupStatus === 'failed' || job.followupStatus === 'delivery_failed') return 'danger';
  if (job.status === 'satisfied') return 'success';
  if (
    job.status === 'needs_review' ||
    job.status === 'ocr_failed' ||
    job.followupStatus === 'delivery_pending' ||
    job.followupStatus === 'limit_reached'
  ) {
    return 'warn';
  }
  return '';
}

function renderJobs() {
  const list = $('#jobList');
  if (!state.jobs.length) {
    list.innerHTML = '<div class="empty">No jobs in this range.</div>';
    return;
  }

  list.innerHTML = state.jobs
    .map(
      (job) => `
        <article class="job-card" data-job-id="${job.id}">
          <button class="job-card-main" data-open-job-id="${job.id}">
            <span class="badge ${statusClass(job)}">${escapeHtml(job.status)}</span>
            <strong>${escapeHtml(job.customerName || 'Unknown customer')}</strong>
            <span>${escapeHtml(job.phone || 'No phone')} - ${escapeHtml(job.accountNumber || 'No account')}</span>
            <span>${escapeHtml(job.address || 'No address')}</span>
            <small>${new Date(job.createdAt).toLocaleString()} - follow-up: ${escapeHtml(job.followupStatus)}</small>
            ${job.sourceSenderName || job.sourceSenderUsername || job.sourceSenderId ? `<small>Posted by ${escapeHtml(telegramPosterLabel(job))}</small>` : ''}
            ${job.followupLastError ? `<small class="job-error">Error: ${escapeHtml(job.followupLastError)}</small>` : ''}
          </button>
          <button class="remove-job-button" data-remove-job-id="${job.id}" aria-label="Remove ${escapeHtml(job.customerName || 'job')}">Remove</button>
        </article>
      `
    )
    .join('');

  $$('[data-open-job-id]').forEach((button) => {
    button.addEventListener('click', () => loadJob(button.dataset.openJobId, 'reviewView'));
  });

  $$('[data-remove-job-id]').forEach((button) => {
    button.addEventListener('click', () => deleteJob(button.dataset.removeJobId));
  });
}

async function loadJobs() {
  const params = new URLSearchParams({ range: state.range });
  if (state.range === 'custom') {
    if ($('#fromDate').value) params.set('from', $('#fromDate').value);
    if ($('#toDate').value) params.set('to', $('#toDate').value);
  }
  const payload = await api(`/api/jobs?${params}`);
  state.jobs = payload.jobs;
  renderJobs();
}

function telegramPosterLabel(job) {
  if (job.sourceSenderName && job.sourceSenderUsername) return `${job.sourceSenderName} (@${job.sourceSenderUsername})`;
  if (job.sourceSenderName) return job.sourceSenderName;
  if (job.sourceSenderUsername) return `@${job.sourceSenderUsername}`;
  if (job.sourceSenderId) return `Telegram ID ${job.sourceSenderId}`;
  return '';
}

function telegramPosterHref(job) {
  const username = String(job.sourceSenderUsername || '').replace(/^@+/, '').trim();
  if (username) return `https://t.me/${encodeURIComponent(username)}`;

  const senderId = String(job.sourceSenderId || '').trim();
  if (/^\d+$/.test(senderId)) return `tg://user?id=${encodeURIComponent(senderId)}`;
  return '';
}

function renderTelegramPosterMeta(job) {
  const label = telegramPosterLabel(job);
  const href = telegramPosterHref(job);
  if (!label) return '';
  const idText = job.sourceSenderId ? ` - ID ${escapeHtml(job.sourceSenderId)}` : '';
  const link = href ? ` - <a href="${escapeHtml(href)}" target="_blank" rel="noreferrer">Message on Telegram</a>` : '';
  return `Posted by ${escapeHtml(label)}${idText}${link}`;
}

function fillJobForm(job) {
  state.selectedJob = job;
  $('#jobId').value = job.id;
  $('#customerName').value = job.customerName || '';
  $('#phone').value = job.phone || '';
  $('#accountNumber').value = job.accountNumber || '';
  $('#address').value = job.address || '';
  $('#jobImage').src = `/api/jobs/${job.id}/image`;
  $('#jobMeta').textContent = `${job.status} - OCR ${job.ocrConfidence ? Math.round(job.ocrConfidence) : 'n/a'} - follow-up ${job.followupStatus}`;
  $('#jobError').textContent = job.followupLastError ? `Follow-up error: ${job.followupLastError}` : '';
  $('#jobError').classList.toggle('hidden', !job.followupLastError);
  $('#conversationHeader').textContent = `${job.customerName || 'Unknown customer'} - ${job.phone || 'No phone'}`;
  const posterMeta = renderTelegramPosterMeta(job);
  $('#sourcePosterMeta').innerHTML = posterMeta;
  $('#sourcePosterMeta').classList.toggle('hidden', !posterMeta);
}

function clearSelectedJob() {
  state.selectedJob = null;
  $('#jobId').value = '';
  $('#customerName').value = '';
  $('#phone').value = '';
  $('#accountNumber').value = '';
  $('#address').value = '';
  $('#jobImage').removeAttribute('src');
  $('#jobMeta').textContent = 'No job selected.';
  $('#sourcePosterMeta').textContent = '';
  $('#sourcePosterMeta').classList.add('hidden');
  $('#jobError').textContent = '';
  $('#jobError').classList.add('hidden');
  $('#conversationHeader').textContent = '';
  $('#conversationList').innerHTML = '<div class="empty">Select a job first.</div>';
}

async function loadJob(id, view = 'reviewView') {
  const payload = await api(`/api/jobs/${id}`);
  fillJobForm(payload.job);
  if (view === 'conversationView') await loadConversation(id);
  showView(view, view === 'conversationView' ? 'Conversation' : 'Review');
}

async function loadConversation(id = state.selectedJob?.id) {
  if (!id) {
    $('#conversationList').innerHTML = '<div class="empty">Select a job first.</div>';
    return;
  }
  const payload = await api(`/api/jobs/${id}/conversation`);
  $('#conversationList').innerHTML =
    payload.messages
      .map(
        (message) => `
          <div class="bubble ${message.direction}">
            <p>${escapeHtml(message.body)}</p>
            <small>${new Date(message.createdAt).toLocaleString()}</small>
          </div>
        `
      )
      .join('') || '<div class="empty">No messages yet.</div>';
}

async function deleteJob(id = state.selectedJob?.id) {
  if (!id) return;
  const job = state.jobs.find((candidate) => candidate.id === id) || state.selectedJob;
  const label = job?.customerName || job?.phone || 'this job';
  if (!window.confirm(`Remove ${label}? This also removes its saved image and conversation history.`)) return;

  await api(`/api/jobs/${id}`, { method: 'DELETE' });
  if (state.selectedJob?.id === id) {
    clearSelectedJob();
    showView('jobsView', 'Jobs');
  }
  await loadJobs();
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

async function loadSettings() {
  const payload = await api('/api/settings');
  const settings = payload.settings;
  state.settings = settings;

  for (const key of [
    'appBaseUrl',
    'telegramJobChatTitle',
    'telegramJobChatId',
    'telegramManagerChatId',
    'telegramBotToken',
    'bluebubblesServerUrl',
    'bluebubblesSendMethod',
    'bluebubblesServiceOrder',
    'bluebubblesWebhookUrl',
    'llmProvider',
    'ollamaBaseUrl',
    'ollamaModel',
    'geminiModel',
    'followupMaxAgentMessages',
    'followupConversationWindowDays',
    'systemPrompt',
    'initialMessageTemplate'
  ]) {
    const input = $(`#${key}`);
    if (input) input.value = settings[key] || '';
  }
  $('#telegramAckEnabled').checked = Boolean(settings.telegramAckEnabled);
  $('#bluebubblesAddressFallback').checked = Boolean(settings.bluebubblesAddressFallback);
  $('#autoSendFollowup').checked = Boolean(settings.autoSendFollowup);
  $('#settingsStatus').textContent = `Telegram token: ${settings.telegramBotTokenConfigured ? 'configured' : 'missing'} - BlueBubbles password: ${settings.bluebubblesPasswordConfigured ? 'configured' : 'missing'} - Gemini key: ${settings.geminiApiKeyConfigured ? 'configured' : 'missing'}`;
  await loadSystemStatus();
  await loadWorkerStatus();
}

async function loadSystemStatus() {
  const payload = await api('/api/system/status');
  const database = payload.system?.database || {};
  const storage = payload.system?.storage || {};
  $('#databaseStatus').textContent = [
    `DB ${database.database_name || database.database || 'unknown'}@${database.host || 'unknown'}${database.port ? `:${database.port}` : ''}`,
    `jobs ${database.total_jobs ?? 0}`,
    `today ${database.today_jobs ?? 0}`,
    `images ${storage.imageCount ?? 0}`,
    `storage ${storage.dataDir || 'unknown'}`
  ].join(' - ');
}

async function copyText(value) {
  const text = String(value || '').trim();
  if (!text) throw new Error('Nothing to copy.');

  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Fall back to the selection-based copy path.
    }
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand('copy');
  textarea.remove();
}

function renderWorkerLogs(logs = []) {
  const list = $('#workerLogList');
  if (!logs.length) {
    list.innerHTML = '<div class="empty compact">No worker logs yet.</div>';
    return;
  }

  list.innerHTML = logs
    .map((entry) => {
      const meta = Object.entries(entry.meta || {})
        .filter(([, value]) => value !== undefined && value !== null && value !== '')
        .map(([key, value]) => `${key}: ${typeof value === 'object' ? JSON.stringify(value) : String(value)}`)
        .join(' | ');
      return `
        <div class="worker-log ${escapeHtml(entry.level)}">
          <div>
            <strong>${escapeHtml(entry.message)}</strong>
            <small>${new Date(entry.createdAt).toLocaleString()} - ${escapeHtml(entry.worker)} - ${escapeHtml(entry.level)}</small>
          </div>
          ${meta ? `<code>${escapeHtml(meta)}</code>` : ''}
        </div>
      `;
    })
    .join('');
}

function renderWorkerStatus(telegram, logs = telegram?.logs || []) {
  state.worker = telegram;
  const running = telegram?.running;
  const configured = telegram?.configured;
  const stateText = telegram?.state || 'unknown';
  const dot = $('#telegramWorkerDot');

  $('#telegramWorkerState').textContent = `${stateText}${running && telegram.botUsername ? ` as @${telegram.botUsername}` : ''}`;
  $('#telegramWorkerMeta').textContent = [
    `token ${configured ? 'configured' : 'missing'}`,
    `job group ${telegram?.jobChatId || telegram?.jobChatTitle || 'not set'}`,
    `manager ${telegram?.managerChatId || 'not set'}`,
    telegram?.lastError ? `last error: ${telegram.lastError}` : ''
  ]
    .filter(Boolean)
    .join(' - ');

  dot.classList.toggle('running', stateText === 'running');
  dot.classList.toggle('warn', stateText === 'starting' || stateText === 'stopping');
  dot.classList.toggle('error', stateText === 'error' || !configured);
  $('#startTelegramWorkerBtn').disabled = running || stateText === 'starting';
  $('#stopTelegramWorkerBtn').disabled = !running;
  renderWorkerLogs(logs);
}

async function loadWorkerStatus() {
  const payload = await api('/api/workers/status');
  renderWorkerStatus(payload.telegram, payload.logs || payload.telegram?.logs || []);
}

function collectSettings(formType) {
  const payload = {};
  const ids =
    formType === 'prompt'
      ? ['systemPrompt', 'initialMessageTemplate']
      : [
          'appBaseUrl',
          'telegramJobChatTitle',
          'telegramJobChatId',
          'telegramManagerChatId',
          'telegramBotToken',
          'bluebubblesServerUrl',
          'bluebubblesPassword',
          'bluebubblesWebhookSecret',
          'bluebubblesSendMethod',
          'bluebubblesServiceOrder',
          'llmProvider',
          'ollamaBaseUrl',
          'ollamaModel',
          'geminiModel',
          'geminiApiKey',
          'followupMaxAgentMessages',
          'followupConversationWindowDays'
        ];

  for (const id of ids) {
    const element = $(`#${id}`);
    if (!element) continue;
    if ((id.includes('Password') || id.includes('Secret') || id.includes('Token') || id === 'geminiApiKey') && !element.value) continue;
    payload[id] = element.value;
  }
  if (formType !== 'prompt') {
    payload.telegramAckEnabled = $('#telegramAckEnabled').checked;
    payload.bluebubblesAddressFallback = $('#bluebubblesAddressFallback').checked;
    payload.autoSendFollowup = $('#autoSendFollowup').checked;
  }
  return payload;
}

function wireEvents() {
  $$('.nav-button').forEach((button) => {
    button.addEventListener('click', async () => {
      if (button.dataset.view === 'conversationView') await loadConversation();
      if (button.dataset.view === 'settingsView') await loadWorkerStatus();
      showView(button.dataset.view, button.dataset.title);
    });
  });

  $$('.chip').forEach((chip) => {
    chip.addEventListener('click', async () => {
      state.range = chip.dataset.range;
      $$('.chip').forEach((item) => item.classList.toggle('active', item === chip));
      $('#customRange').classList.toggle('hidden', state.range !== 'custom');
      await loadJobs();
    });
  });

  $('#fromDate').addEventListener('change', loadJobs);
  $('#toDate').addEventListener('change', loadJobs);
  $('#refreshBtn').addEventListener('click', async () => {
    await loadJobs();
    if (state.selectedJob) await loadJob(state.selectedJob.id);
    if ($('#settingsView').classList.contains('active')) await loadSystemStatus();
    await loadWorkerStatus();
  });

  $('#uploadForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    await api('/api/jobs/upload', { method: 'POST', body: formData });
    event.currentTarget.reset();
    await loadJobs();
  });

  $('#jobForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const id = $('#jobId').value;
    const payload = {
      customerName: $('#customerName').value,
      phone: $('#phone').value,
      accountNumber: $('#accountNumber').value,
      address: $('#address').value
    };
    const response = await api(`/api/jobs/${id}`, { method: 'PATCH', body: JSON.stringify(payload) });
    fillJobForm(response.job);
    await loadJobs();
  });

  $('#reprocessBtn').addEventListener('click', async () => {
    const id = $('#jobId').value;
    if (!id) return;
    const response = await api(`/api/jobs/${id}/reprocess`, { method: 'POST', body: '{}' });
    fillJobForm(response.job);
    await loadJobs();
  });

  $('#sendFollowupBtn').addEventListener('click', async () => {
    const id = $('#jobId').value;
    if (!id) return;
    $('#jobMeta').textContent = 'Sending follow-up...';
    $('#jobError').classList.add('hidden');
    try {
      const response = await api(`/api/jobs/${id}/send-followup`, { method: 'POST', body: '{}' });
      fillJobForm(response.job);
      await loadConversation(id);
      await loadJobs();
    } catch (error) {
      $('#jobError').textContent = error.message;
      $('#jobError').classList.remove('hidden');
      await loadJob(id, 'reviewView').catch(() => undefined);
      await loadJobs();
    }
    await loadWorkerStatus();
  });

  $('#checkDeliveryBtn').addEventListener('click', async () => {
    const id = $('#jobId').value;
    if (!id) return;
    $('#jobMeta').textContent = 'Checking delivery...';
    try {
      const response = await api(`/api/jobs/${id}/check-delivery`, { method: 'POST', body: '{}' });
      fillJobForm(response.job);
      await loadConversation(id);
      await loadJobs();
    } catch (error) {
      $('#jobError').textContent = error.message;
      $('#jobError').classList.remove('hidden');
    }
    await loadWorkerStatus();
  });

  $('#deleteJobBtn').addEventListener('click', async () => {
    await deleteJob();
  });

  $('#settingsForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    await api('/api/settings', { method: 'PATCH', body: JSON.stringify(collectSettings('settings')) });
    await loadSettings();
  });

  $('#promptForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    await api('/api/settings', { method: 'PATCH', body: JSON.stringify(collectSettings('prompt')) });
    await loadSettings();
  });

  $('#testBlueBubblesBtn').addEventListener('click', async () => {
    $('#settingsStatus').textContent = 'Testing BlueBubbles...';
    try {
      const payload = await api('/api/settings/test-bluebubbles', { method: 'POST', body: '{}' });
      $('#settingsStatus').textContent = payload.result.message || 'BlueBubbles OK';
    } catch (error) {
      $('#settingsStatus').textContent = error.message;
    }
  });

  $('#useCurrentDomainBtn').addEventListener('click', () => {
    $('#appBaseUrl').value = window.location.origin;
    $('#settingsStatus').textContent = `App base URL set to ${window.location.origin}. Save settings to update webhook URL.`;
  });

  $('#copyWebhookUrlBtn').addEventListener('click', async () => {
    try {
      await copyText($('#bluebubblesWebhookUrl').value);
      $('#settingsStatus').textContent = 'BlueBubbles webhook URL copied.';
    } catch (error) {
      $('#settingsStatus').textContent = error.message;
    }
  });

  $('#startTelegramWorkerBtn').addEventListener('click', async () => {
    $('#telegramWorkerState').textContent = 'starting';
    if ($('#telegramBotToken').value) {
      await api('/api/settings', { method: 'PATCH', body: JSON.stringify(collectSettings('settings')) });
    }
    const payload = await api('/api/workers/telegram/start', { method: 'POST', body: '{}' });
    renderWorkerStatus(payload.telegram);
    await loadSettings();
  });

  $('#stopTelegramWorkerBtn').addEventListener('click', async () => {
    $('#telegramWorkerState').textContent = 'stopping';
    const payload = await api('/api/workers/telegram/stop', { method: 'POST', body: '{}' });
    renderWorkerStatus(payload.telegram);
  });

  $('#refreshWorkerLogsBtn').addEventListener('click', loadWorkerStatus);
}

wireEvents();
loadSettings().catch((error) => console.error(error));
loadJobs().catch((error) => console.error(error));
setInterval(() => {
  if ($('#settingsView').classList.contains('active')) loadWorkerStatus().catch((error) => console.error(error));
}, 10000);
