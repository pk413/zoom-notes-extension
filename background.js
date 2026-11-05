// background.js — ZoomNotes Service Worker (ES Module)
import { generateNotes } from './notes-processor.js';
import { ensureNotionDatabase, saveToNotion } from './notion-client.js';

// ─── State ────────────────────────────────────────────────────────────────────
// tabId → { tabTitle, streamId, screenshots, pendingAudioB64, pendingMimeType,
//            allNotes, notionPageId, notionPageUrl, startTime, windowId }
const sessions = new Map();
let isRecording = false;
let recordingStartTime = null;

// ─── Message Router ───────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  switch (msg.action) {
    case 'start-recording':
      handleStartRecording(msg.tabIds).then(sendResponse).catch(err => {
        console.error('[BG] start-recording error:', err);
        sendResponse({ ok: false, error: err.message });
      });
      return true; // async

    case 'stop-recording':
      handleStopRecording().then(sendResponse).catch(err => {
        console.error('[BG] stop-recording error:', err);
        sendResponse({ ok: false, error: err.message });
      });
      return true;

    case 'audio-chunk':
      if (sessions.has(msg.tabId)) {
        const s = sessions.get(msg.tabId);
        s.pendingAudioB64 = msg.audioB64;
        s.pendingMimeType = msg.mimeType;
      }
      break;

    case 'get-state':
      sendResponse({
        isRecording,
        startTime: recordingStartTime,
        sessions: [...sessions.entries()].map(([tid, s]) => serializeSession(tid, s)),
        sessionList: [...sessions.entries()].map(([tid, s]) => serializeSession(tid, s)),
      });
      break;

    case 'recording-started':
      if (sessions.has(msg.tabId)) {
        sessions.get(msg.tabId).active = true;
      }
      broadcastToRuntime({ action: 'recording-started', tabId: msg.tabId, startTime: recordingStartTime });
      break;

    case 'open-dashboard':
      chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') });
      break;

    default:
      break;
  }
});

// ─── Start Recording ──────────────────────────────────────────────────────────
async function handleStartRecording(tabIds) {
  if (!Array.isArray(tabIds) || tabIds.length === 0) {
    throw new Error('No tabIds provided');
  }

  const cappedIds = tabIds.slice(0, 3); // max 3 simultaneous

  for (const tabId of cappedIds) {
    let tabTitle = `Tab ${tabId}`;
    let windowId = chrome.windows.WINDOW_ID_CURRENT;
    try {
      const tab = await chrome.tabs.get(tabId);
      tabTitle = tab.title || tabTitle;
      windowId = tab.windowId;
    } catch (e) {
      console.warn(`[BG] Could not get tab info for ${tabId}:`, e.message);
    }

    // Get stream ID for tab audio capture
    const streamId = await new Promise((resolve, reject) => {
      chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (id) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve(id);
        }
      });
    });

    sessions.set(tabId, {
      tabTitle,
      windowId,
      streamId,
      screenshots: [],
      pendingAudioB64: null,
      pendingMimeType: null,
      allNotes: [],
      notionPageId: null,
      startTime: Date.now(),
      active: false,
    });
  }

  await ensureOffscreenDocument();

  // Tell offscreen to start recording all sessions
  const sessionList = [...sessions.entries()].map(([tabId, s]) => ({
    tabId,
    streamId: s.streamId,
  }));
  await chrome.runtime.sendMessage({
    target: 'offscreen',
    action: 'start-all',
    sessions: sessionList,
  }).catch(() => {}); // offscreen may not ack

  // Create recurring alarms
  await chrome.alarms.clearAll();
  chrome.alarms.create('screenshots', { periodInMinutes: 0.5 }); // every 30s
  chrome.alarms.create('live-notes', { periodInMinutes: 5 });     // every 5 min

  isRecording = true;
  recordingStartTime = Date.now();
  broadcastToRuntime({ action: 'state-changed', isRecording: true, startTime: recordingStartTime });
  broadcastToRuntime({ action: 'recording-started', startTime: recordingStartTime });

  return { ok: true };
}

// ─── Stop Recording ───────────────────────────────────────────────────────────
async function handleStopRecording() {
  await chrome.alarms.clearAll();

  await chrome.runtime.sendMessage({
    target: 'offscreen',
    action: 'stop-all',
  }).catch(() => {});

  // Process final notes for each session
  const finalResults = [];
  for (const [tabId] of sessions) {
    try {
      await processSessionNotes(tabId, 'final');
      finalResults.push({ tabId, ok: true });
    } catch (err) {
      console.error(`[BG] Final notes error for tab ${tabId}:`, err);
      finalResults.push({ tabId, ok: false, error: err.message });
    }
  }

  // Trigger markdown downloads
  await generateAndSaveFinalNotes();

  isRecording = false;
  recordingStartTime = null;
  broadcastToRuntime({ action: 'state-changed', isRecording: false });
  broadcastToRuntime({ action: 'recording-stopped' });

  const result = {
    ok: true,
    sessions: serializeForExport(),
  };

  sessions.clear();
  return result;
}

// ─── Alarm Handler ────────────────────────────────────────────────────────────
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'screenshots') {
    await handleScreenshotAlarm();
  } else if (alarm.name === 'live-notes') {
    await handleLiveNotesAlarm();
  }
});

