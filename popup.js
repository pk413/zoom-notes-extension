/* ============================================================
   ZoomNotes — popup.js
   Vanilla JS, no dependencies
   ============================================================ */

'use strict';

// ── DOM refs ───────────────────────────────────────────────
const tabList      = document.getElementById('tabList');
const emptyState   = document.getElementById('emptyState');
const tabCount     = document.getElementById('tabCount');
const startBtn     = document.getElementById('startBtn');
const stopBtn      = document.getElementById('stopBtn');
const dashboardBtn = document.getElementById('dashboardBtn');
const settingsBtn  = document.getElementById('settingsBtn');
const timerDisplay = document.getElementById('timerDisplay');
const recDot       = document.getElementById('recDot');
const recLabel     = document.getElementById('recLabel');
const toast        = document.getElementById('toast');

// Status badge elements
const dotGemini  = document.getElementById('dotGemini');
const dotNotion  = document.getElementById('dotNotion');
const dotPi      = document.getElementById('dotPi');
const badgeGemini = document.getElementById('badgeGemini');
const badgeNotion = document.getElementById('badgeNotion');
const badgePi     = document.getElementById('badgePi');

// ── State ──────────────────────────────────────────────────
let timerInterval = null;
let recordingStart = null;   // Date object when recording began
let isRecording = false;
let zoomTabs = [];

// ── Init ───────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  await loadSettings();
  await discoverZoomTabs();
  await syncRecordingState();
  attachListeners();
});

// ── Settings & Badge Status ────────────────────────────────
async function loadSettings() {
  const keys = ['geminiApiKey', 'cloudBackendUrl', 'notionToken', 'piBaseUrl', 'preferLocal', 'backendMode'];
  const data = await chromeStorageGet(keys);

  const mode = data.backendMode || (data.preferLocal ? 'pi' : (data.cloudBackendUrl ? 'cloud' : 'gemini'));
  const labelAi = document.querySelector('#badgeGemini .badge-label');

  if (mode === 'cloud') {
    if (labelAi) labelAi.textContent = 'NVIDIA';
    setBadge(badgeGemini, dotGemini, !!data.cloudBackendUrl);
  } else if (mode === 'pi') {
    if (labelAi) labelAi.textContent = 'Gemini';
    setBadge(badgeGemini, dotGemini, false);
  } else {
    if (labelAi) labelAi.textContent = 'Gemini';
    setBadge(badgeGemini, dotGemini, !!data.geminiApiKey);
  }

  setBadge(badgeNotion, dotNotion, !!data.notionToken);
  setBadge(badgePi, dotPi, !!data.piBaseUrl && mode === 'pi');
}

function setBadge(badgeEl, dotEl, ok) {
  badgeEl.classList.toggle('ok', ok);
  badgeEl.classList.toggle('err', !ok);
  dotEl.textContent = ok ? '●' : '●';
}

// ── Zoom Tab Discovery ─────────────────────────────────────
async function discoverZoomTabs() {
  const urlPatterns = [
    '*://*.zoom.us/wc/*',
    '*://zoom.us/wc/*',
    '*://*.zoom.us/j/*',
  ];

  let tabs = [];
  try {
    tabs = await new Promise((resolve) => {
      chrome.tabs.query({ url: urlPatterns }, (results) => resolve(results || []));
    });
  } catch (_) { tabs = []; }

  zoomTabs = tabs;
  tabCount.textContent = `${tabs.length} found`;

  // Clear previous list items but keep emptyState node
  Array.from(tabList.querySelectorAll('.tab-item')).forEach((el) => el.remove());

  if (tabs.length === 0) {
    emptyState.style.display = 'flex';
    startBtn.disabled = true;
    return;
  }

  emptyState.style.display = 'none';

  tabs.slice(0, 3).forEach((tab, idx) => {
    const item = buildTabItem(tab, idx);
    tabList.appendChild(item);
  });

  updateStartButton();
}

function buildTabItem(tab, idx) {
  const wrap = document.createElement('label');
  wrap.className = 'tab-item';
  wrap.htmlFor = `tabCheck-${tab.id}`;

  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.id = `tabCheck-${tab.id}`;
  cb.dataset.tabId = tab.id;
  cb.checked = idx === 0; // pre-check first tab
  cb.addEventListener('change', updateStartButton);

  const info = document.createElement('div');
  info.className = 'tab-info';

  const title = document.createElement('div');
  title.className = 'tab-title';
  title.textContent = tab.title || 'Zoom Meeting';

  const url = document.createElement('div');
  url.className = 'tab-url';
  url.textContent = tab.url || '';

  info.appendChild(title);
  info.appendChild(url);

  if (tab.favIconUrl) {
    const fav = document.createElement('img');
    fav.className = 'tab-favicon';
    fav.src = tab.favIconUrl;
    fav.alt = '';
    wrap.appendChild(fav);
  }

  wrap.appendChild(cb);
  wrap.appendChild(info);
  return wrap;
}

function getCheckedTabIds() {
  return Array.from(tabList.querySelectorAll('input[type="checkbox"]:checked'))
    .map((cb) => parseInt(cb.dataset.tabId, 10))
    .filter(Boolean)
    .slice(0, 3);
}

function updateStartButton() {
  const checked = getCheckedTabIds();
  startBtn.disabled = checked.length === 0 || isRecording;
}

