const state = {
  range: 'today',
  techFilter: 'all',
  jobs: [],
  technicians: [],
  selectedJob: null,
  settings: null,
  worker: null,
  busyCount: 0
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

function setGlobalBusy(active) {
  state.busyCount = Math.max(0, state.busyCount + (active ? 1 : -1));
  $('#globalBusy')?.classList.toggle('hidden', state.busyCount === 0);
}

function showGlobalStatus(message, level = 'info') {
  const target = $('#globalStatus');
  if (!target) return;
  target.textContent = String(message || '').trim();
  target.classList.toggle('error', level === 'error');
  target.classList.toggle('hidden', !target.textContent);
  window.clearTimeout(showGlobalStatus.timer);
  if (target.textContent) {
    showGlobalStatus.timer = window.setTimeout(() => target.classList.add('hidden'), 6000);
  }
}

async function api(path, options = {}) {
  setGlobalBusy(true);
  try {
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
  } finally {
    setGlobalBusy(false);
  }
}

async function withButtonLoading(target, label, callback) {
  const button = typeof target === 'string' ? $(target) : target;
  if (!button) return callback();

  const originalText = button.textContent;
  button.disabled = true;
  button.classList.add('is-loading');
  if (label) button.textContent = label;

  try {
    return await callback();
  } catch (error) {
    showGlobalStatus(error.message || 'Action failed.', 'error');
    throw error;
  } finally {
    button.disabled = false;
    button.classList.remove('is-loading');
    button.textContent = originalText;
  }
}

function showView(viewId, title) {
  $$('.view').forEach((view) => view.classList.toggle('active', view.id === viewId));
  $$('.nav-button').forEach((button) => button.classList.toggle('active', button.dataset.view === viewId));
  $('#viewTitle').textContent = title;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function formatDate(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';

  try {
    return date.toLocaleString([], {
      timeZone: state.settings?.appTimeZone || undefined,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    });
  } catch {
    return date.toLocaleString();
  }
}

function currentFilterParams() {
  const params = new URLSearchParams({ range: state.range });
  if (state.range === 'custom') {
    if ($('#fromDate')?.value) params.set('from', $('#fromDate').value);
    if ($('#toDate')?.value) params.set('to', $('#toDate').value);
  }
  if (state.techFilter && state.techFilter !== 'all') params.set('techId', state.techFilter);
  return params;
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

function techLabel(job) {
  if (job.techName) return `${job.techName}${job.techId ? ` (${job.techId})` : ''}`;
  return 'Unmatched';
}

function renderStats(stats) {
  const summary = stats?.summary || {};
  const cards = [
    ['jobs', 'Jobs'],
    ['followups', 'Follow-ups'],
    ['satisfactions', 'Satisfactions'],
    ['escalations', 'Escalations']
  ];

  $('#dashboardStats').innerHTML = cards
    .map(
      ([key, label]) => `
        <article class="stat-card">
          <span>${label}</span>
          <strong>${Number(summary[key] || 0)}</strong>
        </article>
      `
    )
    .join('');

  const byTech = stats?.byTech || [];
  $('#techStats').innerHTML = byTech.length
    ? byTech
        .map(
          (row) => `
            <article class="tech-stat-row">
              <div>
                <strong>${escapeHtml(row.techName || 'Unmatched')}</strong>
                <span>${escapeHtml(row.techId || row.techFilter || '')}</span>
              </div>
              <span>${Number(row.escalations || 0)} escalations / ${Number(row.jobs || 0)} jobs</span>
            </article>
          `
        )
        .join('')
    : '<div class="empty compact">No stats in this range.</div>';
}

async function loadDashboardStats() {
  const payload = await api(`/api/stats?${currentFilterParams()}`);
  renderStats(payload.stats);
}

function renderTechOptions() {
  const current = state.techFilter || 'all';
  const options = [
    ['all', 'All technicians'],
    ['unmatched', 'Unmatched'],
    ...state.technicians.map((tech) => [tech.id, `${tech.name}${tech.techId ? ` (${tech.techId})` : ''}`])
  ];

  const select = $('#techFilter');
  if (!select) return;
  select.innerHTML = options
    .map(([value, label]) => `<option value="${escapeHtml(value)}">${escapeHtml(label)}</option>`)
    .join('');
  select.value = options.some(([value]) => value === current) ? current : 'all';
  state.techFilter = select.value;
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
            <small class="tech-line">Tech: ${escapeHtml(techLabel(job))}${job.aiIgnore ? ' - AI ignored' : ''}</small>
            <small>${formatDate(job.createdAt)} - follow-up: ${escapeHtml(job.followupStatus)}</small>
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
    button.addEventListener('click', () => withButtonLoading(button, 'Removing', () => deleteJob(button.dataset.removeJobId)));
  });
}

async function loadJobs() {
  const payload = await api(`/api/jobs?${currentFilterParams()}`);
  state.jobs = payload.jobs;
  renderJobs();
}

async function refreshMainData() {
  await Promise.all([loadJobs(), loadDashboardStats()]);
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

function renderManualComposer() {
  const hasJob = Boolean(state.selectedJob);
  $('#manualMessage').disabled = !hasJob;
  $('#manualMessageForm button[type="submit"]').disabled = !hasJob;
  $('#conversationAiIgnore').disabled = !hasJob;
  $('#conversationAiIgnore').checked = Boolean(state.selectedJob?.aiIgnore);
}

function fillJobForm(job) {
  state.selectedJob = job;
  $('#jobId').value = job.id;
  $('#customerName').value = job.customerName || '';
  $('#phone').value = job.phone || '';
  $('#accountNumber').value = job.accountNumber || '';
  $('#address').value = job.address || '';
  $('#reviewAiIgnore').checked = Boolean(job.aiIgnore);
  $('#jobImage').src = `/api/jobs/${job.id}/image`;
  $('#jobMeta').textContent = `${job.status} - OCR ${job.ocrConfidence ? Math.round(job.ocrConfidence) : 'n/a'} - follow-up ${job.followupStatus}`;
  $('#jobTechMeta').textContent = `Technician: ${techLabel(job)}${job.techTelegramId ? ` - Telegram ${job.techTelegramId}` : ''}`;
  $('#jobError').textContent = job.followupLastError ? `Follow-up error: ${job.followupLastError}` : '';
  $('#jobError').classList.toggle('hidden', !job.followupLastError);
  $('#conversationHeader').textContent = `${job.customerName || 'Unknown customer'} - ${job.phone || 'No phone'} - ${techLabel(job)}`;
  const posterMeta = renderTelegramPosterMeta(job);
  $('#sourcePosterMeta').innerHTML = posterMeta;
  $('#sourcePosterMeta').classList.toggle('hidden', !posterMeta);
  renderManualComposer();
}

function clearSelectedJob() {
  state.selectedJob = null;
  $('#jobId').value = '';
  $('#customerName').value = '';
  $('#phone').value = '';
  $('#accountNumber').value = '';
  $('#address').value = '';
  $('#reviewAiIgnore').checked = false;
  $('#jobImage').removeAttribute('src');
  $('#jobMeta').textContent = 'No job selected.';
  $('#jobTechMeta').textContent = '';
  $('#sourcePosterMeta').textContent = '';
  $('#sourcePosterMeta').classList.add('hidden');
  $('#jobError').textContent = '';
  $('#jobError').classList.add('hidden');
  $('#conversationHeader').textContent = '';
  $('#conversationList').innerHTML = '<div class="empty">Select a conversation.</div>';
  renderManualComposer();
}

async function loadJob(id, view = 'reviewView') {
  const payload = await api(`/api/jobs/${id}`);
  fillJobForm(payload.job);
  if (view === 'conversationView') {
    await loadConversation(id);
    await loadRecentConversations();
  }
  showView(view, view === 'conversationView' ? 'Conversation' : 'Review');
}

function renderConversation(messages = []) {
  $('#conversationList').innerHTML =
    messages
      .map(
        (message) => `
          <div class="bubble ${message.direction}">
            <p>${escapeHtml(message.body)}</p>
            <small>${formatDate(message.createdAt)}</small>
          </div>
        `
      )
      .join('') || '<div class="empty">No messages yet.</div>';
}

async function loadConversation(id = state.selectedJob?.id) {
  if (!id) {
    $('#conversationList').innerHTML = '<div class="empty">Select a conversation.</div>';
    renderManualComposer();
    return;
  }
  const payload = await api(`/api/jobs/${id}/conversation`);
  renderConversation(payload.messages);
  renderManualComposer();
}

function renderRecentConversations(items = []) {
  const list = $('#recentChatList');
  if (!items.length) {
    list.innerHTML = '<div class="empty compact">No recent conversations in this range.</div>';
    return;
  }

  list.innerHTML = items
    .map(({ job, lastMessage }) => {
      const active = state.selectedJob?.id === job.id ? 'active' : '';
      return `
        <button class="recent-chat ${active}" data-chat-job-id="${job.id}">
          <strong>${escapeHtml(job.customerName || 'Unknown customer')} - ${escapeHtml(job.phone || 'No phone')}</strong>
          <span>${escapeHtml(lastMessage?.body || '')}</span>
          <small>${formatDate(lastMessage?.createdAt)} - ${escapeHtml(techLabel(job))}${job.aiIgnore ? ' - AI ignored' : ''}</small>
        </button>
      `;
    })
    .join('');

  $$('[data-chat-job-id]').forEach((button) => {
    button.addEventListener('click', () => loadJob(button.dataset.chatJobId, 'conversationView'));
  });
}

async function loadRecentConversations() {
  const payload = await api(`/api/conversations/recent?${currentFilterParams()}`);
  renderRecentConversations(payload.conversations || []);
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
  await refreshMainData();
  await loadRecentConversations();
}

async function updateSelectedAiIgnore(value) {
  const id = state.selectedJob?.id || $('#jobId')?.value;
  if (!id) return;

  const response = await api(`/api/jobs/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ aiIgnore: Boolean(value) })
  });
  fillJobForm(response.job);
  await refreshMainData();
  await loadRecentConversations();
}

function clearTechnicianForm() {
  $('#technicianId').value = '';
  $('#technicianName').value = '';
  $('#technicianTechId').value = '';
  $('#technicianTelegramId').value = '';
  $('#saveTechnicianBtn').textContent = 'Save tech';
}

function renderTechnicians() {
  renderTechOptions();
  const list = $('#technicianList');
  if (!state.technicians.length) {
    list.innerHTML = '<div class="empty compact">No technicians configured.</div>';
    return;
  }

  list.innerHTML = state.technicians
    .map(
      (tech) => `
        <article class="technician-row">
          <div>
            <strong>${escapeHtml(tech.name)}</strong>
            <span>${escapeHtml(tech.techId)} - Telegram ${escapeHtml(tech.telegramId)}</span>
          </div>
          <button type="button" class="secondary" data-edit-tech-id="${tech.id}">Edit</button>
          <button type="button" class="danger-button" data-delete-tech-id="${tech.id}">Remove</button>
        </article>
      `
    )
    .join('');

  $$('[data-edit-tech-id]').forEach((button) => {
    button.addEventListener('click', () => {
      const tech = state.technicians.find((candidate) => candidate.id === button.dataset.editTechId);
      if (!tech) return;
      $('#technicianId').value = tech.id;
      $('#technicianName').value = tech.name || '';
      $('#technicianTechId').value = tech.techId || '';
      $('#technicianTelegramId').value = tech.telegramId || '';
      $('#saveTechnicianBtn').textContent = 'Update tech';
    });
  });

  $$('[data-delete-tech-id]').forEach((button) => {
    button.addEventListener('click', () =>
      withButtonLoading(button, 'Removing', async () => {
        const tech = state.technicians.find((candidate) => candidate.id === button.dataset.deleteTechId);
        if (!window.confirm(`Remove ${tech?.name || 'this technician'}? Jobs will move to Unmatched.`)) return;
        await api(`/api/technicians/${button.dataset.deleteTechId}`, { method: 'DELETE' });
        clearTechnicianForm();
        await loadTechnicians();
        await refreshMainData();
        await loadRecentConversations();
      })
    );
  });
}

async function loadTechnicians() {
  const payload = await api('/api/technicians');
  state.technicians = payload.technicians || [];
  renderTechnicians();
}

async function loadSettings() {
  const payload = await api('/api/settings');
  const settings = payload.settings;
  state.settings = settings;

  for (const key of [
    'appBaseUrl',
    'appTimeZone',
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
  const system = payload.system || {};
  const database = system.database || {};
  const storage = system.storage || {};
  $('#databaseStatus').textContent = [
    `app timezone ${system.appTimeZone || state.settings?.appTimeZone || 'unknown'}`,
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
            <small>${formatDate(entry.createdAt)} - ${escapeHtml(entry.worker)} - ${escapeHtml(entry.level)}</small>
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
          'appTimeZone',
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
    button.addEventListener('click', () =>
      withButtonLoading(button, '', async () => {
        if (button.dataset.view === 'conversationView') {
          await loadRecentConversations();
          await loadConversation();
        }
        if (button.dataset.view === 'settingsView') {
          await loadTechnicians();
          await loadWorkerStatus();
        }
        showView(button.dataset.view, button.dataset.title);
      })
    );
  });

  $$('.chip').forEach((chip) => {
    chip.addEventListener('click', () =>
      withButtonLoading(chip, '', async () => {
        state.range = chip.dataset.range;
        $$('.chip').forEach((item) => item.classList.toggle('active', item === chip));
        $('#customRange').classList.toggle('hidden', state.range !== 'custom');
        await refreshMainData();
        if ($('#conversationView').classList.contains('active')) await loadRecentConversations();
      })
    );
  });

  $('#techFilter').addEventListener('change', async (event) => {
    state.techFilter = event.currentTarget.value;
    await refreshMainData();
    if ($('#conversationView').classList.contains('active')) await loadRecentConversations();
  });

  $('#fromDate').addEventListener('change', refreshMainData);
  $('#toDate').addEventListener('change', refreshMainData);
  $('#refreshBtn').addEventListener('click', (event) =>
    withButtonLoading(event.currentTarget, 'Refreshing', async () => {
      await loadSettings();
      await loadTechnicians();
      await refreshMainData();
      if (state.selectedJob) {
        await loadJob(state.selectedJob.id, $('#conversationView').classList.contains('active') ? 'conversationView' : 'reviewView');
      }
      if ($('#conversationView').classList.contains('active')) await loadRecentConversations();
    })
  );

  $('#uploadForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = event.submitter || $('#uploadForm button[type="submit"]');
    await withButtonLoading(button, 'Uploading', async () => {
      const formData = new FormData(event.currentTarget);
      await api('/api/jobs/upload', { method: 'POST', body: formData });
      event.currentTarget.reset();
      await refreshMainData();
    });
  });

  $('#jobForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const id = $('#jobId').value;
    if (!id) return;
    const button = event.submitter || $('#jobForm button[type="submit"]');
    await withButtonLoading(button, 'Saving', async () => {
      const payload = {
        customerName: $('#customerName').value,
        phone: $('#phone').value,
        accountNumber: $('#accountNumber').value,
        address: $('#address').value,
        aiIgnore: $('#reviewAiIgnore').checked
      };
      const response = await api(`/api/jobs/${id}`, { method: 'PATCH', body: JSON.stringify(payload) });
      fillJobForm(response.job);
      await refreshMainData();
      await loadRecentConversations();
    });
  });

  $('#reprocessBtn').addEventListener('click', (event) =>
    withButtonLoading(event.currentTarget, 'Processing', async () => {
      const id = $('#jobId').value;
      if (!id) return;
      const response = await api(`/api/jobs/${id}/reprocess`, { method: 'POST', body: '{}' });
      fillJobForm(response.job);
      await refreshMainData();
    })
  );

  $('#sendFollowupBtn').addEventListener('click', (event) =>
    withButtonLoading(event.currentTarget, 'Sending', async () => {
      const id = $('#jobId').value;
      if (!id) return;
      $('#jobMeta').textContent = 'Sending follow-up...';
      $('#jobError').classList.add('hidden');
      try {
        const response = await api(`/api/jobs/${id}/send-followup`, { method: 'POST', body: '{}' });
        fillJobForm(response.job);
        await loadConversation(id);
        await refreshMainData();
      } catch (error) {
        $('#jobError').textContent = error.message;
        $('#jobError').classList.remove('hidden');
        await loadJob(id, 'reviewView').catch(() => undefined);
        await refreshMainData();
      }
      await loadWorkerStatus();
    })
  );

  $('#checkDeliveryBtn').addEventListener('click', (event) =>
    withButtonLoading(event.currentTarget, 'Checking', async () => {
      const id = $('#jobId').value;
      if (!id) return;
      $('#jobMeta').textContent = 'Checking delivery...';
      try {
        const response = await api(`/api/jobs/${id}/check-delivery`, { method: 'POST', body: '{}' });
        fillJobForm(response.job);
        await loadConversation(id);
        await refreshMainData();
      } catch (error) {
        $('#jobError').textContent = error.message;
        $('#jobError').classList.remove('hidden');
      }
      await loadWorkerStatus();
    })
  );

  $('#deleteJobBtn').addEventListener('click', (event) =>
    withButtonLoading(event.currentTarget, 'Removing', () => deleteJob())
  );

  $('#reviewAiIgnore').addEventListener('change', async (event) => {
    event.currentTarget.disabled = true;
    try {
      await updateSelectedAiIgnore(event.currentTarget.checked);
    } finally {
      event.currentTarget.disabled = false;
    }
  });

  $('#conversationAiIgnore').addEventListener('change', async (event) => {
    event.currentTarget.disabled = true;
    try {
      await updateSelectedAiIgnore(event.currentTarget.checked);
    } finally {
      event.currentTarget.disabled = false;
    }
  });

  $('#manualMessageForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const id = state.selectedJob?.id;
    const message = $('#manualMessage').value.trim();
    if (!id || !message) return;
    const button = event.submitter || $('#manualMessageForm button[type="submit"]');
    await withButtonLoading(button, 'Sending', async () => {
      const response = await api(`/api/jobs/${id}/conversation`, {
        method: 'POST',
        body: JSON.stringify({ message })
      });
      $('#manualMessage').value = '';
      fillJobForm(response.job);
      await loadConversation(id);
      await loadRecentConversations();
      await refreshMainData();
    });
  });

  $('#settingsForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = event.submitter || $('#settingsForm button[type="submit"]');
    await withButtonLoading(button, 'Saving', async () => {
      await api('/api/settings', { method: 'PATCH', body: JSON.stringify(collectSettings('settings')) });
      await loadSettings();
      await refreshMainData();
    });
  });

  $('#promptForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = event.submitter || $('#promptForm button[type="submit"]');
    await withButtonLoading(button, 'Saving', async () => {
      await api('/api/settings', { method: 'PATCH', body: JSON.stringify(collectSettings('prompt')) });
      await loadSettings();
    });
  });

  $('#technicianForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const id = $('#technicianId').value;
    const payload = {
      name: $('#technicianName').value,
      techId: $('#technicianTechId').value,
      telegramId: $('#technicianTelegramId').value
    };
    const button = event.submitter || $('#saveTechnicianBtn');
    await withButtonLoading(button, 'Saving', async () => {
      await api(id ? `/api/technicians/${id}` : '/api/technicians', {
        method: id ? 'PATCH' : 'POST',
        body: JSON.stringify(payload)
      });
      clearTechnicianForm();
      await loadTechnicians();
      await refreshMainData();
      await loadRecentConversations();
    });
  });

  $('#clearTechnicianBtn').addEventListener('click', clearTechnicianForm);

  $('#testBlueBubblesBtn').addEventListener('click', (event) =>
    withButtonLoading(event.currentTarget, 'Testing', async () => {
      $('#settingsStatus').textContent = 'Testing BlueBubbles...';
      try {
        const payload = await api('/api/settings/test-bluebubbles', { method: 'POST', body: '{}' });
        $('#settingsStatus').textContent = payload.result.message || 'BlueBubbles OK';
      } catch (error) {
        $('#settingsStatus').textContent = error.message;
      }
    })
  );

  $('#useCurrentDomainBtn').addEventListener('click', () => {
    $('#appBaseUrl').value = window.location.origin;
    $('#settingsStatus').textContent = `App base URL set to ${window.location.origin}. Save settings to update webhook URL.`;
  });

  $('#copyWebhookUrlBtn').addEventListener('click', (event) =>
    withButtonLoading(event.currentTarget, 'Copying', async () => {
      try {
        await copyText($('#bluebubblesWebhookUrl').value);
        $('#settingsStatus').textContent = 'BlueBubbles webhook URL copied.';
      } catch (error) {
        $('#settingsStatus').textContent = error.message;
      }
    })
  );

  $('#startTelegramWorkerBtn').addEventListener('click', (event) =>
    withButtonLoading(event.currentTarget, 'Starting', async () => {
      $('#telegramWorkerState').textContent = 'starting';
      if ($('#telegramBotToken').value) {
        await api('/api/settings', { method: 'PATCH', body: JSON.stringify(collectSettings('settings')) });
      }
      const payload = await api('/api/workers/telegram/start', { method: 'POST', body: '{}' });
      renderWorkerStatus(payload.telegram);
      await loadSettings();
    })
  );

  $('#stopTelegramWorkerBtn').addEventListener('click', (event) =>
    withButtonLoading(event.currentTarget, 'Stopping', async () => {
      $('#telegramWorkerState').textContent = 'stopping';
      const payload = await api('/api/workers/telegram/stop', { method: 'POST', body: '{}' });
      renderWorkerStatus(payload.telegram);
    })
  );

  $('#refreshWorkerLogsBtn').addEventListener('click', (event) =>
    withButtonLoading(event.currentTarget, 'Refreshing', loadWorkerStatus)
  );
}

async function init() {
  wireEvents();
  clearSelectedJob();
  await loadSettings();
  await loadTechnicians();
  await refreshMainData();
  await loadRecentConversations();
}

init().catch((error) => {
  console.error(error);
  $('#jobList').innerHTML = `<div class="empty">Failed to load app: ${escapeHtml(error.message)}</div>`;
});

window.addEventListener('unhandledrejection', (event) => {
  const message = event.reason?.message || 'Action failed.';
  showGlobalStatus(message, 'error');
});
