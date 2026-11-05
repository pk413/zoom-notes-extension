// notion-client.js — ZoomNotes Notion Integration (ES Module)
'use strict';

const NOTION_API = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';

// ─── Headers ──────────────────────────────────────────────────────────────────
const NOTION_HEADERS = (token) => ({
  Authorization: 'Bearer ' + token,
  'Notion-Version': NOTION_VERSION,
  'Content-Type': 'application/json',
});

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Ensure the ZoomNotes Notion database exists. Creates it if needed.
 * Saves the database ID to chrome.storage.sync for future sessions.
 *
 * @param {Object} settings - Extension settings
 * @returns {Promise<string>} - Notion database ID
 */
export async function ensureNotionDatabase(settings) {
  if (settings.notionDatabaseId) {
    return settings.notionDatabaseId;
  }

  const { notionToken, notionParentPageId } = settings;
  if (!notionToken) throw new Error('Notion token is required');
  if (!notionParentPageId) throw new Error('Notion parent page ID is required');

  const payload = {
    parent: { type: 'page_id', page_id: notionParentPageId },
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

  const resp = await fetch(`${NOTION_API}/databases`, {
    method: 'POST',
    headers: NOTION_HEADERS(notionToken),
    body: JSON.stringify(payload),
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => resp.statusText);
    throw new Error(`Notion createDatabase error ${resp.status}: ${errText}`);
  }

  const db = await resp.json();
  const databaseId = db.id;

  // Persist database ID so we don't recreate it
  await new Promise((resolve) => {
    chrome.storage.sync.set({ notionDatabaseId: databaseId }, resolve);
  });

  return databaseId;
}

/**
 * Save meeting notes to Notion. Appends to existing page for interim notes,
 * creates a new page for the first save or final notes.
 *
 * @param {Object} session        - Session object from sessions Map
 * @param {string} notesMarkdown  - Markdown-formatted meeting notes
 * @param {'interim'|'final'} type
 * @param {Object} settings       - Extension settings
 * @returns {Promise<string|null>} - Notion page URL
 */
export async function saveToNotion(session, notesMarkdown, type, settings) {
  const { notionToken, notionDatabaseId } = settings;
  if (!notionToken) throw new Error('Notion token is required');
  if (!notionDatabaseId) throw new Error('Notion database ID is required');

  const parsed = parseNotes(notesMarkdown);
  const durationMs = Date.now() - session.startTime;
  const aiBackend = resolveAiBackend(settings);

  // ── Append to existing page (interim update) ──────────────────────────────
  if (session.notionPageId && type === 'interim') {
    const dividerAndUpdate = [
      { object: 'block', type: 'divider', divider: {} },
      {
        object: 'block',
        type: 'heading_3',
        heading_3: {
          rich_text: [
            {
              type: 'text',
              text: {
                content: `⏱ Interim Update — ${new Date().toLocaleTimeString()}`,
              },
            },
          ],
        },
      },
      ...buildNotionBlocks(parsed, session.screenshots, type),
    ];

    const appendResp = await fetch(
      `${NOTION_API}/blocks/${session.notionPageId}/children`,
      {
        method: 'PATCH',
        headers: NOTION_HEADERS(notionToken),
        body: JSON.stringify({ children: dividerAndUpdate.slice(0, 100) }),
      }
    );

    if (!appendResp.ok) {
      const errText = await appendResp.text().catch(() => appendResp.statusText);
      throw new Error(`Notion appendBlocks error ${appendResp.status}: ${errText}`);
    }

    return session.notionPageUrl || null;
  }

  // ── Create new page ───────────────────────────────────────────────────────
  const status = type === 'final' ? '✅ Completed' : '⚙️ Processing';
  const children = buildNotionBlocks(parsed, session.screenshots, type).slice(0, 100);

  const pagePayload = {
    parent: { database_id: notionDatabaseId },
    properties: {
      'Meeting Title': {
        title: [{ type: 'text', text: { content: session.tabTitle || 'Zoom Meeting' } }],
      },
      Date: {
        date: { start: new Date(session.startTime).toISOString() },
      },
      Status: {
        select: { name: status },
      },
      Source: {
        select: { name: 'ZoomNotes Extension' },
      },
      Duration: {
        rich_text: [{ type: 'text', text: { content: formatDuration(durationMs) } }],
      },
      'Action Items': {
        number: parsed.actionItems.length,
      },
      'AI Backend': {
        select: { name: aiBackend },
      },
      'Decisions Count': {
        number: parsed.decisions.filter(
          (d) => d && d.toLowerCase() !== 'none identified'
        ).length,
      },
    },
    children,
  };

  const pageResp = await fetch(`${NOTION_API}/pages`, {
    method: 'POST',
    headers: NOTION_HEADERS(notionToken),
    body: JSON.stringify(pagePayload),
  });

  if (!pageResp.ok) {
    const errText = await pageResp.text().catch(() => pageResp.statusText);
    throw new Error(`Notion createPage error ${pageResp.status}: ${errText}`);
  }

  const page = await pageResp.json();
  session.notionPageId = page.id;
  session.notionPageUrl = page.url || null;

  return page.url || null;
}

// ─── Notes Parser ─────────────────────────────────────────────────────────────

/**
 * Parse structured markdown notes into typed sections.
 *
 * @param {string} markdown
 * @returns {{ keyPoints: string[], decisions: string[], actionItems: string[], quotes: string[], transcription: string }}
 */
function parseNotes(markdown) {
  if (!markdown || typeof markdown !== 'string') {
    return { keyPoints: [], decisions: [], actionItems: [], quotes: [], transcription: '' };
  }

  const sections = {
    keyPoints: extractSection(markdown, 'Key Discussion Points'),
    decisions: extractSection(markdown, 'Decisions Made'),
    actionItems: extractSection(markdown, 'Action Items'),
    quotes: extractSection(markdown, 'Important Quotes'),
    transcription: extractSection(markdown, 'Transcription').join('\n').trim(),
  };

  // Parse bullet points into arrays
  sections.keyPoints = parseBullets(sections.keyPoints.join('\n'));
  sections.decisions = parseBullets(sections.decisions.join('\n'));
  sections.actionItems = parseActionItems(sections.actionItems.join('\n'));
  sections.quotes = parseQuotes(sections.quotes.join('\n'));

  return sections;
}

function extractSection(markdown, heading) {
  // Match ## Heading\n...content... until the next ## heading or end of string
  const escapedHeading = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(
    `##\\s+${escapedHeading}[^\n]*\\n([\\s\\S]*?)(?=\\n##\\s|$)`,
    'i'
  );
  const match = markdown.match(regex);
  if (!match) return [];
  return match[1].split('\n').map((l) => l.trim()).filter(Boolean);
}

function parseBullets(text) {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('- ') || l.startsWith('* '))
    .map((l) => l.replace(/^[-*]\s+/, '').trim())
    .filter(Boolean);
}