// ── Sync Recording State from Background ──────────────────
async function syncRecordingState() {
  try {
    const state = await sendMessage({ action: 'get-state' });
    if (state && state.isRecording) {
      isRecording = true;
      recordingStart = state.startTime ? new Date(state.startTime) : new Date();
      enterRecordingUI();
      startTimerInterval();
    }
  } catch (_) { /* background not ready */ }
}

// ── Button Listeners ───────────────────────────────────────
function attachListeners() {
  startBtn.addEventListener('click', onStartClick);
  stopBtn.addEventListener('click', onStopClick);
  dashboardBtn.addEventListener('click', onDashboardClick);
  settingsBtn.addEventListener('click', onSettingsClick);

  // Listen for real-time updates from background
  chrome.runtime.onMessage.addListener(handleBackgroundMessage);
}

async function onStartClick() {
  const tabIds = getCheckedTabIds();
  if (tabIds.length === 0) {
    showToast('Select at least one Zoom tab.', 'error');
    return;
  }

  startBtn.disabled = true;
  startBtn.textContent = '⏳ Starting…';

  try {
    await sendMessage({ action: 'start-recording', tabIds });
    isRecording = true;
    recordingStart = new Date();
    enterRecordingUI();
    startTimerInterval();
    showToast('Recording started ✅', 'success');
  } catch (err) {
    startBtn.disabled = false;
    startBtn.innerHTML = '<span>🔴</span> Start Recording';
    showToast('Failed to start: ' + (err.message || err), 'error');
  }
}

async function onStopClick() {
  stopBtn.disabled = true;
  stopBtn.textContent = '⏳ Saving…';

  try {
    await sendMessage({ action: 'stop-recording' });
    isRecording = false;
    exitRecordingUI();
    stopTimerInterval();
    showToast('Notes saved to Notion! 📓', 'success');
  } catch (err) {
    stopBtn.disabled = false;
    stopBtn.innerHTML = '<span>⏹</span> Stop &amp; Save Notes';
    showToast('Error stopping: ' + (err.message || err), 'error');
  }
}

function onDashboardClick() {
  chrome.runtime.sendMessage({ action: 'open-dashboard' });
}

function onSettingsClick() {
  chrome.tabs.create({ url: chrome.runtime.getURL('settings.html') });
}

// ── Recording UI Transitions ───────────────────────────────
function enterRecordingUI() {
  recDot.textContent = '🔴';
  recDot.classList.add('recording');
  recLabel.textContent = 'Recording';
  recLabel.classList.add('recording');
  timerDisplay.classList.add('recording');
  startBtn.disabled = true;
  startBtn.innerHTML = '<span>🔴</span> Recording…';
  stopBtn.disabled = false;
  stopBtn.innerHTML = '<span>⏹</span> Stop &amp; Save Notes';
  // Disable tab checkboxes during recording
  tabList.querySelectorAll('input[type="checkbox"]').forEach((cb) => { cb.disabled = true; });
}

function exitRecordingUI() {
  recDot.textContent = '⚪';
  recDot.classList.remove('recording');
  recLabel.textContent = 'Idle';
  recLabel.classList.remove('recording');
  timerDisplay.textContent = '00:00:00';
  timerDisplay.classList.remove('recording');
  startBtn.disabled = false;
  startBtn.innerHTML = '<span>🔴</span> Start Recording';
  stopBtn.disabled = true;
  stopBtn.innerHTML = '<span>⏹</span> Stop &amp; Save Notes';
  tabList.querySelectorAll('input[type="checkbox"]').forEach((cb) => { cb.disabled = false; });
}

// ── Timer ──────────────────────────────────────────────────
function startTimerInterval() {
  stopTimerInterval();
  timerInterval = setInterval(updateTimerDisplay, 1000);
  updateTimerDisplay();
}

function stopTimerInterval() {
  if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
}

function updateTimerDisplay() {
  if (!recordingStart) return;
  const elapsed = Math.floor((Date.now() - recordingStart.getTime()) / 1000);
  const h = String(Math.floor(elapsed / 3600)).padStart(2, '0');
  const m = String(Math.floor((elapsed % 3600) / 60)).padStart(2, '0');
  const s = String(elapsed % 60).padStart(2, '0');
  timerDisplay.textContent = `${h}:${m}:${s}`;
}

// ── Background Message Handler ─────────────────────────────
function handleBackgroundMessage(msg) {
  if (!msg || !msg.action) return;
  switch (msg.action) {
    case 'notes-saved':
      showToast('📓 Notes saved to Notion!', 'success');
      break;
    case 'notes-error':
      showToast('⚠️ Notes error: ' + (msg.error || 'unknown'), 'error');
      break;
    case 'recording-stopped':
      isRecording = false;
      exitRecordingUI();
      stopTimerInterval();
      break;
  }
}

// ── Toast ──────────────────────────────────────────────────
let toastTimeout = null;
function showToast(message, type = 'success') {
  toast.textContent = message;
  toast.className = `toast show ${type}`;
  if (toastTimeout) clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => {
    toast.classList.remove('show');
  }, 3500);
}

// ── Helpers ────────────────────────────────────────────────
function chromeStorageGet(keys) {
  return new Promise((resolve) => chrome.storage.sync.get(keys, resolve));
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
