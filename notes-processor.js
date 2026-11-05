// notes-processor.js — ZoomNotes AI Notes Generator (ES Module)
'use strict';

const GEMINI_MODEL = 'gemini-2.5-flash';
const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Generate meeting notes from audio and screenshots.
 *
 * @param {string|null} audioB64      - Base64-encoded audio data
 * @param {string|null} mimeType      - Audio MIME type (e.g. 'audio/webm')
 * @param {Array<{dataUrl:string}>}   screenshots - Captured screenshot objects
 * @param {Object} settings           - Extension settings from chrome.storage
 * @param {boolean} isInterim         - Whether these are interim or final notes
 * @returns {Promise<string>}         - Markdown-formatted meeting notes
 */
export async function generateNotes(audioB64, mimeType, screenshots, settings, isInterim = false) {
  const hasAudio = !!audioB64;
  const hasGemini = !!settings.geminiApiKey;
  const hasPi = !!(settings.preferLocal && settings.piBaseUrl) || !!settings.piBaseUrl;

  if (!hasAudio && screenshots.length === 0) {
    return '_(No audio or screenshots available for this interval.)_';
  }

  // Routing logic:
  // 1. If cloudBackendUrl is configured (e.g. Hugging Face / Render / Railway with NVIDIA NIM) → use Cloud Backend
  // 2. If preferLocal AND Pi URL is set → use Pi
  // 3. Else if Gemini key → use Gemini (fallback to Pi/Cloud on error)
  // 4. Else if Pi URL set → use Pi
  // 5. Else throw
  if (settings.cloudBackendUrl) {
    try {
      return await generateWithCloudBackend(audioB64, mimeType, settings.cloudBackendUrl, settings.nvidiaApiKey, isInterim);
    } catch (err) {
      console.warn('[NotesProcessor] Cloud backend failed, attempting fallback:', err.message);
      if (hasGemini) {
        return await generateWithGemini(audioB64, mimeType, screenshots, settings.geminiApiKey, isInterim);
      }
      if (settings.piBaseUrl) {
        return generateWithPi(audioB64, mimeType, settings.piBaseUrl, isInterim);
      }
      throw err;
    }
  }

  if (settings.preferLocal && settings.piBaseUrl) {
    return generateWithPi(audioB64, mimeType, settings.piBaseUrl, isInterim);
  }

  if (hasGemini) {
    try {
      return await generateWithGemini(audioB64, mimeType, screenshots, settings.geminiApiKey, isInterim);
    } catch (err) {
      console.warn('[NotesProcessor] Gemini failed, attempting Pi fallback:', err.message);
      if (settings.piBaseUrl) {
        return generateWithPi(audioB64, mimeType, settings.piBaseUrl, isInterim);
      }
      throw err;
    }
  }

  if (settings.piBaseUrl) {
    return generateWithPi(audioB64, mimeType, settings.piBaseUrl, isInterim);
  }

  throw new Error(
    'No AI backend configured. Please set a Gemini API key, Cloud Backend URL, or Raspberry Pi URL in settings.'
  );
}

/**
 * Call hosted backend (e.g. on Render, Hugging Face, or Railway)
 * that wraps faster-whisper with free NVIDIA NIM endpoints.
 */
async function generateWithCloudBackend(audioB64, mimeType, backendUrl, nvidiaApiKey, isInterim) {
  const url = backendUrl.replace(/\/+$/, '') + '/api/process-meeting';
  const audioBlob = base64ToBlob(audioB64, mimeType || 'audio/webm');
  const formData = new FormData();
  formData.append('file', audioBlob, 'meeting-audio.webm');
  formData.append('is_interim', isInterim ? 'true' : 'false');

  const headers = {};
  if (nvidiaApiKey) {
    headers['Authorization'] = `Bearer ${nvidiaApiKey}`;
  }

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: formData,
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => res.statusText);
    throw new Error(`Cloud backend error ${res.status}: ${errText}`);
  }

  const data = await res.json();
  return data.notes || '_(No notes returned from cloud backend)_';
}

/**
 * Convert a base64 string back to a Blob.
 *
 * @param {string} b64       - Base64-encoded data
 * @param {string} mimeType  - MIME type for the resulting Blob
 * @returns {Blob}
 */
export function base64ToBlob(b64, mimeType) {
  const binary = atob(b64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: mimeType });
}

// ─── Gemini Backend ───────────────────────────────────────────────────────────