function parseActionItems(text) {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('- ') || l.startsWith('* '))
    .map((l) =>
      l
        .replace(/^[-*]\s+/, '')
        .replace(/^\[[ x]\]\s*/i, '')
        .trim()
    )
    .filter(Boolean);
}

function parseQuotes(text) {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('> '))
    .map((l) => l.replace(/^>\s+/, '').trim())
    .filter(Boolean);
}

// ─── Notion Block Builder ─────────────────────────────────────────────────────

/**
 * Build an array of Notion block objects from parsed notes.
 * Note: Notion API limit is 100 blocks per request.
 */
function buildNotionBlocks(parsed, screenshots, type) {
  const blocks = [];

  // Screenshot callout
  if (screenshots && screenshots.length > 0) {
    blocks.push({
      object: 'block',
      type: 'callout',
      callout: {
        rich_text: [
          {
            type: 'text',
            text: { content: `📸 ${screenshots.length} screenshot(s) captured` },
          },
        ],
        icon: { emoji: '📸' },
        color: 'blue_background',
      },
    });
  }

  blocks.push({ object: 'block', type: 'divider', divider: {} });

  // Key Discussion Points
  if (parsed.keyPoints.length > 0) {
    blocks.push(heading2Block('💡 Key Discussion Points'));
    for (const point of parsed.keyPoints.slice(0, 20)) {
      blocks.push(bulletBlock(point));
    }
  }

  // Decisions Made
  blocks.push(heading2Block('✅ Decisions Made'));
  if (parsed.decisions.length > 0) {
    for (const decision of parsed.decisions.slice(0, 15)) {
      blocks.push(bulletBlock(decision));
    }
  } else {
    blocks.push(bulletBlock('None identified'));
  }

  // Action Items
  blocks.push(heading2Block('🎯 Action Items'));
  if (parsed.actionItems.length > 0) {
    for (const item of parsed.actionItems.slice(0, 15)) {
      blocks.push(todoBlock(item));
    }
  } else {
    blocks.push(bulletBlock('None identified'));
  }

  // Important Quotes
  if (parsed.quotes.length > 0) {
    blocks.push(heading2Block('💬 Important Quotes'));
    for (const quote of parsed.quotes.slice(0, 10)) {
      blocks.push(quoteBlock(quote));
    }
  }

  // Full Transcription (collapsed toggle)
  const transcriptionText = parsed.transcription
    ? parsed.transcription.slice(0, 2000)
    : 'No transcription available.';

  blocks.push({
    object: 'block',
    type: 'toggle',
    toggle: {
      rich_text: [
        { type: 'text', text: { content: '📝 Full Transcription' } },
      ],
      children: [
        {
          object: 'block',
          type: 'paragraph',
          paragraph: {
            rich_text: [
              { type: 'text', text: { content: transcriptionText } },
            ],
          },
        },
      ],
    },
  });

  return blocks;
}

// ─── Block Factories ──────────────────────────────────────────────────────────

function heading2Block(text) {
  return {
    object: 'block',
    type: 'heading_2',
    heading_2: {
      rich_text: [{ type: 'text', text: { content: text } }],
    },
  };
}

function bulletBlock(text) {
  return {
    object: 'block',
    type: 'bulleted_list_item',
    bulleted_list_item: {
      rich_text: [{ type: 'text', text: { content: truncate(text, 2000) } }],
    },
  };
}

function todoBlock(text) {
  return {
    object: 'block',
    type: 'to_do',
    to_do: {
      rich_text: [{ type: 'text', text: { content: truncate(text, 2000) } }],
      checked: false,
    },
  };
}

function quoteBlock(text) {
  return {
    object: 'block',
    type: 'quote',
    quote: {
      rich_text: [{ type: 'text', text: { content: truncate(text, 2000) } }],
    },
  };
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function truncate(str, maxLen) {
  if (!str) return '';
  return str.length > maxLen ? str.slice(0, maxLen - 1) + '…' : str;
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

function resolveAiBackend(settings) {
  if (settings.preferLocal && settings.piBaseUrl) return 'Raspberry Pi Local';
  if (settings.geminiApiKey) return 'Gemini 2.5 Flash';
  if (settings.piBaseUrl) return 'Raspberry Pi Local';
  return 'Gemini 2.5 Flash';
}
