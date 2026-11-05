// settings.js — ZoomNotes Options Page Logic
'use strict';

document.addEventListener('DOMContentLoaded', async () => {
  // DOM Elements
  const radioGemini = document.getElementById('radioGemini');
  const radioCloud = document.getElementById('radioCloud');
  const radioPi = document.getElementById('radioPi');
  const geminiRadioCard = document.getElementById('geminiRadioCard');
  const cloudRadioCard = document.getElementById('cloudRadioCard');
  const piRadioCard = document.getElementById('piRadioCard');
  const geminiConfigBlock = document.getElementById('geminiConfigBlock');
  const cloudConfigBlock = document.getElementById('cloudConfigBlock');
  const piConfigBlock = document.getElementById('piConfigBlock');

  const geminiApiKeyInput = document.getElementById('geminiApiKey');
  const toggleGeminiKeyVis = document.getElementById('toggleGeminiKeyVis');
  const testGeminiBtn = document.getElementById('testGeminiBtn');
  const geminiFeedback = document.getElementById('geminiFeedback');

  const cloudBackendUrlInput = document.getElementById('cloudBackendUrl');
  const nvidiaApiKeyInput = document.getElementById('nvidiaApiKey');
  const toggleNvidiaKeyVis = document.getElementById('toggleNvidiaKeyVis');
  const testCloudBtn = document.getElementById('testCloudBtn');
  const cloudFeedback = document.getElementById('cloudFeedback');

  const piBaseUrlInput = document.getElementById('piBaseUrl');
  const testPiBtn = document.getElementById('testPiBtn');
  const piFeedback = document.getElementById('piFeedback');
  const piWhisperUrl = document.getElementById('piWhisperUrl');
  const piOllamaUrl = document.getElementById('piOllamaUrl');

  const notionTokenInput = document.getElementById('notionToken');
  const toggleNotionTokenVis = document.getElementById('toggleNotionTokenVis');
  const notionParentPageIdInput = document.getElementById('notionParentPageId');
  const notionDatabaseIdInput = document.getElementById('notionDatabaseId');
  const createNotionDbBtn = document.getElementById('createNotionDbBtn');
  const notionFeedback = document.getElementById('notionFeedback');

  const aiStatusBadge = document.getElementById('aiStatusBadge');
  const notionStatusBadge = document.getElementById('notionStatusBadge');
  const saveSettingsBtn = document.getElementById('saveSettingsBtn');
  const saveStatus = document.getElementById('saveStatus');

  // Load Saved Settings
  const saved = await new Promise((resolve) => {
    chrome.storage.sync.get(
      [
        'geminiApiKey',
        'cloudBackendUrl',
        'nvidiaApiKey',
        'notionToken',
        'notionParentPageId',
        'notionDatabaseId',
        'preferLocal',
        'backendMode',
        'piBaseUrl',
      ],
      (data) => resolve(data || {})
    );
  });

  // Populate Fields
  if (saved.geminiApiKey) geminiApiKeyInput.value = saved.geminiApiKey;
  if (saved.cloudBackendUrl) cloudBackendUrlInput.value = saved.cloudBackendUrl;
  if (saved.nvidiaApiKey) nvidiaApiKeyInput.value = saved.nvidiaApiKey;
  if (saved.notionToken) notionTokenInput.value = saved.notionToken;
  if (saved.notionParentPageId) notionParentPageIdInput.value = saved.notionParentPageId;
  if (saved.notionDatabaseId) notionDatabaseIdInput.value = saved.notionDatabaseId;
  if (saved.piBaseUrl) {
    piBaseUrlInput.value = saved.piBaseUrl;
  } else {
    piBaseUrlInput.value = 'http://rpi.local';
  }

  const mode = saved.backendMode || (saved.preferLocal ? 'pi' : (saved.cloudBackendUrl ? 'cloud' : 'gemini'));
  if (mode === 'cloud') {
    radioCloud.checked = true;
    updateBackendUI('cloud');
  } else if (mode === 'pi') {
    radioPi.checked = true;
    updateBackendUI('pi');
  } else {
    radioGemini.checked = true;
    updateBackendUI('gemini');
  }

  updateUrlSpecs(piBaseUrlInput.value);
  updateStatusBadges();

  // Radio selection listeners
  radioGemini.addEventListener('change', () => updateBackendUI('gemini'));
  radioCloud.addEventListener('change', () => updateBackendUI('cloud'));
  radioPi.addEventListener('change', () => updateBackendUI('pi'));

  function updateBackendUI(activeMode) {
    geminiConfigBlock.style.display = activeMode === 'gemini' ? 'block' : 'none';
    cloudConfigBlock.style.display = activeMode === 'cloud' ? 'block' : 'none';
    piConfigBlock.style.display = activeMode === 'pi' ? 'block' : 'none';

    geminiRadioCard.classList.toggle('selected', activeMode === 'gemini');
    cloudRadioCard.classList.toggle('selected', activeMode === 'cloud');
    piRadioCard.classList.toggle('selected', activeMode === 'pi');
  }

  // Live URL specs update
  piBaseUrlInput.addEventListener('input', () => {
    updateUrlSpecs(piBaseUrlInput.value);
  });

  function updateUrlSpecs(rawBase) {
    const base = (rawBase || 'http://rpi.local').replace(/\/+$/, '');
    piWhisperUrl.textContent = `${base}:8000/v1/audio/transcriptions`;
    piOllamaUrl.textContent = `${base}:11434/v1/chat/completions`;
  }

  // Toggle Visibility buttons
  toggleGeminiKeyVis.addEventListener('click', () => {
    geminiApiKeyInput.type = geminiApiKeyInput.type === 'password' ? 'text' : 'password';
  });

  if (toggleNvidiaKeyVis) {
    toggleNvidiaKeyVis.addEventListener('click', () => {
      nvidiaApiKeyInput.type = nvidiaApiKeyInput.type === 'password' ? 'text' : 'password';
    });
  }

  toggleNotionTokenVis.addEventListener('click', () => {
    notionTokenInput.type = notionTokenInput.type === 'password' ? 'text' : 'password';
  });

  // Test Cloud Backend / NVIDIA NIM Connection
  testCloudBtn.addEventListener('click', async () => {
    const backendUrl = (cloudBackendUrlInput.value.trim() || '').replace(/\/+$/, '');
    if (!backendUrl) {
      showFeedback(cloudFeedback, 'Please enter a Cloud Backend URL first.', 'error');
      return;
    }

    showFeedback(cloudFeedback, `Testing backend at ${backendUrl}...`, 'loading');
    try {
      const res = await fetch(`${backendUrl}/health`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      showFeedback(cloudFeedback, '✅ Connected! Cloud backend is online and ready for NVIDIA NIM.', 'success');
      updateStatusBadges();
    } catch (err) {
      showFeedback(cloudFeedback, `❌ Could not reach backend: ${err.message}. Is your Render / HF Space running?`, 'error');
    }
  });

  // Test Gemini Connection
  testGeminiBtn.addEventListener('click', async () => {
    const key = geminiApiKeyInput.value.trim();
    if (!key) {
      showFeedback(geminiFeedback, 'Please enter a Gemini API Key first.', 'error');
      return;
    }

    showFeedback(geminiFeedback, 'Testing connection to Google Generative AI...', 'loading');
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${key}`);
      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        throw new Error(errJson.error?.message || `HTTP ${res.status}`);
      }
      showFeedback(geminiFeedback, '✅ Connected! Gemini 2.5 Flash API is operational.', 'success');
      updateStatusBadges();
    } catch (err) {
      showFeedback(geminiFeedback, `❌ Connection failed: ${err.message}`, 'error');
    }
  });

  // Test Raspberry Pi Connection
  testPiBtn.addEventListener('click', async () => {
    const base = (piBaseUrlInput.value.trim() || 'http://rpi.local').replace(/\/+$/, '');
    showFeedback(piFeedback, `Connecting to Pi at ${base}...`, 'loading');

    let whisperOk = false;
    let ollamaOk = false;
    let errors = [];

    // Test Whisper
    try {
      const wRes = await fetch(`${base}:8000/health`, { method: 'GET' });
      if (wRes.ok) whisperOk = true;
      else errors.push(`Whisper returned HTTP ${wRes.status}`);
    } catch (e) {
      errors.push(`Whisper (:8000) unreachable`);
    }

    // Test Ollama
    try {
      const oRes = await fetch(`${base}:11434/api/tags`, { method: 'GET' });
      if (oRes.ok) ollamaOk = true;
      else errors.push(`Ollama returned HTTP ${oRes.status}`);
    } catch (e) {
      errors.push(`Ollama (:11434) unreachable`);
    }

    if (whisperOk && ollamaOk) {
      showFeedback(piFeedback, `✅ Reachable! Whisper (:8000) & Ollama (:11434) are responding on ${base}.`, 'success');
    } else if (whisperOk || ollamaOk) {
      showFeedback(piFeedback, `⚠️ Partial connection: ${errors.join(', ')}`, 'loading');
    } else {
      showFeedback(piFeedback, `❌ Pi offline or unreachable: ${errors.join('; ')}. Ensure install.sh is running.`, 'error');
    }
    updateStatusBadges();
  });

  // Test & Create Notion Database
  createNotionDbBtn.addEventListener('click', async () => {
    const token = notionTokenInput.value.trim();
    let parentId = notionParentPageIdInput.value.trim();

    if (!token) {
      showFeedback(notionFeedback, 'Please enter your Notion Integration Token.', 'error');
      return;
    }

    // Strip full URL to ID if pasted as URL
    if (parentId.includes('notion.so/')) {
      const match = parentId.match(/([a-f0-9]{32})/i) || parentId.match(/([a-f0-9-]{36})/i);
      if (match) parentId = match[1];
    }
    parentId = parentId.replace(/-/g, '');

    if (!parentId) {
      showFeedback(notionFeedback, 'Please enter a valid Notion Parent Page ID.', 'error');
      return;
    }

    showFeedback(notionFeedback, 'Contacting Notion API to ensure database schema...', 'loading');

    try {
      const payload = {
        parent: { type: 'page_id', page_id: parentId },
        title: [{ type: 'text', text: { content: 'ZoomNotes — Meeting Notes' } }],
        properties: {
          'Meeting Title': { title: {} },
          Date: { date: {} },
          Status: {
            select: {
              options: [
                { name: '🔴 Recording', color: 'red' },
                { name: '⚙️ Processing', color: 'yellow' },
                { name: '✅ Completed', color: 'green' },
              ],
            },
          },
          Source: {
            select: {
              options: [{ name: 'ZoomNotes Extension', color: 'blue' }],
            },
          },
          Duration: { rich_text: {} },
          'Action Items': { number: { format: 'number' } },
          'AI Backend': {
            select: {
              options: [
                { name: 'Gemini 2.5 Flash', color: 'purple' },
                { name: 'Raspberry Pi Local', color: 'orange' },
              ],
            },
          },
          'Decisions Count': { number: { format: 'number' } },
        },
      };

      const res = await fetch('https://api.notion.com/v1/databases', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Notion-Version': '2022-06-28',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        throw new Error(errJson.message || `HTTP ${res.status}`);
      }

      const db = await res.json();
      notionDatabaseIdInput.value = db.id;

      // Auto save database ID
      chrome.storage.sync.set({
        notionToken: token,
        notionParentPageId: parentId,
        notionDatabaseId: db.id,
      });

      showFeedback(
        notionFeedback,
        `✅ Success! Database created with ID: ${db.id}. Ready for live notes!`,
        'success'
      );
      updateStatusBadges();
    } catch (err) {
      showFeedback(
        notionFeedback,
        `❌ Notion Error: ${err.message}. (Did you invite your Integration to the page?)`,
        'error'
      );
    }
  });

  // Save All Settings
  saveSettingsBtn.addEventListener('click', () => {
    let activeMode = 'gemini';
    if (radioCloud.checked) activeMode = 'cloud';
    else if (radioPi.checked) activeMode = 'pi';

    const settings = {
      backendMode: activeMode,
      preferLocal: activeMode === 'pi',
      geminiApiKey: geminiApiKeyInput.value.trim(),
      cloudBackendUrl: cloudBackendUrlInput.value.trim().replace(/\/+$/, ''),
      nvidiaApiKey: nvidiaApiKeyInput.value.trim(),
      piBaseUrl: (piBaseUrlInput.value.trim() || 'http://rpi.local').replace(/\/+$/, ''),
      notionToken: notionTokenInput.value.trim(),
      notionParentPageId: notionParentPageIdInput.value.trim(),
      notionDatabaseId: notionDatabaseIdInput.value.trim(),
    };

    chrome.storage.sync.set(settings, () => {
      saveStatus.textContent = 'Settings saved successfully! ✅';
      saveStatus.classList.add('saved');
      updateStatusBadges();
      setTimeout(() => {
        saveStatus.textContent = 'All changes saved locally';
        saveStatus.classList.remove('saved');
      }, 3500);
    });
  });

  // Helpers
  function showFeedback(element, msg, type) {
    element.textContent = msg;
    element.className = `test-feedback ${type}`;
  }

  function updateStatusBadges() {
    if (radioCloud.checked) {
      if (cloudBackendUrlInput.value.trim()) {
        aiStatusBadge.textContent = '🚀 NVIDIA NIM';
        aiStatusBadge.className = 'badge active';
      } else {
        aiStatusBadge.textContent = 'Needs URL';
        aiStatusBadge.className = 'badge warn';
      }
    } else if (radioPi.checked) {
      aiStatusBadge.textContent = '🍓 Local Pi';
      aiStatusBadge.className = 'badge active';
    } else if (geminiApiKeyInput.value.trim()) {
      aiStatusBadge.textContent = '☁️ Gemini Ready';
      aiStatusBadge.className = 'badge active';
    } else {
      aiStatusBadge.textContent = 'Key Missing';
      aiStatusBadge.className = 'badge warn';
    }

    if (notionTokenInput.value.trim() && notionDatabaseIdInput.value.trim()) {
      notionStatusBadge.textContent = 'Synced';
      notionStatusBadge.className = 'badge active';
    } else if (notionTokenInput.value.trim()) {
      notionStatusBadge.textContent = 'Needs DB';
      notionStatusBadge.className = 'badge warn';
    } else {
      notionStatusBadge.textContent = 'Optional';
      notionStatusBadge.className = 'badge';
    }
  }
});