async function generateWithGemini(audioB64, mimeType, screenshots, apiKey, isInterim) {
  const parts = [];

  // System/instruction text
  parts.push({ text: buildPrompt(isInterim) });

  // Audio part (if available)
  if (audioB64) {
    parts.push({
      inline_data: {
        mime_type: mimeType || 'audio/webm',
        data: audioB64,
      },
    });
  }

  // Most recent screenshot (if available)
  if (screenshots.length > 0) {
    const lastScreenshot = screenshots.at(-1);
    // dataUrl format: "data:image/jpeg;base64,<data>"
    const rawB64 = lastScreenshot.dataUrl.includes(',')
      ? lastScreenshot.dataUrl.split(',')[1]
      : lastScreenshot.dataUrl;
    parts.push({
      inline_data: {
        mime_type: 'image/jpeg',
        data: rawB64,
      },
    });
  }

  const payload = {
    contents: [{ parts }],
    generationConfig: {
      temperature: 0.3,
      maxOutputTokens: 4096,
    },
  };

  const response = await fetch(`${GEMINI_ENDPOINT}?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => response.statusText);
    throw new Error(`Gemini API error ${response.status}: ${errText}`);
  }

  const data = await response.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  return text ?? '_(No notes generated by Gemini.)_';
}

// ─── Raspberry Pi / Local Backend ────────────────────────────────────────────

async function generateWithPi(audioB64, mimeType, piBaseUrl, isInterim) {
  const baseUrl = piBaseUrl.replace(/\/$/, ''); // strip trailing slash

  // Step 1: Transcribe audio via Whisper (OpenAI-compatible endpoint on Pi)
  let transcript = '';
  if (audioB64) {
    try {
      const audioBlob = base64ToBlob(audioB64, mimeType || 'audio/webm');
      const formData = new FormData();
      formData.append('file', audioBlob, 'audio.webm');
      formData.append('model', 'whisper-1');

      const whisperResp = await fetch(`${baseUrl}:8000/v1/audio/transcriptions`, {
        method: 'POST',
        body: formData,
      });

      if (!whisperResp.ok) {
        const errText = await whisperResp.text().catch(() => whisperResp.statusText);
        throw new Error(`Whisper error ${whisperResp.status}: ${errText}`);
      }

      const whisperData = await whisperResp.json();
      transcript = whisperData.text || '';
    } catch (err) {
      console.error('[NotesProcessor] Whisper transcription failed:', err);
      transcript = '(Transcription unavailable)';
    }
  } else {
    transcript = '(No audio provided)';
  }

  // Step 2: Generate notes via Ollama LLM
  const ollamaPayload = {
    model: 'llama3:8b-instruct-q4_0',
    messages: [
      {
        role: 'system',
        content: buildPrompt(isInterim),
      },
      {
        role: 'user',
        content: `Transcript:\n${transcript}`,
      },
    ],
    stream: false,
    options: {
      temperature: 0.3,
      num_predict: 2048,
    },
  };

  const ollamaResp = await fetch(`${baseUrl}:11434/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(ollamaPayload),
  });

  if (!ollamaResp.ok) {
    const errText = await ollamaResp.text().catch(() => ollamaResp.statusText);
    throw new Error(`Ollama error ${ollamaResp.status}: ${errText}`);
  }

  const ollamaData = await ollamaResp.json();
  const content =
    ollamaData?.choices?.[0]?.message?.content ??
    ollamaData?.message?.content ??
    '_(No notes generated by local model.)_';
  return content;
}

// ─── Prompt Builder ───────────────────────────────────────────────────────────

function buildPrompt(isInterim) {
  return `You are an expert meeting note-taker for Zoom meetings.
${isInterim ? '[INTERIM NOTES — append to existing notes]\n' : '[FINAL MEETING NOTES]\n'}
Analyze the provided audio recording and extract structured meeting notes.

Format your response EXACTLY as follows (use these exact markdown headings):

## Key Discussion Points
- Bullet point summary of main topics

## Decisions Made  
- Any decisions, conclusions, or agreements reached (write "None identified" if none)

## Action Items
- [ ] Task description — Owner (if mentioned) — Due date (if mentioned)
(write "None identified" if none)

## Important Quotes
> "Direct quote" — Speaker (if identifiable)
(omit section if none)

## Transcription
Full verbatim transcription of everything said in the audio.

Be accurate and structured. If audio is unclear or empty, state "Audio unclear or no speech detected."`;
}
