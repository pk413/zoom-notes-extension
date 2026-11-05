// offscreen.js — ZoomNotes Audio Engine (non-module, runs in offscreen document)
'use strict';

// tabId → { recorder, audioCtx, stream, chunks, flushInterval }
const recorders = new Map();

// ─── Message Listener ─────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  // Only handle messages targeting the offscreen document
  if (msg.target !== 'offscreen') return;

  switch (msg.action) {
    case 'start-all':
      if (Array.isArray(msg.sessions)) {
        msg.sessions.forEach(({ tabId, streamId }) => {
          startRecorder(tabId, streamId);
        });
      }
      sendResponse({ ok: true });
      break;

    case 'stop-all':
      for (const tabId of recorders.keys()) {
        stopRecorder(tabId);
      }
      sendResponse({ ok: true });
      break;

    case 'stop-tab':
      if (msg.tabId != null) {
        stopRecorder(msg.tabId);
      }
      sendResponse({ ok: true });
      break;

    default:
      break;
  }
  return true; // keep channel open for async responses
});

// ─── Start Recorder ───────────────────────────────────────────────────────────
async function startRecorder(tabId, streamId) {
  if (recorders.has(tabId)) {
    console.warn(`[Offscreen] Recorder for tab ${tabId} already running.`);
    return;
  }

  try {
    // Capture tab audio stream
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: streamId,
        },
      },
      video: false,
    });

    // Build audio graph
    const audioCtx = new AudioContext();
    const source = audioCtx.createMediaStreamSource(stream);

    // CRITICAL: passthrough so user still hears the meeting
    source.connect(audioCtx.destination);

    // Also route to MediaRecorder destination
    const dest = audioCtx.createMediaStreamDestination();
    source.connect(dest);

    // Determine best supported mime type
    const mimeType = getSupportedMimeType();

    const recorder = new MediaRecorder(dest.stream, { mimeType });
    const chunks = [];

    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) {
        chunks.push(e.data);
      }
    };

    recorder.onerror = (e) => {
      console.error(`[Offscreen] MediaRecorder error for tab ${tabId}:`, e.error);
    };

    // Collect data in 5-second slices
    recorder.start(5000);

    // Flush audio to background every 5 minutes
    const flushInterval = setInterval(async () => {
      if (chunks.length === 0) return;

      try {
        // Request any buffered data
        if (recorder.state === 'recording') {
          recorder.requestData();
          await sleep(300);
        }

        if (chunks.length === 0) return;

        const blob = new Blob([...chunks], { type: mimeType });
        chunks.length = 0; // clear in-place

        const ab = await blob.arrayBuffer();
        const b64 = arrayBufferToBase64(ab);

        chrome.runtime.sendMessage({
          action: 'audio-chunk',
          tabId,
          audioB64: b64,
          mimeType,
        }).catch((err) => {
          console.warn(`[Offscreen] Could not send audio chunk for tab ${tabId}:`, err.message);
        });
      } catch (flushErr) {
        console.error(`[Offscreen] Flush error for tab ${tabId}:`, flushErr);
      }
    }, 300000); // 5 minutes

    // Store the recorder state
    recorders.set(tabId, {
      recorder,
      audioCtx,
      stream,
      chunks,
      flushInterval,
    });

    // Notify background that recording has started
    chrome.runtime.sendMessage({ action: 'recording-started', tabId }).catch(() => {});

    console.log(`[Offscreen] Started recording tab ${tabId} with mimeType=${mimeType}`);
  } catch (err) {
    console.error(`[Offscreen] startRecorder failed for tab ${tabId}:`, err);
    chrome.runtime.sendMessage({
      action: 'recording-error',
      tabId,
      error: err.message,
    }).catch(() => {});
  }
}

// ─── Stop Recorder ────────────────────────────────────────────────────────────
function stopRecorder(tabId) {
  const entry = recorders.get(tabId);
  if (!entry) {
    console.warn(`[Offscreen] No recorder found for tab ${tabId}`);
    return;
  }

  const { recorder, audioCtx, stream, chunks, flushInterval } = entry;

  // Stop the flush interval
  clearInterval(flushInterval);

  // Request any buffered data before closing
  try {
    if (recorder.state === 'recording') {
      recorder.requestData();
    }
  } catch (e) {
    console.warn(`[Offscreen] requestData() on stop error for tab ${tabId}:`, e);
  }

  // Flush any remaining chunks before stopping
  if (chunks.length > 0) {
    try {
      const blob = new Blob([...chunks], { type: recorder.mimeType });
      chunks.length = 0;
      blob.arrayBuffer().then((ab) => {
        const b64 = arrayBufferToBase64(ab);
        chrome.runtime.sendMessage({
          action: 'audio-chunk',
          tabId,
          audioB64: b64,
          mimeType: recorder.mimeType,
        }).catch(() => {});
      });
    } catch (e) {
      console.warn(`[Offscreen] Final flush error for tab ${tabId}:`, e);
    }
  }

  // Stop MediaRecorder
  try {
    if (recorder.state !== 'inactive') {
      recorder.stop();
    }
  } catch (e) {
    console.warn(`[Offscreen] recorder.stop() error for tab ${tabId}:`, e);
  }

  // Stop all tracks
  try {
    stream.getTracks().forEach((t) => t.stop());
  } catch (e) {
    console.warn(`[Offscreen] stream.getTracks().stop() error for tab ${tabId}:`, e);
  }

  // Close AudioContext
  audioCtx.close().catch((e) => {
    console.warn(`[Offscreen] audioCtx.close() error for tab ${tabId}:`, e);
  });

  recorders.delete(tabId);
  console.log(`[Offscreen] Stopped recording tab ${tabId}`);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 8192; // process in chunks to avoid call stack overflow
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function getSupportedMimeType() {
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
    'audio/ogg',
  ];
  for (const mime of candidates) {
    if (MediaRecorder.isTypeSupported(mime)) {
      return mime;
    }
  }
  return ''; // browser default
}
