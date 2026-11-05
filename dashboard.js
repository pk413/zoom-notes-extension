/* ============================================================
   ZoomNotes — dashboard.js
   Vanilla JS, no dependencies
   ============================================================ */

'use strict';

// ── DOM refs ───────────────────────────────────────────────
const noSession    = document.getElementById('noSession');
const columnsGrid  = document.getElementById('columnsGrid');
const recDot       = document.getElementById('recDot');
const recLabel     = document.getElementById('recLabel');
const recStatus    = document.getElementById('recStatus');
const dashTimer    = document.getElementById('dashTimer');
const openPopupLink = document.getElementById('openPopupLink');

// ── State ──────────────────────────────────────────────────
// sessionMap: tabId → { tabId, title, notes:[], screenshotUrl, screenshotTime, notionUrl }
const sessionMap = new Map();
let timerInterval = null;
let recordingStart = null;

// ── Init ───────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  openPopupLink.addEventListener('click', (e) => {
    e.preventDefault();
    // Can't open popup programmatically in MV3; show friendly note
    alert('Click the ZoomNotes extension icon in your toolbar to open the popup.');
  });

  chrome.runtime.onMessage.addListener(handleBackgroundMessage);

  try {
    const state = await sendMessage({ action: 'get-state' });
    if (state && state.isRecording && state.sessions) {
      recordingStart = state.startTime ? new Date(state.startTime) : new Date();
      enterRecordingUI();
      state.sessions.forEach((session) => initColumn(session));
      startTimer();
    }
  } catch (_) { /* background not ready yet */ }
});

// ── Background Message Handler ─────────────────────────────
function handleBackgroundMessage(msg) {
  if (!msg || !msg.action) return;

  switch (msg.action) {
    case 'recording-started': {
      recordingStart = msg.startTime ? new Date(msg.startTime) : new Date();
      enterRecordingUI();
      startTimer();
      break;
    }
    case 'recording-stopped': {
      exitRecordingUI();
      stopTimer();
      break;
    }
    case 'screenshot-update': {
      const { tabId, dataUrl, time } = msg;
      ensureColumn(tabId);
      updateScreenshot(tabId, dataUrl, time);
      break;
    }
    case 'notes-update': {
      const { tabId, notes, type, time } = msg;
      ensureColumn(tabId);
      appendNotes(tabId, notes, type, time);
      break;
    }
    case 'session-info': {
      // Background broadcasts per-session info
      if (msg.session) initColumn(msg.session);
      break;
    }
    case 'notion-link': {
      const { tabId, url } = msg;
      if (sessionMap.has(tabId)) {
        sessionMap.get(tabId).notionUrl = url;
        refreshColFooter(tabId);
      }
      break;
    }
  }
}

// ── UI: Recording Mode ─────────────────────────────────────
function enterRecordingUI() {
  noSession.style.display   = 'none';
  columnsGrid.style.display = 'grid';
  recStatus.classList.add('recording');
  recDot.classList.add('recording');
  recDot.textContent = '🔴';
  recLabel.textContent = 'Recording';
  dashTimer.classList.add('recording');
}

function exitRecordingUI() {
  recStatus.classList.remove('recording');
  recDot.classList.remove('recording');
  recDot.textContent = '⚪';
  recLabel.textContent = 'Idle';
  dashTimer.classList.remove('recording');
  dashTimer.textContent = '00:00:00';
}

// ── Timer ──────────────────────────────────────────────────
function startTimer() {
  stopTimer();
  timerInterval = setInterval(tickTimer, 1000);
  tickTimer();
}
function stopTimer() {
  if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
}
function tickTimer() {
  if (!recordingStart) return;
  const elapsed = Math.floor((Date.now() - recordingStart.getTime()) / 1000);
  const h = String(Math.floor(elapsed / 3600)).padStart(2, '0');
  const m = String(Math.floor((elapsed % 3600) / 60)).padStart(2, '0');
  const s = String(elapsed % 60).padStart(2, '0');
  dashTimer.textContent = `${h}:${m}:${s}`;
}

// ── Column Management ──────────────────────────────────────
function ensureColumn(tabId) {
  if (!sessionMap.has(tabId)) {
    initColumn({ tabId, title: `Meeting (tab ${tabId})` });
  }
}

function initColumn(session) {
  const { tabId, title, screenshotUrl, screenshotTime, notionUrl, notes } = session;

  if (sessionMap.has(tabId)) {
    // Update existing entry
    const entry = sessionMap.get(tabId);
    if (title) entry.title = title;
    if (notionUrl) entry.notionUrl = notionUrl;
  } else {
    sessionMap.set(tabId, {
      tabId,
      title: title || `Meeting (tab ${tabId})`,
      notes: notes || [],
      screenshotUrl: screenshotUrl || null,
      screenshotTime: screenshotTime || null,
      notionUrl: notionUrl || null,
    });
    renderColumn(tabId);
  }

  if (screenshotUrl) updateScreenshot(tabId, screenshotUrl, screenshotTime);
  if (notes && notes.length) {
    notes.forEach((n) => appendNotes(tabId, n.text, n.type, n.time));
  }

  enterRecordingUI();
}