async function handleScreenshotAlarm() {
  for (const [tabId, session] of sessions) {
    try {
      // Bring tab to foreground briefly to capture
      await chrome.tabs.update(tabId, { active: true });
      await sleep(150);

      const tab = await chrome.tabs.get(tabId);
      const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
        format: 'jpeg',
        quality: 65,
      });

      const entry = { dataUrl, time: Date.now() };
      session.screenshots.push(entry);

      // Keep max 20 screenshots
      if (session.screenshots.length > 20) {
        session.screenshots.shift();
      }

      broadcastToRuntime({
        action: 'screenshot-update',
        tabId,
        dataUrl,
        time: entry.time,
      });
    } catch (err) {
      console.warn(`[BG] Screenshot failed for tab ${tabId}:`, err.message);
      // Skip on error — tab may have navigated away or been closed
    }
  }
}

async function handleLiveNotesAlarm() {
  for (const [tabId, session] of sessions) {
    if (!session.pendingAudioB64) continue;
    try {
      await processSessionNotes(tabId, 'interim');
      session.pendingAudioB64 = null;
      session.pendingMimeType = null;
    } catch (err) {
      console.error(`[BG] Live notes error for tab ${tabId}:`, err);
    }
  }
}

// ─── Notes Processing ─────────────────────────────────────────────────────────
async function processSessionNotes(tabId, type) {
  const session = sessions.get(tabId);
  if (!session) return;

  const settings = await getSettings();

  const notes = await generateNotes(
    session.pendingAudioB64,
    session.pendingMimeType,
    session.screenshots,
    settings,
    type === 'interim'
  );

  const noteEntry = {
    type,
    timestamp: Date.now(),
    content: notes,
  };
  session.allNotes.push(noteEntry);

  // Save to Notion if token is set
  if (settings.notionToken) {
    try {
      // Ensure database exists
      await ensureNotionDatabase(settings);
      const freshSettings = await getSettings(); // re-read in case DB ID was stored
      const notionUrl = await saveToNotion(session, notes, type, freshSettings);
      if (notionUrl) {
        session.notionPageUrl = notionUrl;
        broadcastToRuntime({ action: 'notion-link', tabId, url: notionUrl });
      }
    } catch (err) {
      console.error('[BG] Notion save error:', err);
    }
  }

  broadcastToRuntime({
    action: 'notes-update',
    tabId,
    notes,
    type,
    timestamp: noteEntry.timestamp,
  });
}

// ─── Final Notes Download ─────────────────────────────────────────────────────
async function generateAndSaveFinalNotes() {
  for (const [tabId, session] of sessions) {
    try {
      const markdown = buildMarkdownExport(session);
      const dataUrl =
        'data:text/markdown;charset=utf-8,' + encodeURIComponent(markdown);
      const filename = sanitizeFilename(
        `ZoomNotes_${session.tabTitle}_${formatDate(session.startTime)}.md`
      );
      await chrome.downloads.download({
        url: dataUrl,
        filename,
        saveAs: false,
      });
    } catch (err) {
      console.error(`[BG] Download error for tab ${tabId}:`, err);
    }
  }
}

function buildMarkdownExport(session) {
  const header = [
    `# Meeting Notes — ${session.tabTitle}`,
    `**Date:** ${new Date(session.startTime).toLocaleString()}`,
    `**Duration:** ${formatDuration(Date.now() - session.startTime)}`,
    `**Screenshots captured:** ${session.screenshots.length}`,
    '',
    '---',
    '',
  ].join('\n');

  const body = session.allNotes
    .map((n) => {
      const label =
        n.type === 'interim'
          ? `### Interim Notes — ${new Date(n.timestamp).toLocaleTimeString()}`
          : '### Final Notes';
      return `${label}\n\n${n.content}`;
    })
    .join('\n\n---\n\n');

  return header + body;
}

// ─── Offscreen Document ───────────────────────────────────────────────────────
async function ensureOffscreenDocument() {
  const existing = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
  });
  if (existing.length > 0) return;

  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['USER_MEDIA'],
    justification: 'Multi-tab Zoom audio capture',
  });
}

// ─── Settings ─────────────────────────────────────────────────────────────────
async function getSettings() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(
      [
        'geminiApiKey',
        'notionToken',
        'notionDatabaseId',
        'notionParentPageId',
        'preferLocal',
        'piBaseUrl',
        'aiBackend',
      ],
      (items) => resolve(items || {})
    );
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function serializeSession(tabId, s) {
  const lastShot = s.screenshots && s.screenshots.length > 0 ? s.screenshots[s.screenshots.length - 1] : null;
  return {
    tabId,
    tabTitle: s.tabTitle,
    title: s.tabTitle,
    startTime: s.startTime,
    screenshotCount: s.screenshots.length,
    screenshotUrl: lastShot ? lastShot.dataUrl : null,
    screenshotTime: lastShot ? lastShot.time : null,
    noteCount: s.allNotes.length,
    notes: s.allNotes.map((n) => ({ text: n.content, type: n.type, time: n.timestamp })),
    notionPageId: s.notionPageId || null,
    notionUrl: s.notionPageUrl || null,
    active: s.active || false,
    hasPendingAudio: !!s.pendingAudioB64,
  };
}

function serializeForExport() {
  return [...sessions.entries()].map(([tabId, s]) => ({
    tabId,
    tabTitle: s.tabTitle,
    startTime: s.startTime,
    duration: Date.now() - s.startTime,
    screenshotCount: s.screenshots.length,
    allNotes: s.allNotes,
    notionPageId: s.notionPageId || null,
  }));
}

function broadcastToRuntime(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {
    // Dashboard or popup may not be open — ignore
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function formatDate(ts) {
  return new Date(ts).toISOString().slice(0, 10);
}

function formatDuration(ms) {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function sanitizeFilename(name) {
  return name.replace(/[/\\?%*:|"<>]/g, '-').replace(/\s+/g, '_');
}