function renderColumn(tabId) {
  const session = sessionMap.get(tabId);
  if (!session) return;

  const colIndex = sessionMap.size;

  const col = document.createElement('div');
  col.className = 'meeting-col';
  col.dataset.tabId = tabId;

  col.innerHTML = `
    <div class="col-header">
      <span class="col-index">${colIndex}</span>
      <span class="col-title" id="colTitle-${tabId}">${escHtml(session.title)}</span>
    </div>
    <div class="screenshot-panel" id="screenshotPanel-${tabId}">
      <div class="screenshot-placeholder" id="screenshotPlaceholder-${tabId}">
        📷 Waiting for screenshot…
      </div>
      <span class="screenshot-ts" id="screenshotTs-${tabId}" style="display:none;"></span>
    </div>
    <div class="notes-panel" id="notesPanel-${tabId}">
      <div class="notes-empty" id="notesEmpty-${tabId}">📝 Waiting for AI notes…</div>
    </div>
    <div class="col-footer" id="colFooter-${tabId}">
      <button class="col-btn" id="dlBtn-${tabId}">📥 Download .md</button>
    </div>
  `;

  columnsGrid.appendChild(col);

  // Wire download button
  document.getElementById(`dlBtn-${tabId}`).addEventListener('click', () => downloadNotes(tabId));
}

function refreshColFooter(tabId) {
  const session = sessionMap.get(tabId);
  if (!session) return;
  const footer = document.getElementById(`colFooter-${tabId}`);
  if (!footer) return;

  // Remove old Notion link if present
  const old = footer.querySelector('.notion');
  if (old) old.remove();

  if (session.notionUrl) {
    const a = document.createElement('a');
    a.className = 'col-btn notion';
    a.href = session.notionUrl;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.innerHTML = '📓 Notion';
    footer.appendChild(a);
  }
}

// ── Screenshot Update ──────────────────────────────────────
function updateScreenshot(tabId, dataUrl, time) {
  const session = sessionMap.get(tabId);
  if (!session) return;
  session.screenshotUrl = dataUrl;
  session.screenshotTime = time || new Date().toISOString();

  const panel = document.getElementById(`screenshotPanel-${tabId}`);
  if (!panel) return;

  let img = panel.querySelector('.screenshot-img');
  if (!img) {
    // Remove placeholder
    const placeholder = panel.querySelector('.screenshot-placeholder');
    if (placeholder) placeholder.remove();

    img = document.createElement('img');
    img.className = 'screenshot-img';
    img.alt = 'Meeting screenshot';
    panel.insertBefore(img, panel.querySelector('.screenshot-ts'));
  }
  img.src = dataUrl;

  const tsEl = document.getElementById(`screenshotTs-${tabId}`);
  if (tsEl) {
    tsEl.style.display = 'block';
    tsEl.textContent = formatTimestamp(session.screenshotTime);
  }
}

// ── Notes Update ──────────────────────────────────────────
function appendNotes(tabId, notesText, type, time) {
  const session = sessionMap.get(tabId);
  if (!session) return;

  const noteTime = time || new Date().toISOString();
  session.notes.push({ text: notesText, type, time: noteTime });

  const panel = document.getElementById(`notesPanel-${tabId}`);
  if (!panel) return;

  // Remove empty placeholder
  const empty = document.getElementById(`notesEmpty-${tabId}`);
  if (empty) empty.remove();

  const entry = document.createElement('div');
  entry.className = 'note-entry';

  const label = type === 'live' ? '🔴 Live Notes' : '✅ Final Notes';
  const heading = document.createElement('div');
  heading.className = 'note-time-heading';
  heading.textContent = `${label} · ${formatTimestamp(noteTime)}`;

  const body = document.createElement('div');
  body.className = 'note-body';
  body.innerHTML = renderMarkdown(notesText);

  entry.appendChild(heading);
  entry.appendChild(body);
  panel.appendChild(entry);

  // Auto-scroll to bottom
  panel.scrollTop = panel.scrollHeight;
}

// ── Markdown Renderer (simple regex-based) ─────────────────
function renderMarkdown(md) {
  if (!md) return '';
  let html = escHtml(md);

  // ## Headings
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');

  // **bold**
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

  // > blockquote
  html = html.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>');

  // - [ ] checkbox
  html = html.replace(/^- \[ \] (.+)$/gm, '<li><input type="checkbox" disabled> $1</li>');
  html = html.replace(/^- \[x\] (.+)$/gmi, '<li><input type="checkbox" checked disabled> $1</li>');

  // - list items (after checkboxes)
  html = html.replace(/^- (.+)$/gm, '<li>$1</li>');

  // Wrap consecutive <li> in <ul>
  html = html.replace(/(<li>.*<\/li>\n?)+/g, (match) => `<ul>${match}</ul>`);

  // Line breaks
  html = html.replace(/\n/g, '<br>');

  return html;
}

// ── Download Notes ─────────────────────────────────────────
function downloadNotes(tabId) {
  const session = sessionMap.get(tabId);
  if (!session) return;

  const filename = sanitizeFilename(session.title || `meeting-${tabId}`) + '.md';
  const content = session.notes.map((n) => {
    const label = n.type === 'live' ? 'Live Notes' : 'Final Notes';
    return `## ${label} — ${n.time}\n\n${n.text}\n\n---\n`;
  }).join('\n');

  const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// ── Helpers ────────────────────────────────────────────────
function escHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function sanitizeFilename(name) {
  return name.replace(/[^a-z0-9_\-\. ]/gi, '_').trim().slice(0, 80);
}

function formatTimestamp(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch (_) { return iso; }
}

function sendMessage(msg) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(msg, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(response);
      }
    });
  });
}
