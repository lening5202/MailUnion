import { hydrateMailboxPreset, menuItems, normalizeSystemThemePresetId, render, renderAutoIcon } from './ui.js?v=20260504-loader-stage-v1';

const root = document.querySelector('#app');
const SIDEBAR_STORAGE_KEY = 'mail-union-sidebar-collapsed';
const THEME_STORAGE_KEY = 'mail-union-theme';
const REVEALABLE_NOTIFICATION_CHANNELS = ['telegram', 'wecom', 'feishu'];
const NOTIFICATION_CONFIG_FIELDS = {
  telegram: ['botToken', 'chatId'],
  wecom: ['botId', 'botSecret', 'targetId', 'corpId', 'agentId', 'receiverId', 'appBaseUrl', 'callbackToken', 'encodingAesKey', 'appSecret'],
  feishu: ['webhookUrl', 'signSecret'],
};
const SEARCHABLE_DROPDOWN_ACTIONS = new Set([
  'inbox-mailbox-search',
  'inbox-owner-search',
  'mailbox-owner-search',
  'mailbox-toolbar-owner-search',
  'mailbox-search',
]);
const MANAGED_SEARCH_INPUT_ACTIONS = new Set([...SEARCHABLE_DROPDOWN_ACTIONS, 'search']);
const ACTION_BUTTON_SELECTOR = [
  'button.button',
  'button.tiny-button',
  'button.password-toggle-button',
  'button.inbox-folder-pill',
  'button.mailbox-guide-chip',
].join(', ');
const PAGE_SIZE_OPTIONS = [10, 20, 50, 100, 500];
const NOTIFICATION_COVER_CATEGORIES = ['verification', 'order', 'subscription', 'marketing', 'junk', 'standard'];
const NOTIFICATION_COVER_UPLOAD_MAX_BYTES = 2 * 1024 * 1024;
const BACKUP_RESTORE_MODE_LABELS = Object.freeze({
  full_site_data: '全部网站数据',
  database_only: '仅导入数据库',
  attachments_only: '仅导入网站附件',
});
const BACKUP_RESTORE_COMPONENT_LABELS = Object.freeze({
  database: '数据库',
  envFile: '.env 配置文件',
  runtimeFiles: '本地附件目录',
  logs: '系统日志目录',
});
const MAILBOX_VISIBLE_FIELDS_STORAGE_KEY = 'mail-union-mailbox-visible-fields';
const MAILBOX_VISIBLE_FIELD_IDS = [
  'email',
  'sortOrder',
  'status',
  'username',
  'imapHost',
  'owner',
  'syncInterval',
];
const MAILBOX_DRAG_HOLD_MS = 280;
let attachmentHoverPreviewNode = null;
let activeAttachmentHoverTrigger = null;
let mailboxDragState = null;
let mailboxDragHoldState = null;
let suppressMailboxOpenUntil = 0;
let globalNoticeDismissTimer = null;

function escapeHtmlText(value = '') {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function escapeHtmlAttr(value = '') {
  return escapeHtmlText(value);
}

const MESSAGE_HTML_BLOCKED_SELECTORS = [
  'script',
  'iframe',
  'frame',
  'frameset',
  'object',
  'embed',
  'applet',
  'form',
  'input',
  'button',
  'select',
  'textarea',
  'option',
  'base',
  'meta[http-equiv="refresh"]',
  'link[rel="stylesheet"]',
  'link[rel="preload"]',
  'link[rel="modulepreload"]',
  'link[rel="prefetch"]',
  'link[rel="prerender"]',
].join(', ');

function hashText(value = '') {
  const source = String(value || '');
  let hash = 0;

  for (let index = 0; index < source.length; index += 1) {
    hash = ((hash << 5) - hash) + source.charCodeAt(index);
    hash |= 0;
  }

  return String(hash);
}

function isSafeMessageHtmlUrl(value = '', options = {}) {
  const normalized = String(value || '')
    .trim()
    .replace(/[\u0000-\u001F\u007F\s]+/g, '');
  if (!normalized) {
    return false;
  }

  const lower = normalized.toLowerCase();
  if (
    lower.startsWith('javascript:')
    || lower.startsWith('vbscript:')
    || lower.startsWith('file:')
    || lower.startsWith('data:text/html')
  ) {
    return false;
  }

  if (lower.startsWith('data:')) {
    return Boolean(options.allowDataImage) && lower.startsWith('data:image/');
  }

  if (lower.startsWith('cid:')) {
    return Boolean(options.allowCidImage);
  }

  return true;
}

function buildMessageHtmlDocument(source = '') {
  const htmlSource = String(source || '').trim();
  if (!htmlSource || !window.DOMParser) {
    return '';
  }

  const parser = new window.DOMParser();
  const documentNode = parser.parseFromString(htmlSource, 'text/html');
  const headNode = documentNode.head || documentNode.createElement('head');
  const bodyNode = documentNode.body || documentNode.createElement('body');

  documentNode.querySelectorAll(MESSAGE_HTML_BLOCKED_SELECTORS).forEach((node) => node.remove());

  documentNode.querySelectorAll('style').forEach((styleNode) => {
    styleNode.textContent = String(styleNode.textContent || '').replace(/@import[\s\S]*?;/gi, '');
  });

  documentNode.querySelectorAll('*').forEach((element) => {
    Array.from(element.attributes).forEach((attribute) => {
      const name = String(attribute.name || '').toLowerCase();
      const value = String(attribute.value || '');

      if (name.startsWith('on')) {
        element.removeAttribute(attribute.name);
        return;
      }

      if (['src', 'href', 'xlink:href', 'action', 'formaction'].includes(name)) {
        const safe = isSafeMessageHtmlUrl(value, {
          allowDataImage: element.tagName === 'IMG',
          allowCidImage: element.tagName === 'IMG',
        });
        if (!safe) {
          element.removeAttribute(attribute.name);
        }
      }
    });

    if (element.tagName === 'A') {
      element.setAttribute('target', '_blank');
      element.setAttribute('rel', 'noreferrer noopener');
    }

    if (element.tagName === 'IMG') {
      element.setAttribute('loading', 'lazy');
      element.setAttribute('referrerpolicy', 'no-referrer');
    }
  });

  const metaCharset = documentNode.createElement('meta');
  metaCharset.setAttribute('charset', 'utf-8');
  headNode.prepend(metaCharset);

  const metaReferrer = documentNode.createElement('meta');
  metaReferrer.setAttribute('name', 'referrer');
  metaReferrer.setAttribute('content', 'no-referrer');
  headNode.prepend(metaReferrer);

  const supportStyle = documentNode.createElement('style');
  supportStyle.textContent = `
    html, body {
      margin: 0;
      padding: 0;
      background: transparent;
    }

    body {
      color: #0f172a;
      overflow-wrap: anywhere;
      word-break: break-word;
    }

    img, table {
      max-width: 100% !important;
    }

    img {
      height: auto !important;
    }

    table {
      width: auto;
      border-collapse: collapse;
    }

    pre {
      white-space: pre-wrap;
      word-break: break-word;
    }
  `;
  headNode.appendChild(supportStyle);

  if (!documentNode.head) {
    documentNode.documentElement.insertBefore(headNode, bodyNode);
  }

  bodyNode.classList.add('mail-union-email-html-body');
  return `<!doctype html>\n${documentNode.documentElement.outerHTML}`;
}

function resizeMessageHtmlFrame(frame) {
  const documentNode = frame?.contentDocument;
  if (!documentNode?.body || !documentNode?.documentElement) {
    return;
  }

  const nextHeight = Math.max(
    documentNode.body.scrollHeight,
    documentNode.body.offsetHeight,
    documentNode.documentElement.scrollHeight,
    documentNode.documentElement.offsetHeight,
    320,
  );

  frame.style.height = `${Math.ceil(nextHeight)}px`;
}

function bindMessageHtmlFrameObservers(frame) {
  if (!frame?.contentDocument?.body || !frame.contentDocument.documentElement) {
    return;
  }

  if (frame.__mailUnionHtmlResizeObserver) {
    frame.__mailUnionHtmlResizeObserver.disconnect();
    frame.__mailUnionHtmlResizeObserver = null;
  }

  if (Array.isArray(frame.__mailUnionHtmlImageHandlers)) {
    frame.__mailUnionHtmlImageHandlers.forEach(({ imageNode, handler }) => {
      imageNode.removeEventListener('load', handler);
      imageNode.removeEventListener('error', handler);
    });
  }
  frame.__mailUnionHtmlImageHandlers = [];

  const resize = () => resizeMessageHtmlFrame(frame);

  if (window.ResizeObserver) {
    const observer = new window.ResizeObserver(() => {
      resize();
    });
    observer.observe(frame.contentDocument.body);
    observer.observe(frame.contentDocument.documentElement);
    frame.__mailUnionHtmlResizeObserver = observer;
  }

  frame.contentDocument.querySelectorAll('img').forEach((imageNode) => {
    const handler = () => resize();
    imageNode.addEventListener('load', handler);
    imageNode.addEventListener('error', handler);
    frame.__mailUnionHtmlImageHandlers.push({ imageNode, handler });
  });

  resize();
  window.setTimeout(resize, 60);
  window.setTimeout(resize, 240);
  window.setTimeout(resize, 1000);
}

function hydrateMessageHtmlFrames() {
  const frameNodes = document.querySelectorAll('[data-message-html-frame="true"]');
  if (!frameNodes.length) {
    return;
  }

  const htmlBody = String(state.selectedMessage?.htmlBody || '').trim();
  const preparedHtml = buildMessageHtmlDocument(htmlBody);
  const preparedHash = hashText(preparedHtml);

  frameNodes.forEach((frame) => {
    if (!preparedHtml) {
      frame.removeAttribute('srcdoc');
      frame.style.height = '0px';
      return;
    }

    if (!frame.dataset.messageHtmlBound) {
      frame.addEventListener('load', () => {
        bindMessageHtmlFrameObservers(frame);
      });
      frame.dataset.messageHtmlBound = 'true';
    }

    if (frame.dataset.messageHtmlHash !== preparedHash) {
      frame.dataset.messageHtmlHash = preparedHash;
      frame.srcdoc = preparedHtml;
      return;
    }

    bindMessageHtmlFrameObservers(frame);
  });
}

function formatAttachmentBytes(value = 0) {
  const size = Number(value || 0);
  if (!Number.isFinite(size) || size <= 0) {
    return '0 B';
  }

  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let resolved = size;
  let index = 0;
  while (resolved >= 1024 && index < units.length - 1) {
    resolved /= 1024;
    index += 1;
  }

  return `${resolved >= 10 || index === 0 ? resolved.toFixed(0) : resolved.toFixed(1)} ${units[index]}`;
}

function normalizePageSize(value, fallback = 10) {
  const numeric = Number(value);
  if (PAGE_SIZE_OPTIONS.includes(numeric)) {
    return numeric;
  }
  return PAGE_SIZE_OPTIONS.includes(Number(fallback)) ? Number(fallback) : 10;
}

function normalizePageNumber(value, fallback = 1) {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric >= 1) {
    return Math.floor(numeric);
  }
  return Math.max(Number(fallback) || 1, 1);
}

function tokenizeSimpleQuery(value = '') {
  return String(value || '')
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function mailboxMatchesCurrentFilters(mailbox) {
  const providerMatched =
    !state.mailboxProviderFilter
    || state.mailboxProviderFilter === 'all'
    || mailbox.provider === state.mailboxProviderFilter;
  if (!providerMatched) {
    return false;
  }

  const searchTokens = tokenizeSimpleQuery(state.mailboxSearch);
  if (!searchTokens.length) {
    return true;
  }

  const haystack = [
    mailbox.name,
    mailbox.email,
    mailbox.username,
    mailbox.ownerName,
    mailbox.ownerEmail,
    mailbox.provider,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  return searchTokens.every((token) => haystack.includes(token));
}

function readMailboxVisibleFields() {
  try {
    const raw = window.localStorage.getItem(MAILBOX_VISIBLE_FIELDS_STORAGE_KEY);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.map((item) => String(item || '').trim()).filter((item) => MAILBOX_VISIBLE_FIELD_IDS.includes(item))
      : [];
  } catch (_) {
    return [];
  }
}

function persistMailboxVisibleFields() {
  try {
    window.localStorage.setItem(
      MAILBOX_VISIBLE_FIELDS_STORAGE_KEY,
      JSON.stringify((state.mailboxVisibleFields || []).filter((item) => MAILBOX_VISIBLE_FIELD_IDS.includes(item))),
    );
  } catch (_) {
    // Ignore storage failures.
  }
}

function visibleMailboxPageIds() {
  const pageSize = normalizePageSize(state.mailboxPageSize, 10);
  const filtered = state.mailboxes.filter(mailboxMatchesCurrentFilters);
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const page = Math.min(normalizePageNumber(state.mailboxPage, 1), totalPages);
  const startIndex = (page - 1) * pageSize;
  return filtered.slice(startIndex, startIndex + pageSize).map((mailbox) => mailbox.id);
}

function attachmentMetadataSelectionId(item = {}) {
  const messageId = String(item?.messageId || '').trim();
  const attachmentIndex = Number(item?.attachmentIndex);
  if (!messageId || !Number.isInteger(attachmentIndex) || attachmentIndex < 0) {
    return '';
  }

  return `${messageId}::${attachmentIndex}`;
}

function visibleAttachmentMetadataSelectionIds() {
  return (Array.isArray(state.attachmentMetadata) ? state.attachmentMetadata : [])
    .map((item) => attachmentMetadataSelectionId(item))
    .filter(Boolean);
}

function setMailboxVisibleField(fieldId, checked) {
  const normalizedFieldId = String(fieldId || '').trim();
  if (!MAILBOX_VISIBLE_FIELD_IDS.includes(normalizedFieldId)) {
    return;
  }

  const next = new Set(state.mailboxVisibleFields || []);
  if (checked) {
    next.add(normalizedFieldId);
  } else {
    next.delete(normalizedFieldId);
  }
  state.mailboxVisibleFields = Array.from(next);
  persistMailboxVisibleFields();
}

function clearMailboxDragIndicators() {
  document.querySelectorAll('.mailbox-row-card.is-drop-before, .mailbox-row-card.is-drop-after, .mailbox-row-card.is-drag-origin')
    .forEach((element) => {
      element.classList.remove('is-drop-before', 'is-drop-after', 'is-drag-origin');
    });
}

function cancelMailboxDragHold() {
  if (!mailboxDragHoldState?.timer) {
    mailboxDragHoldState = null;
    return;
  }
  window.clearTimeout(mailboxDragHoldState.timer);
  mailboxDragHoldState = null;
}

function finishMailboxDragCleanup() {
  cancelMailboxDragHold();
  clearMailboxDragIndicators();
  if (mailboxDragState?.ghost?.isConnected) {
    mailboxDragState.ghost.remove();
  }
  mailboxDragState = null;
  document.body.classList.remove('mailbox-dragging');
}

async function reorderMailboxCards(dragMailboxId, targetMailboxId, insertAfter) {
  const orderedIds = state.mailboxes.map((mailbox) => mailbox.id);
  const dragIndex = orderedIds.indexOf(dragMailboxId);
  const targetIndex = orderedIds.indexOf(targetMailboxId);
  if (dragIndex < 0 || targetIndex < 0 || dragMailboxId === targetMailboxId) {
    return;
  }

  orderedIds.splice(dragIndex, 1);
  const nextTargetIndex = orderedIds.indexOf(targetMailboxId);
  const insertIndex = insertAfter ? nextTargetIndex + 1 : nextTargetIndex;
  orderedIds.splice(insertIndex, 0, dragMailboxId);

  const mailboxMap = new Map(state.mailboxes.map((mailbox) => [mailbox.id, mailbox]));
  state.mailboxes = orderedIds.map((mailboxId) => mailboxMap.get(mailboxId)).filter(Boolean);
  redraw();

  try {
    const updates = orderedIds.map((mailboxId, index) =>
      updateMailboxDisplay(mailboxId, {
        sortOrder: (index + 1) * 10,
      }),
    );
    const results = await Promise.all(updates);
    if (Array.isArray(results) && results.length) {
      const updatedMap = new Map(results.filter(Boolean).map((item) => [item.mailbox?.id || item.id, item.mailbox || item]));
      state.mailboxes = orderedIds.map((mailboxId) => updatedMap.get(mailboxId) || mailboxMap.get(mailboxId)).filter(Boolean);
    }
    state.notice = {
      text: '邮箱顺序已更新。',
      tone: 'success',
    };
  } catch (error) {
    await loadMailboxes();
    state.notice = {
      text: error.message || '邮箱顺序更新失败。',
      tone: 'error',
    };
  }
  redraw();
}

function beginMailboxDrag(trigger, event) {
  const card = trigger?.closest?.('.mailbox-row-card[data-mailbox-id]');
  const mailboxId = card?.dataset?.mailboxId || '';
  if (!card || !mailboxId) {
    return;
  }

  const rect = card.getBoundingClientRect();
  const ghost = card.cloneNode(true);
  ghost.classList.add('mailbox-row-drag-ghost');
  ghost.style.width = `${Math.round(rect.width)}px`;
  ghost.style.height = `${Math.round(rect.height)}px`;
  ghost.style.left = `${Math.round(rect.left)}px`;
  ghost.style.top = `${Math.round(rect.top)}px`;
  document.body.appendChild(ghost);

  card.classList.add('is-drag-origin');
  document.body.classList.add('mailbox-dragging');
  mailboxDragState = {
    mailboxId,
    pointerId: event.pointerId,
    card,
    ghost,
    offsetX: event.clientX - rect.left,
    offsetY: event.clientY - rect.top,
    hoverMailboxId: '',
    insertAfter: false,
  };
}

function updateMailboxDrag(event) {
  if (!mailboxDragState) {
    return;
  }

  event.preventDefault();
  const { ghost, offsetX, offsetY, mailboxId } = mailboxDragState;
  ghost.style.left = `${Math.round(event.clientX - offsetX)}px`;
  ghost.style.top = `${Math.round(event.clientY - offsetY)}px`;

  clearMailboxDragIndicators();
  mailboxDragState.card?.classList.add('is-drag-origin');

  const target = document.elementFromPoint(event.clientX, event.clientY)?.closest?.('.mailbox-row-card[data-mailbox-id]');
  const targetMailboxId = target?.dataset?.mailboxId || '';
  if (!target || !targetMailboxId || targetMailboxId === mailboxId) {
    mailboxDragState.hoverMailboxId = '';
    return;
  }

  const rect = target.getBoundingClientRect();
  const insertAfter = event.clientY > rect.top + rect.height / 2;
  mailboxDragState.hoverMailboxId = targetMailboxId;
  mailboxDragState.insertAfter = insertAfter;
  target.classList.add(insertAfter ? 'is-drop-after' : 'is-drop-before');
}

async function completeMailboxDrag() {
  if (!mailboxDragState) {
    finishMailboxDragCleanup();
    return;
  }

  const dragMailboxId = mailboxDragState.mailboxId;
  const targetMailboxId = mailboxDragState.hoverMailboxId;
  const insertAfter = Boolean(mailboxDragState.insertAfter);
  suppressMailboxOpenUntil = Date.now() + 400;
  finishMailboxDragCleanup();

  if (!targetMailboxId || targetMailboxId === dragMailboxId) {
    return;
  }

  await reorderMailboxCards(dragMailboxId, targetMailboxId, insertAfter);
}

function ensureAttachmentHoverPreviewNode() {
  if (attachmentHoverPreviewNode?.isConnected) {
    return attachmentHoverPreviewNode;
  }

  attachmentHoverPreviewNode = document.createElement('div');
  attachmentHoverPreviewNode.className = 'attachment-hover-preview';
  document.body.appendChild(attachmentHoverPreviewNode);
  return attachmentHoverPreviewNode;
}

function attachmentPreviewPayloadFromElement(element) {
  const source = element?.closest?.('[data-attachment-preview-open]');
  if (!source) {
    return null;
  }

  const dataset = source.dataset || {};
  return {
    previewKind: String(dataset.previewKind || 'file').trim() || 'file',
    previewKindLabel: String(dataset.previewKindLabel || '').trim(),
    previewUrl: String(dataset.previewUrl || '').trim(),
    downloadUrl: String(dataset.downloadUrl || '').trim(),
    filename: String(dataset.previewFilename || '附件').trim() || '附件',
    contentType: String(dataset.previewContentType || '').trim(),
    size: Number(dataset.previewSize || 0),
    subtitle: String(dataset.previewSubtitle || '').trim(),
    mailboxLabel: String(dataset.previewMailbox || '').trim(),
    ownerLabel: String(dataset.previewOwner || '').trim(),
    receivedAt: String(dataset.previewReceivedAt || '').trim(),
    storagePath: String(dataset.previewStoragePath || '').trim(),
    statusText: String(dataset.previewStatus || '').trim(),
    note: String(dataset.previewNote || '').trim(),
  };
}

function renderAttachmentHoverPreviewMarkup(payload = {}) {
  const previewKind = String(payload.previewKind || 'file').trim() || 'file';
  const previewKindLabel = String(payload.previewKindLabel || '').trim() || '附件';
  const previewUrl = String(payload.previewUrl || '').trim();
  const filename = String(payload.filename || '附件').trim() || '附件';
  const subtitle = String(payload.subtitle || '').trim();
  const contentType = String(payload.contentType || '').trim() || '未知类型';
  const size = Number(payload.size || 0);
  const statusText = String(payload.statusText || '').trim();

  let surface = `
    <div class="attachment-hover-preview-empty">
      <strong>${escapeHtmlText(previewKindLabel)}</strong>
      <p>当前附件不适合悬停内嵌预览，可以双击卡片或点击查看按钮打开阅读卡片。</p>
    </div>
  `;

  if (previewUrl && previewKind === 'image') {
    surface = `<div class="attachment-hover-preview-surface is-image"><img src="${escapeHtmlAttr(previewUrl)}" alt="${escapeHtmlAttr(filename)}" loading="eager" /></div>`;
  } else if (previewUrl && previewKind === 'pdf') {
    surface = `<div class="attachment-hover-preview-surface is-pdf"><iframe src="${escapeHtmlAttr(`${previewUrl}#toolbar=0&navpanes=0&scrollbar=0`)}" title="${escapeHtmlAttr(filename)}"></iframe></div>`;
  }

  return `
    <div class="attachment-hover-preview-head">
      <strong>${escapeHtmlText(filename)}</strong>
      <p>${escapeHtmlText(subtitle || '悬停时预览当前附件，双击卡片会弹出完整查看窗口。')}</p>
      <div class="attachment-hover-preview-meta">
        <span>${escapeHtmlText(previewKindLabel)}</span>
        <span>${escapeHtmlText(contentType)}</span>
        <span>${escapeHtmlText(formatAttachmentBytes(size))}</span>
        ${statusText ? `<span>${escapeHtmlText(statusText)}</span>` : ''}
      </div>
    </div>
    ${surface}
  `;
}

function positionAttachmentHoverPreview(event) {
  if (!attachmentHoverPreviewNode?.classList.contains('is-visible')) {
    return;
  }

  const offset = 20;
  const padding = 16;
  const rect = attachmentHoverPreviewNode.getBoundingClientRect();
  let left = (event.clientX || 0) + offset;
  let top = (event.clientY || 0) + offset;
  if (left + rect.width > window.innerWidth - padding) {
    left = Math.max(padding, (event.clientX || 0) - rect.width - offset);
  }
  if (top + rect.height > window.innerHeight - padding) {
    top = Math.max(padding, window.innerHeight - rect.height - padding);
  }
  attachmentHoverPreviewNode.style.transform = `translate3d(${Math.round(left)}px, ${Math.round(top)}px, 0)`;
}

function hideAttachmentHoverPreview(immediate = false) {
  activeAttachmentHoverTrigger = null;
  if (!attachmentHoverPreviewNode) {
    return;
  }

  attachmentHoverPreviewNode.classList.remove('is-visible');
  if (immediate) {
    attachmentHoverPreviewNode.style.transform = 'translate3d(-9999px, -9999px, 0)';
    attachmentHoverPreviewNode.innerHTML = '';
  } else {
    window.setTimeout(() => {
      if (!attachmentHoverPreviewNode?.classList.contains('is-visible')) {
        attachmentHoverPreviewNode.innerHTML = '';
        attachmentHoverPreviewNode.style.transform = 'translate3d(-9999px, -9999px, 0)';
      }
    }, 160);
  }
}

function showAttachmentHoverPreview(trigger, event) {
  const payload = attachmentPreviewPayloadFromElement(trigger);
  if (!payload) {
    return;
  }

  const shouldShowPreview = Boolean(payload.previewUrl) && ['image', 'pdf'].includes(payload.previewKind);
  if (!shouldShowPreview) {
    hideAttachmentHoverPreview(true);
    return;
  }

  const node = ensureAttachmentHoverPreviewNode();
  activeAttachmentHoverTrigger = trigger;
  node.innerHTML = renderAttachmentHoverPreviewMarkup(payload);
  node.classList.add('is-visible');
  positionAttachmentHoverPreview(event);
}

function openAttachmentPreviewModalFromElement(element) {
  const payload = attachmentPreviewPayloadFromElement(element);
  if (!payload) {
    return false;
  }

  state.attachmentPreviewModal = payload;
  hideAttachmentHoverPreview(true);
  return true;
}

function closeAttachmentPreviewModal() {
  state.attachmentPreviewModal = null;
  hideAttachmentHoverPreview(true);
}

function readSidebarCollapsed() {
  try {
    return window.localStorage.getItem(SIDEBAR_STORAGE_KEY) === '1';
  } catch (_) {
    return false;
  }
}

function readThemeMode() {
  try {
    const savedTheme = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (savedTheme === 'dark' || savedTheme === 'light') {
      return savedTheme;
    }
  } catch (_) {
    // Ignore storage access problems and fall back to system preference.
  }

  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function readOauthResultFromUrl() {
  if (typeof window === 'undefined') {
    return null;
  }

  const url = new URL(window.location.href);
  const status = String(url.searchParams.get('oauth_status') || '').trim().toLowerCase();
  const provider = String(url.searchParams.get('oauth_provider') || '').trim().toLowerCase();
  const message = String(url.searchParams.get('oauth_message') || '').trim();

  if (!status || !provider) {
    return null;
  }

  return {
    status: status === 'error' ? 'error' : 'success',
    provider,
    message,
  };
}

function clearOauthResultFromUrl() {
  if (typeof window === 'undefined') {
    return;
  }

  const url = new URL(window.location.href);
  url.searchParams.delete('oauth_status');
  url.searchParams.delete('oauth_provider');
  url.searchParams.delete('oauth_message');
  const nextPath = `${url.pathname}${url.search}${url.hash}`;
  window.history.replaceState({}, '', nextPath);
}

function normalizePortalPath(pathname = '') {
  const normalized = String(pathname || '').trim().replace(/\/+$/, '') || '/';
  if (normalized === '/login') {
    return '/login';
  }
  if (normalized === '/gm') {
    return '/gm';
  }
  if (normalized === '/user') {
    return '/user';
  }
  return '/';
}

function portalKindFromPath(pathname = '') {
  const normalized = normalizePortalPath(pathname);
  if (normalized === '/login') {
    return 'auth';
  }
  if (normalized === '/gm') {
    return 'admin';
  }
  if (normalized === '/user') {
    return 'user';
  }
  return 'public';
}

function resolvePortalPathForUser(user = null) {
  return user?.role === 'admin' ? '/gm' : '/user';
}

function defaultViewForPortal(portalPath = '/', user = null) {
  if (normalizePortalPath(portalPath) === '/user' && user?.role !== 'admin') {
    return 'inbox';
  }
  return 'dashboard';
}

function normalizeAuthMode(mode, portalKind = 'public', settings = {}) {
  const current = String(mode || '').trim().toLowerCase();
  const allowed = new Set(['login']);
  if ((portalKind === 'user' || portalKind === 'auth') && Boolean(settings?.registrationEnabled)) {
    allowed.add('register');
  }
  if (portalKind !== 'public' && Boolean(settings?.passwordResetEnabled)) {
    allowed.add('forgot');
  }
  return allowed.has(current) ? current : 'login';
}

function syncPortalStateFromLocation() {
  state.portalPath = normalizePortalPath(window.location.pathname);
  state.portalKind = portalKindFromPath(state.portalPath);
  state.authMode = normalizeAuthMode(state.authMode, state.portalKind, state.systemSettings);
  if (!window.location.hash) {
    state.view = defaultViewForPortal(state.portalPath, state.user);
  }
}

function replacePortalPath(pathname, hash = '') {
  const nextPath = normalizePortalPath(pathname);
  const nextHash = String(hash || '').trim();
  window.history.replaceState({}, '', `${nextPath}${nextHash}`);
  syncPortalStateFromLocation();
}

function defaultSystemSettings() {
  return {
    siteName: 'Mail Union',
    logoMode: 'auto',
    logoUrl: '',
    logoAssetUrl: '',
    logoAssetLocalPath: '',
    logoUploadDataUrl: '',
    logoUploadFilename: '',
    googleClientId: '',
    googleClientSecret: '',
    googleClientSecretConfigured: false,
    googleAppConfigured: false,
    microsoftClientId: '',
    microsoftClientSecret: '',
    clearMicrosoftClientSecret: false,
    microsoftClientSecretConfigured: false,
    microsoftTenantId: 'common',
    microsoftAppConfigured: false,
    registrationEnabled: true,
    registrationEmailVerificationRequired: false,
    registrationEmailDomainWhitelist: [],
    passwordResetEnabled: false,
    sessionTimeoutValue: 7,
    sessionTimeoutUnit: 'day',
    smtpHost: '',
    smtpPort: 587,
    smtpSecure: false,
    smtpUsername: '',
    smtpPassword: '',
    clearSmtpPassword: false,
    smtpPasswordConfigured: false,
    smtpFromName: 'Mail Union',
    smtpFromEmail: '',
    translationProvider: 'google_free',
    translationTargetLanguage: 'zh-CN',
    translationBaseUrl: '',
    translationRegion: '',
    translationModel: '',
    translationApiKey: '',
    clearTranslationApiKey: false,
    translationApiKeyConfigured: false,
    storageProvider: 'local',
    storageSyncPolicy: 'all_local',
    storageRemotePathPrefix: 'mail-union',
    storageS3Bucket: '',
    storageS3Region: '',
    storageS3Endpoint: '',
    storageS3AccessKey: '',
    storageS3Secret: '',
    storageS3SecretConfigured: false,
    storageS3ForcePathStyle: false,
    storageWebdavUrl: '',
    storageWebdavUsername: '',
    storageWebdavPassword: '',
    storageWebdavPasswordConfigured: false,
    storageFtpHost: '',
    storageFtpPort: 21,
    storageFtpSecure: false,
    storageFtpUsername: '',
    storageFtpPassword: '',
    storageFtpPasswordConfigured: false,
    backupEnabled: false,
    backupIntervalHours: 24,
    backupTarget: 'local',
    backupRetentionCount: 10,
    backupContentMode: 'database_and_site',
    backupIncludeRuntimeFiles: true,
    outboundProxyMode: 'system',
    outboundProxyUrl: '',
    outboundProxyBypass: '',
    themePresetId: 'ocean-mist',
  };
}

function createSystemSettingsDraft(settings = {}) {
  return {
    ...defaultSystemSettings(),
    ...(settings || {}),
    googleClientSecret: '',
    microsoftClientSecret: '',
    clearMicrosoftClientSecret: false,
    smtpPassword: '',
    clearSmtpPassword: false,
    translationApiKey: '',
    clearTranslationApiKey: false,
    storageS3Secret: '',
    storageWebdavPassword: '',
    storageFtpPassword: '',
    outboundProxyMode: settings?.outboundProxyMode || 'system',
    outboundProxyUrl: settings?.outboundProxyUrl || '',
    outboundProxyBypass: settings?.outboundProxyBypass || '',
    themePresetId: normalizeSystemThemePresetId(settings?.themePresetId),
  };
}

function getPersistableSystemSettingsDraft() {
  return {
    ...defaultSystemSettings(),
    ...(state.systemSettings || {}),
    ...(state.systemSettingsDraft || {}),
    themePresetId: normalizeSystemThemePresetId(
      state.systemSettingsDraft?.themePresetId || state.systemSettings?.themePresetId,
    ),
  };
}

function buildTranslationSystemSettingsPayload(form) {
  syncSystemSettingsDraftFromForm(form);
  const draft = getPersistableSystemSettingsDraft();

  return {
    translationProvider: draft.translationProvider,
    translationTargetLanguage: draft.translationTargetLanguage,
    translationBaseUrl: draft.translationBaseUrl,
    translationRegion: draft.translationRegion,
    translationModel: draft.translationModel,
    translationApiKey: draft.translationApiKey,
    clearTranslationApiKey: draft.clearTranslationApiKey,
  };
}

function buildAuthSystemSettingsPayload(form) {
  syncSystemSettingsDraftFromForm(form);
  const draft = getPersistableSystemSettingsDraft();

  return {
    registrationEnabled: draft.registrationEnabled,
    registrationEmailVerificationRequired: draft.registrationEmailVerificationRequired,
    registrationEmailDomainWhitelist: draft.registrationEmailDomainWhitelist,
    passwordResetEnabled: draft.passwordResetEnabled,
    sessionTimeoutValue: draft.sessionTimeoutValue,
    sessionTimeoutUnit: draft.sessionTimeoutUnit,
  };
}

function buildSmtpSystemSettingsPayload(form, options = {}) {
  syncSystemSettingsDraftFromForm(form);
  const draft = getPersistableSystemSettingsDraft();
  const formData = new FormData(form);
  const includeTestEmail = options.includeTestEmail !== false;
  const payload = {
    smtpHost: draft.smtpHost,
    smtpPort: draft.smtpPort,
    smtpSecure: draft.smtpSecure,
    smtpUsername: draft.smtpUsername,
    smtpPassword: draft.smtpPassword,
    clearSmtpPassword: draft.clearSmtpPassword,
    smtpFromName: draft.smtpFromName,
    smtpFromEmail: draft.smtpFromEmail,
  };

  if (includeTestEmail) {
    payload.testEmail = String(formData.get('smtpTestEmail') || state.systemSmtpTestEmail || '').trim();
  }

  return payload;
}

function buildProxySystemSettingsPayload(form) {
  syncSystemSettingsDraftFromForm(form);
  const draft = getPersistableSystemSettingsDraft();

  return {
    outboundProxyMode: draft.outboundProxyMode,
    outboundProxyUrl: draft.outboundProxyUrl,
    outboundProxyBypass: draft.outboundProxyBypass,
  };
}

function buildStorageSystemSettingsPayload(form) {
  syncSystemSettingsDraftFromForm(form);
  const draft = getPersistableSystemSettingsDraft();

  return {
    storageProvider: draft.storageProvider,
    storageSyncPolicy: draft.storageSyncPolicy,
    storageRemotePathPrefix: draft.storageRemotePathPrefix,
    storageS3Bucket: draft.storageS3Bucket,
    storageS3Region: draft.storageS3Region,
    storageS3Endpoint: draft.storageS3Endpoint,
    storageS3AccessKey: draft.storageS3AccessKey,
    storageS3Secret: draft.storageS3Secret,
    storageS3ForcePathStyle: draft.storageS3ForcePathStyle,
    storageWebdavUrl: draft.storageWebdavUrl,
    storageWebdavUsername: draft.storageWebdavUsername,
    storageWebdavPassword: draft.storageWebdavPassword,
    storageFtpHost: draft.storageFtpHost,
    storageFtpPort: draft.storageFtpPort,
    storageFtpSecure: draft.storageFtpSecure,
    storageFtpUsername: draft.storageFtpUsername,
    storageFtpPassword: draft.storageFtpPassword,
  };
}

function isTranslationSystemSettingsField(target) {
  const name = String(target?.name || '').trim();
  return [
    'translationProvider',
    'translationTargetLanguage',
    'translationBaseUrl',
    'translationRegion',
    'translationModel',
    'translationApiKey',
    'clearTranslationApiKey',
    'outboundProxyMode',
    'outboundProxyUrl',
    'outboundProxyBypass',
  ].includes(name);
}

function isAuthSystemSettingsField(target) {
  const name = String(target?.name || '').trim();
  return [
    'registrationEnabled',
    'registrationEmailVerificationRequired',
    'registrationEmailDomainWhitelist',
    'passwordResetEnabled',
    'sessionTimeoutValue',
    'sessionTimeoutUnit',
  ].includes(name);
}

function isSmtpSystemSettingsField(target) {
  const name = String(target?.name || '').trim();
  return [
    'smtpHost',
    'smtpPort',
    'smtpSecure',
    'smtpUsername',
    'smtpPassword',
    'clearSmtpPassword',
    'smtpFromName',
    'smtpFromEmail',
    'smtpTestEmail',
  ].includes(name);
}

function isStorageSystemSettingsField(target) {
  const name = String(target?.name || '').trim();
  return [
    'storageProvider',
    'storageSyncPolicy',
    'storageRemotePathPrefix',
    'storageS3Bucket',
    'storageS3Region',
    'storageS3Endpoint',
    'storageS3AccessKey',
    'storageS3Secret',
    'storageS3ForcePathStyle',
    'storageWebdavUrl',
    'storageWebdavUsername',
    'storageWebdavPassword',
    'storageFtpHost',
    'storageFtpPort',
    'storageFtpSecure',
    'storageFtpUsername',
    'storageFtpPassword',
  ].includes(name);
}

function systemMicrosoftClientId() {
  return String(state.systemSettings?.microsoftClientId || '').trim();
}

function systemMicrosoftTenantId() {
  return String(state.systemSettings?.microsoftTenantId || 'common').trim() || 'common';
}

function isSystemMicrosoftConfigured() {
  return Boolean(state.systemSettings?.microsoftAppConfigured);
}

function formValueOrFallback(formData, name, fallback = '') {
  const value = formData.get(name);
  return value === null ? fallback : String(value || '');
}

function formHasNamedField(form, name) {
  return Boolean(form?.elements?.namedItem?.(name));
}

function formValueOrDraft(form, formData, name, fallback = '') {
  if (!formHasNamedField(form, name)) {
    return fallback;
  }

  const value = formData.get(name);
  return value === null ? fallback : String(value || '');
}

function formNumberOrDraft(form, formData, name, fallback = 0) {
  if (!formHasNamedField(form, name)) {
    return fallback;
  }

  const raw = String(formData.get(name) || '').trim();
  if (!raw) {
    return fallback;
  }

  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function formCheckboxOrDraft(form, formData, name, fallback = false) {
  if (!formHasNamedField(form, name)) {
    return fallback;
  }

  return formData.get(name) === 'on';
}

function isSystemSettingsFormElement(form) {
  const formId = String(form?.dataset?.form || '').trim();
  return formId === 'system-settings' || formId === 'backup-settings';
}

function findSystemSettingsForm(target) {
  const form = target?.closest?.('form') || null;
  return isSystemSettingsFormElement(form) ? form : null;
}

function normalizeRegistrationWhitelistDomain(value = '') {
  let normalized = String(value || '').trim().toLowerCase();
  if (!normalized) {
    return '';
  }

  normalized = normalized.replace(/^mailto:/, '').replace(/^https?:\/\//, '').trim();
  if (normalized.includes('@') && !normalized.startsWith('@')) {
    const parts = normalized.split('@');
    normalized = parts[parts.length - 1] || '';
  }
  normalized = normalized.replace(/^@+/, '').replace(/\s+/g, '');
  if (!normalized) {
    return '';
  }

  return `@${normalized}`;
}

function parseRegistrationWhitelistDomains(value = '') {
  const tokens = Array.isArray(value)
    ? value
    : String(value || '')
        .split(/[\r\n,;|\s]+/g)
        .map((item) => item.trim())
        .filter(Boolean);

  return Array.from(
    new Set(
      tokens
        .map((item) => normalizeRegistrationWhitelistDomain(item))
        .filter(Boolean),
    ),
  );
}

const state = {
  ready: false,
  user: null,
  providers: [],
  users: [],
  usersForAssignment: [],
  dashboard: null,
  backups: [],
  backupRunLoading: '',
  backupRunDestination: '',
  backupRunContentMode: '',
  backupDeleteLoadingId: '',
  backupRestoreMode: 'full_site_data',
  backupRestoreFile: null,
  backupRestoreFilename: '',
  backupRestoreLoading: false,
  systemSettings: defaultSystemSettings(),
  systemSettingsDraft: createSystemSettingsDraft(),
  notifications: null,
  wecomDiscovery: null,
  notificationGuideChannel: '',
  notificationEmojiGuideOpen: false,
  systemGoogleGuideOpen: false,
  systemGoogleSecretVisible: false,
  systemGoogleSecretLoading: false,
  systemMicrosoftGuideOpen: false,
  systemMicrosoftSecretVisible: false,
  systemMicrosoftSecretLoading: false,
  systemSmtpPasswordVisible: false,
  systemSmtpPasswordLoading: false,
  systemSmtpConnectionLoading: false,
  systemSmtpConnectionResult: null,
  systemSmtpTestLoading: false,
  systemSmtpTestResult: null,
  systemSmtpTestEmail: '',
  systemRegistrationWhitelistInput: '',
  systemTranslationApiKeyVisible: false,
  systemTranslationApiKeyLoading: false,
  systemTranslationTestLoading: false,
  systemTranslationTestResult: null,
  systemProxyTestLoading: false,
  systemProxyTestResult: null,
  systemStorageTestLoading: false,
  systemStorageTestResult: null,
  attachmentMetadata: [],
  attachmentMetadataLoading: false,
  attachmentMetadataPage: 1,
  attachmentMetadataPageSize: 10,
  attachmentMetadataPagination: {
    page: 1,
    pageSize: 10,
    totalItems: 0,
    totalPages: 1,
  },
  attachmentMetadataSyncLoading: false,
  attachmentMetadataSyncResult: null,
  attachmentMetadataSelectedIds: [],
  attachmentMetadataBulkDeleteLoading: false,
  confirmDialog: null,
  topbarAccountMenuOpen: false,
  appVersion: {
    current: null,
    latest: null,
    checkedAt: '',
    isNewer: false,
    error: '',
    updateEnabled: false,
    updateRunning: false,
    updateState: null,
  },
  appVersionCheckLoading: false,
  appVersionUpdateLoading: false,
  appVersionPopoverOpen: false,
  systemStorageSecretVisibility: {
    storageS3Secret: false,
    storageWebdavPassword: false,
    storageFtpPassword: false,
  },
  systemStorageSecretLoading: {
    storageS3Secret: false,
    storageWebdavPassword: false,
    storageFtpPassword: false,
  },
  notificationConfigVisibility: {
    telegram: {},
    wecom: {},
    feishu: {},
  },
  notificationConfigLoading: {
    telegram: {},
    wecom: {},
    feishu: {},
  },
  notificationConfigValues: {},
  notificationDrafts: {
    telegram: null,
    wecom: null,
    feishu: null,
  },
  notificationTemplateOptionsDraft: null,
  notificationCoverEditorCategory: '',
  notificationChannelEditorKey: '',
  notificationToolModalKey: '',
  mailboxes: [],
  selectedMailboxIds: [],
  mailboxPage: 1,
  mailboxPageSize: 10,
  messages: [],
  selectedMessage: null,
  selectedMessageId: null,
  selectedMessageIds: [],
  inboxPage: 1,
  inboxPageSize: 10,
  inboxPagination: {
    page: 1,
    pageSize: 10,
    totalItems: 0,
    totalPages: 1,
  },
  messageReaderOpen: false,
  attachmentPreviewModal: null,
  messageTranslations: {},
  messageTranslationErrors: {},
  messageTranslationLoadingId: '',
  selectedMailboxId: '',
  selectedOwnerUserId: '',
  mailboxProviderFilter: 'all',
  mailboxSearch: '',
  mailboxColumnMenuOpen: false,
  mailboxVisibleFields: readMailboxVisibleFields(),
  systemSettingsGroup: 'general',
  mailboxToolbarOwnerSearch: '',
  mailboxToolbarOwnerFilterOpen: false,
  mailboxOwnerSearch: '',
  mailboxOwnerFilterOpen: false,
  inboxOwnerSearch: '',
  inboxOwnerFilterOpen: false,
  inboxMailboxSearch: '',
  inboxMailboxFilterOpen: false,
  inboxFolder: 'all',
  messageFolderCounts: {
    unreadCount: 0,
    readCount: 0,
    starredCount: 0,
    totalCount: 0,
    trashCount: 0,
    junkCount: 0,
  },
  search: '',
  view: window.location.hash.replace('#', '') || 'dashboard',
  portalPath: normalizePortalPath(window.location.pathname),
  portalKind: portalKindFromPath(window.location.pathname),
  sidebarCollapsed: readSidebarCollapsed(),
  theme: readThemeMode(),
  authMode: 'login',
  authCodeSending: false,
  authCodePurpose: '',
  authCodeResult: null,
  editingMailboxId: null,
  mailboxModalOpen: false,
  mailboxGuideOpen: false,
  mailboxImportModalOpen: false,
  mailboxPasswordVisible: false,
  editingUserId: null,
  userModalOpen: false,
  mailboxDraft: null,
  mailboxNotice: null,
  mailboxImportDraft: null,
  mailboxImportNotice: null,
  notice: null,
};

syncPortalStateFromLocation();

const NOTIFICATION_LABELS = {
  telegram: 'Telegram',
  wecom: '企业微信',
  feishu: '飞书',
};

const UI_AUTO_REFRESH_MS = 5000;
let wecomDiscoveryRefreshTimer = null;
let workspaceAutoRefreshTimer = null;
let shouldFocusMailboxSearch = false;
let shouldFocusMailboxToolbarOwnerSearch = false;
let shouldFocusMailboxOwnerSearch = false;
let shouldFocusInboxOwnerSearch = false;
let shouldFocusInboxMailboxSearch = false;
let shouldFocusMessageSearch = false;
let activeSearchCompositionAction = '';
let searchTimer = null;

function defaultAuthTypeForProvider(providerId) {
  const normalized = String(providerId || '').trim().toLowerCase();
  if (normalized === 'gmail') {
    return 'password';
  }
  if (normalized === 'outlook') {
    return 'microsoft_oauth';
  }
  return 'password';
}

function normalizeMicrosoftProtocolMode(value, fallback = 'graph_imap_dual') {
  const normalized = String(value || fallback || 'graph_imap_dual').trim().toLowerCase();
  if (normalized === 'graph_only') {
    return 'graph_only';
  }
  if (normalized === 'imap_only') {
    return 'imap_only';
  }
  return 'graph_imap_dual';
}

function hasManualMicrosoftRefreshToken(payload = {}) {
  return Boolean(
    String(payload.microsoftRefreshToken || '').trim() ||
      String(payload.microsoftGraphRefreshToken || '').trim() ||
      String(payload.microsoftImapRefreshToken || '').trim(),
  );
}

function isSpecialMessageFolderKind(folderKind) {
  const normalized = String(folderKind || 'inbox').trim().toLowerCase();
  return normalized === 'trash' || normalized === 'junk';
}

function visibleMailboxRefreshMs() {
  const visibleMailboxes = state.selectedMailboxId
    ? state.mailboxes.filter((mailbox) => mailbox.id === state.selectedMailboxId)
    : state.mailboxes;
  const syncIntervals = visibleMailboxes
    .map((mailbox) => Number(mailbox.syncIntervalSeconds || 5))
    .filter((value) => Number.isFinite(value) && value > 0);

  if (!syncIntervals.length) {
    return UI_AUTO_REFRESH_MS;
  }

  return Math.max(1000, Math.min(...syncIntervals) * 1000);
}

function formatMailboxSyncText(value) {
  if (!value) {
    return '\u672a\u540c\u6b65';
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '\u672a\u540c\u6b65';
  }

  return `\u4e0a\u6b21 ${new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)}`;
}

function clearNotificationConfigState(channel = '') {
  if (channel) {
    if (REVEALABLE_NOTIFICATION_CHANNELS.includes(channel)) {
      state.notificationConfigVisibility[channel] = {};
      state.notificationConfigLoading[channel] = {};
      delete state.notificationConfigValues[channel];
    }
    return;
  }

  for (const item of REVEALABLE_NOTIFICATION_CHANNELS) {
    state.notificationConfigVisibility[item] = {};
    state.notificationConfigLoading[item] = {};
    delete state.notificationConfigValues[item];
  }
}

function clearNotificationDraftState(channel = '') {
  if (channel) {
    if (REVEALABLE_NOTIFICATION_CHANNELS.includes(channel)) {
      state.notificationDrafts[channel] = null;
    }
    return;
  }

  for (const item of REVEALABLE_NOTIFICATION_CHANNELS) {
    state.notificationDrafts[item] = null;
  }

  state.notificationTemplateOptionsDraft = null;
  state.notificationCoverEditorCategory = '';
  state.notificationChannelEditorKey = '';
}

function syncActiveNotificationChannelEditorDraft() {
  const form = document.querySelector('[data-notification-channel-editor-form="true"]');
  if (form) {
    syncNotificationDraftFromForm(form);
  }
}

function createNotificationDraft(channel = '', setting = null) {
  const source = setting || state.notifications?.[channel] || null;

  if (channel === 'telegram') {
    return {
      enabled: Boolean(source?.enabled),
      chatId: String(source?.chatId || ''),
    };
  }

  if (channel === 'wecom') {
    const receiverType = String(source?.receiverType || 'user').trim().toLowerCase();
    return {
      enabled: Boolean(source?.enabled),
      mode: String(source?.mode || 'bot').trim().toLowerCase() === 'app' ? 'app' : 'bot',
      botConfigured: Boolean(source?.botConfigured),
      appConfigured: Boolean(source?.appConfigured),
      botId: String(source?.botId || ''),
      targetId: String(source?.targetId || ''),
      corpId: String(source?.corpId || ''),
      agentId: String(source?.agentId || ''),
      receiverType: ['user', 'party', 'tag'].includes(receiverType) ? receiverType : 'user',
      receiverId: String(source?.receiverId || ''),
      appBaseUrl: String(source?.appBaseUrl || ''),
      callbackToken: String(source?.callbackToken || ''),
      encodingAesKey: String(source?.encodingAesKey || ''),
    };
  }

  if (channel === 'feishu') {
    return {
      enabled: Boolean(source?.enabled),
      webhookUrl: String(source?.webhookUrl || ''),
    };
  }

  return {};
}

function syncNotificationDraftsFromSettings(channels = REVEALABLE_NOTIFICATION_CHANNELS, options = {}) {
  const { force = false } = options || {};
  const targetChannels = Array.isArray(channels) ? channels : [channels];

  for (const channel of targetChannels) {
    if (!REVEALABLE_NOTIFICATION_CHANNELS.includes(channel)) {
      continue;
    }

    if (!force && state.notificationDrafts[channel]) {
      continue;
    }

    state.notificationDrafts[channel] = createNotificationDraft(channel, state.notifications?.[channel] || null);
  }
}

function readNotificationFormField(form, field, fallback = '') {
  const input = form?.querySelector?.(`[name="${field}"]`);
  if (!input) {
    return fallback;
  }

  const hiddenField = input.closest?.('.notification-config-field.is-hidden');
  if (hiddenField && input.readOnly && String(input.value || '') === '') {
    return fallback;
  }

  return String(input.value || '');
}

function syncNotificationDraftFromForm(form) {
  if (!form) {
    return null;
  }

  const channel = form.dataset.channel || String(form.dataset.form || '').replace('notification-', '');
  if (!REVEALABLE_NOTIFICATION_CHANNELS.includes(channel)) {
    return null;
  }

  const baseDraft = {
    ...createNotificationDraft(channel, state.notifications?.[channel] || null),
    ...(state.notificationDrafts[channel] || {}),
  };

  if (channel === 'telegram') {
    state.notificationDrafts[channel] = {
      ...baseDraft,
      enabled: form.querySelector('[name="enabled"]')?.checked === true,
      botToken: readNotificationFormField(form, 'botToken', baseDraft.botToken),
      chatId: readNotificationFormField(form, 'chatId', baseDraft.chatId),
    };
    return state.notificationDrafts[channel];
  }

  if (channel === 'wecom') {
    const modeSource =
      String(form.dataset.wecomKind || '').trim().toLowerCase()
      || readNotificationFormField(form, 'mode', baseDraft.mode || 'bot').trim().toLowerCase();
    const mode = modeSource === 'app' ? 'app' : 'bot';
    const nextDraft = {
      ...baseDraft,
      enabled: form.querySelector('[name="enabled"]')?.checked === true,
      mode,
    };

    if (mode === 'app') {
      nextDraft.corpId = readNotificationFormField(form, 'corpId', baseDraft.corpId);
      nextDraft.agentId = readNotificationFormField(form, 'agentId', baseDraft.agentId);
      nextDraft.receiverType = readNotificationFormField(form, 'receiverType', baseDraft.receiverType || 'user');
      nextDraft.receiverId = readNotificationFormField(form, 'receiverId', baseDraft.receiverId);
      nextDraft.appBaseUrl = readNotificationFormField(form, 'appBaseUrl', baseDraft.appBaseUrl);
      nextDraft.callbackToken = readNotificationFormField(form, 'callbackToken', baseDraft.callbackToken);
      nextDraft.encodingAesKey = readNotificationFormField(form, 'encodingAesKey', baseDraft.encodingAesKey);
      nextDraft.appSecret = readNotificationFormField(form, 'appSecret', baseDraft.appSecret);
    } else {
      nextDraft.botId = readNotificationFormField(form, 'botId', baseDraft.botId);
      nextDraft.targetId = readNotificationFormField(form, 'targetId', baseDraft.targetId);
      nextDraft.botSecret = readNotificationFormField(form, 'botSecret', baseDraft.botSecret);
    }

    state.notificationDrafts[channel] = nextDraft;
    return nextDraft;
  }

  if (channel === 'feishu') {
    state.notificationDrafts[channel] = {
      ...baseDraft,
      enabled: form.querySelector('[name="enabled"]')?.checked === true,
      webhookUrl: readNotificationFormField(form, 'webhookUrl', baseDraft.webhookUrl),
      signSecret: readNotificationFormField(form, 'signSecret', baseDraft.signSecret),
    };
    return state.notificationDrafts[channel];
  }

  return null;
}

function syncNotificationRevealValuesFromSettings() {
  for (const channel of REVEALABLE_NOTIFICATION_CHANNELS) {
    const setting = state.notifications?.[channel] || null;
    const revealValues = state.notificationConfigValues[channel];

    if (!setting?.configured) {
      clearNotificationConfigState(channel);
      continue;
    }

    if (!revealValues) {
      continue;
    }

    if (channel === 'telegram') {
      revealValues.chatId = setting.chatId || revealValues.chatId || '';
    }

    if (channel === 'wecom') {
      revealValues.botId = setting.botId || revealValues.botId || '';
      revealValues.botSecret = setting.botSecret || revealValues.botSecret || '';
      revealValues.targetId = setting.targetId || revealValues.targetId || '';
      revealValues.corpId = setting.corpId || revealValues.corpId || '';
      revealValues.agentId = setting.agentId || revealValues.agentId || '';
      revealValues.appSecret = setting.appSecret || revealValues.appSecret || '';
      revealValues.receiverId = setting.receiverId || revealValues.receiverId || '';
      revealValues.appBaseUrl = setting.appBaseUrl || revealValues.appBaseUrl || '';
      revealValues.callbackUrl = setting.callbackUrl || revealValues.callbackUrl || '';
      revealValues.callbackToken = setting.callbackToken || revealValues.callbackToken || '';
      revealValues.encodingAesKey = setting.encodingAesKey || revealValues.encodingAesKey || '';
    }
  }
}

function decorateMailboxRows() {
  const cards = document.querySelectorAll('.mailbox-row-card');

  for (const card of cards) {
    const body = card.querySelector('.mailbox-row-body');
    const mainButton = card.querySelector('.mailbox-row-main');
    const legacyChips = card.querySelector('.mailbox-row-chips');
    const mailboxId = mainButton?.dataset.mailboxId || '';
    const mailbox = state.mailboxes.find((item) => item.id === mailboxId) || null;
    if (!body || !mainButton || !legacyChips || !mailbox) {
      continue;
    }

    legacyChips.classList.add('mailbox-row-chips-hidden');
    /*

    const mailboxId = mainButton.dataset.mailboxId || '';
    const chips = Array.from(legacyChips.querySelectorAll('span'));
    const unreadChip = chips.find((chip) => /未读/.test(chip.textContent || ''));
    const countChip = chips.find((chip) => /邮件|封/.test(chip.textContent || ''));
    const syncChip = chips.find((chip) => /上次|未同步/.test(chip.textContent || ''));

    */
    let summary = body.querySelector('.mailbox-row-summary');
    if (!summary) {
      summary = document.createElement('div');
      summary.className = 'mailbox-row-summary';
      mainButton.insertAdjacentElement('afterend', summary);
    }

    summary.innerHTML = '';

    const unreadButton = document.createElement('button');
    unreadButton.type = 'button';
    unreadButton.className = 'mailbox-count-pill';
    unreadButton.dataset.action = 'open-mailbox-folder';
    unreadButton.dataset.mailboxId = mailboxId;
    unreadButton.dataset.folder = 'unread';
    unreadButton.textContent = `${Number(mailbox.unreadCount || 0)} \u672a\u8bfb`;
    summary.appendChild(unreadButton);

    const countButton = document.createElement('button');
    countButton.type = 'button';
    countButton.className = 'mailbox-count-pill';
    countButton.dataset.action = 'open-mailbox-folder';
    countButton.dataset.mailboxId = mailboxId;
    countButton.dataset.folder = 'all';
    countButton.textContent = `${Number(mailbox.messageCount || 0)} \u5c01\u90ae\u4ef6`;
    summary.appendChild(countButton);

    const syncText = document.createElement('span');
    syncText.className = 'mailbox-row-sync';
    syncText.textContent = formatMailboxSyncText(mailbox.lastSyncedAt);
    summary.appendChild(syncText);
  }
}

function decorateNotificationForms() {
  const telegramForm = document.querySelector('[data-form="notification-telegram"]');
  if (!telegramForm) {
    return;
  }

  const actions = telegramForm.querySelector('.form-actions');
  if (!actions || telegramForm.querySelector('.telegram-chat-id-hint')) {
    return;
  }

  const hint = document.createElement('div');
  hint.className = 'notice info telegram-chat-id-hint';
  hint.innerHTML =
    '私聊填写用户或机器人的 <code>chat_id</code>，群聊通常使用 <code>-100</code> 开头的群组 <code>chat_id</code>。保存后可直接发送测试消息验证。';
  actions.insertAdjacentElement('beforebegin', hint);
}

function decorateActionButtons() {
  const buttons = root?.querySelectorAll?.(ACTION_BUTTON_SELECTOR) || [];

  for (const button of buttons) {
    if (!button || button.querySelector('.button-icon, .app-icon, .provider-icon')) {
      continue;
    }

    const label = String(button.textContent || '')
      .replace(/\s+/g, ' ')
      .trim();
    const ariaLabel = String(button.getAttribute('aria-label') || '').trim();

    if (!label && !ariaLabel) {
      continue;
    }

    const dataContext = Object.entries(button.dataset || {})
      .map(([key, value]) => `${key}:${value}`)
      .join(' ');
    const context = [dataContext, ariaLabel, label, button.type || '']
      .filter(Boolean)
      .join(' ');

    button.insertAdjacentHTML('afterbegin', renderAutoIcon(context, label || ariaLabel, 'button-icon'));
    button.classList.add('has-icon');
  }
}

function focusInboxMailboxSearch() {
  const input = root.querySelector('[data-action="inbox-mailbox-search"]');
  if (!input) {
    return;
  }

  input.focus({ preventScroll: true });
  const cursor = input.value.length;
  if (typeof input.setSelectionRange === 'function') {
    input.setSelectionRange(cursor, cursor);
  }
}

function focusInboxOwnerSearch() {
  const input = root.querySelector('[data-action="inbox-owner-search"]');
  if (!input) {
    return;
  }

  input.focus({ preventScroll: true });
  const cursor = input.value.length;
  if (typeof input.setSelectionRange === 'function') {
    input.setSelectionRange(cursor, cursor);
  }
}

function focusMailboxOwnerSearch() {
  const input = root.querySelector('[data-action="mailbox-owner-search"]');
  if (!input) {
    return;
  }

  input.focus({ preventScroll: true });
  const cursor = input.value.length;
  if (typeof input.setSelectionRange === 'function') {
    input.setSelectionRange(cursor, cursor);
  }
}

function focusMailboxSearch() {
  const input = root.querySelector('[data-action="mailbox-search"]');
  if (!input) {
    return;
  }

  input.focus({ preventScroll: true });
  const cursor = input.value.length;
  if (typeof input.setSelectionRange === 'function') {
    input.setSelectionRange(cursor, cursor);
  }
}

function focusMailboxToolbarOwnerSearch() {
  const input = root.querySelector('[data-action="mailbox-toolbar-owner-search"]');
  if (!input) {
    return;
  }

  input.focus({ preventScroll: true });
  const cursor = input.value.length;
  if (typeof input.setSelectionRange === 'function') {
    input.setSelectionRange(cursor, cursor);
  }
}

function focusMessageSearch(selectionStart = null, selectionEnd = null) {
  const input = root.querySelector('[data-action="search"]');
  if (!input) {
    return;
  }

  input.focus({ preventScroll: true });
  const fallbackCursor = input.value.length;
  const nextSelectionStart = Number.isInteger(selectionStart) ? selectionStart : fallbackCursor;
  const nextSelectionEnd = Number.isInteger(selectionEnd) ? selectionEnd : nextSelectionStart;
  if (typeof input.setSelectionRange === 'function') {
    input.setSelectionRange(nextSelectionStart, nextSelectionEnd);
  }
}

function isSearchableDropdownAction(action = '') {
  return SEARCHABLE_DROPDOWN_ACTIONS.has(action);
}

function isManagedSearchInputAction(action = '') {
  return MANAGED_SEARCH_INPUT_ACTIONS.has(action);
}

function clearSearchFocusFlags() {
  shouldFocusMailboxSearch = false;
  shouldFocusMailboxToolbarOwnerSearch = false;
  shouldFocusMailboxOwnerSearch = false;
  shouldFocusInboxOwnerSearch = false;
  shouldFocusInboxMailboxSearch = false;
  shouldFocusMessageSearch = false;
}

function setSearchableDropdownFocus(action = '') {
  clearSearchFocusFlags();

  if (action === 'inbox-mailbox-search') {
    shouldFocusInboxMailboxSearch = true;
    return;
  }

  if (action === 'inbox-owner-search') {
    shouldFocusInboxOwnerSearch = true;
    return;
  }

  if (action === 'mailbox-owner-search') {
    shouldFocusMailboxOwnerSearch = true;
    return;
  }

  if (action === 'mailbox-toolbar-owner-search') {
    shouldFocusMailboxToolbarOwnerSearch = true;
    return;
  }

  if (action === 'mailbox-search') {
    shouldFocusMailboxSearch = true;
    return;
  }

  if (action === 'search') {
    shouldFocusMessageSearch = true;
  }
}

function setSearchableDropdownValue(action = '', value = '') {
  if (action === 'inbox-mailbox-search') {
    state.inboxMailboxSearch = value;
    return true;
  }

  if (action === 'inbox-owner-search') {
    state.inboxOwnerSearch = value;
    return true;
  }

  if (action === 'mailbox-owner-search') {
    state.mailboxOwnerSearch = value;
    return true;
  }

  if (action === 'mailbox-toolbar-owner-search') {
    state.mailboxToolbarOwnerSearch = value;
    return true;
  }

  if (action === 'mailbox-search') {
    state.mailboxSearch = value;
    state.mailboxPage = 1;
    clearMailboxSelection();
    return true;
  }

  return false;
}

function applySearchableDropdownInput(action = '', value = '', options = {}) {
  if (!setSearchableDropdownValue(action, value)) {
    return false;
  }

  setSearchableDropdownFocus(action);

  if (options.redraw !== false) {
    redraw();
  }

  return true;
}

function clearSearchComposition(action = '') {
  if (!action || activeSearchCompositionAction === action) {
    activeSearchCompositionAction = '';
  }
}

function captureManagedSearchFocus() {
  const activeElement = document.activeElement;
  const action = activeElement?.dataset?.action || '';

  if (!isManagedSearchInputAction(action)) {
    return null;
  }

  return {
    action,
    selectionStart: typeof activeElement.selectionStart === 'number' ? activeElement.selectionStart : null,
    selectionEnd: typeof activeElement.selectionEnd === 'number' ? activeElement.selectionEnd : null,
  };
}

function restoreManagedSearchFocus(snapshot) {
  if (!snapshot?.action || !isManagedSearchInputAction(snapshot.action)) {
    return false;
  }

  if (snapshot.action === 'mailbox-toolbar-owner-search' && !state.mailboxToolbarOwnerFilterOpen) {
    return false;
  }

  if (snapshot.action === 'mailbox-owner-search' && !state.mailboxOwnerFilterOpen) {
    return false;
  }

  if (snapshot.action === 'inbox-owner-search' && !state.inboxOwnerFilterOpen) {
    return false;
  }

  if (snapshot.action === 'inbox-mailbox-search' && !state.inboxMailboxFilterOpen) {
    return false;
  }

  if (snapshot.action === 'mailbox-search' && state.view !== 'mailboxes') {
    return false;
  }

  if (snapshot.action === 'search' && state.view !== 'inbox') {
    return false;
  }

  if (snapshot.action === 'search') {
    focusMessageSearch(snapshot.selectionStart, snapshot.selectionEnd);
    return true;
  }

  const input = root.querySelector(`[data-action="${snapshot.action}"]`);
  if (!input) {
    return false;
  }

  input.focus({ preventScroll: true });
  const fallbackCursor = input.value.length;
  const nextSelectionStart = Number.isInteger(snapshot.selectionStart) ? snapshot.selectionStart : fallbackCursor;
  const nextSelectionEnd = Number.isInteger(snapshot.selectionEnd) ? snapshot.selectionEnd : nextSelectionStart;
  if (typeof input.setSelectionRange === 'function') {
    input.setSelectionRange(nextSelectionStart, nextSelectionEnd);
  }

  return true;
}

function searchableDropdownInputIsBusy() {
  if (activeSearchCompositionAction || searchTimer) {
    return true;
  }

  const activeElement = document.activeElement;
  if (!activeElement || !activeElement.dataset) {
    return false;
  }

  return isManagedSearchInputAction(activeElement.dataset.action || '');
}

function capturePreservedScrollState() {
  const containers = Array.from(root?.querySelectorAll?.('[data-preserve-scroll-key]') || [])
    .map((element) => ({
      key: String(element?.dataset?.preserveScrollKey || '').trim(),
      top: Number(element?.scrollTop || 0),
      left: Number(element?.scrollLeft || 0),
    }))
    .filter((snapshot) => snapshot.key);

  return {
    containers,
    windowX: Number(window.scrollX || 0),
    windowY: Number(window.scrollY || 0),
  };
}

function restorePreservedScrollState(snapshot) {
  if (!snapshot) {
    return;
  }

  const containerSnapshots = new Map(
    (snapshot.containers || [])
      .map((entry) => [String(entry?.key || '').trim(), entry])
      .filter(([key]) => key),
  );

  for (const element of Array.from(root?.querySelectorAll?.('[data-preserve-scroll-key]') || [])) {
    const key = String(element?.dataset?.preserveScrollKey || '').trim();
    const saved = containerSnapshots.get(key);
    if (!saved) {
      continue;
    }

    const maxTop = Math.max(0, element.scrollHeight - element.clientHeight);
    const maxLeft = Math.max(0, element.scrollWidth - element.clientWidth);
    element.scrollTop = Math.min(Math.max(0, Number(saved.top || 0)), maxTop);
    element.scrollLeft = Math.min(Math.max(0, Number(saved.left || 0)), maxLeft);
  }

  window.scrollTo(Number(snapshot.windowX || 0), Number(snapshot.windowY || 0));
}

function capturePreservedBrandAvatars() {
  const buckets = new Map();

  for (const element of Array.from(root?.querySelectorAll?.('[data-brand-avatar-key]') || [])) {
    const key = String(element?.dataset?.brandAvatarKey || '').trim();
    if (!key) {
      continue;
    }

    if (!buckets.has(key)) {
      buckets.set(key, []);
    }

    buckets.get(key).push(element);
  }

  return buckets;
}

function restorePreservedBrandAvatars(snapshot) {
  if (!snapshot?.size) {
    return;
  }

  const usage = new Map();

  for (const element of Array.from(root?.querySelectorAll?.('[data-brand-avatar-key]') || [])) {
    const key = String(element?.dataset?.brandAvatarKey || '').trim();
    if (!key) {
      continue;
    }

    const bucket = snapshot.get(key);
    const bucketIndex = Number(usage.get(key) || 0);
    const preserved = Array.isArray(bucket) ? bucket[bucketIndex] : null;
    if (!preserved) {
      continue;
    }

    usage.set(key, bucketIndex + 1);
    element.replaceWith(preserved);
  }
}

function capturePreservedAttachmentPreviews() {
  const buckets = new Map();

  for (const element of Array.from(root?.querySelectorAll?.('[data-attachment-preview-key]') || [])) {
    const key = String(element?.dataset?.attachmentPreviewKey || '').trim();
    if (!key) {
      continue;
    }

    if (!buckets.has(key)) {
      buckets.set(key, []);
    }

    buckets.get(key).push(element);
  }

  return buckets;
}

function restorePreservedAttachmentPreviews(snapshot) {
  if (!snapshot?.size) {
    return;
  }

  const usage = new Map();

  for (const element of Array.from(root?.querySelectorAll?.('[data-attachment-preview-key]') || [])) {
    const key = String(element?.dataset?.attachmentPreviewKey || '').trim();
    if (!key) {
      continue;
    }

    const bucket = snapshot.get(key);
    const bucketIndex = Number(usage.get(key) || 0);
    const preserved = Array.isArray(bucket) ? bucket[bucketIndex] : null;
    if (!preserved) {
      continue;
    }

    usage.set(key, bucketIndex + 1);
    element.replaceWith(preserved);
  }
}

function redraw() {
  const managedSearchFocus = captureManagedSearchFocus();
  const preservedScrollState = capturePreservedScrollState();
  const preservedBrandAvatars = capturePreservedBrandAvatars();
  const preservedAttachmentPreviews = capturePreservedAttachmentPreviews();
  hideAttachmentHoverPreview(true);
  render(root, state);
  scheduleGlobalNoticeDismiss();
  restorePreservedBrandAvatars(preservedBrandAvatars);
  restorePreservedAttachmentPreviews(preservedAttachmentPreviews);
  hydrateMessageHtmlFrames();
  decorateMailboxRows();
  decorateNotificationForms();
  decorateActionButtons();
  restorePreservedScrollState(preservedScrollState);
  if (restoreManagedSearchFocus(managedSearchFocus)) {
    clearSearchFocusFlags();
    return;
  }

  if (shouldFocusMailboxToolbarOwnerSearch && state.mailboxToolbarOwnerFilterOpen) {
    clearSearchFocusFlags();
    focusMailboxToolbarOwnerSearch();
    return;
  }

  if (shouldFocusMailboxSearch && state.view === 'mailboxes') {
    clearSearchFocusFlags();
    focusMailboxSearch();
    return;
  }

  if (shouldFocusMailboxOwnerSearch && state.mailboxOwnerFilterOpen) {
    clearSearchFocusFlags();
    focusMailboxOwnerSearch();
    return;
  }

  if (shouldFocusInboxOwnerSearch && state.inboxOwnerFilterOpen) {
    clearSearchFocusFlags();
    focusInboxOwnerSearch();
    return;
  }

  if (shouldFocusInboxMailboxSearch && state.inboxMailboxFilterOpen) {
    clearSearchFocusFlags();
    focusInboxMailboxSearch();
    return;
  }

  if (shouldFocusMessageSearch && state.view === 'inbox') {
    clearSearchFocusFlags();
    focusMessageSearch();
    return;
  }

  clearSearchFocusFlags();
}

let confirmDialogResolver = null;

function resolveConfirmDialog(result = false) {
  const resolver = confirmDialogResolver;
  confirmDialogResolver = null;
  state.confirmDialog = null;
  if (typeof resolver === 'function') {
    resolver(Boolean(result));
  }
}

function openConfirmDialog(options = {}) {
  if (confirmDialogResolver) {
    resolveConfirmDialog(false);
  }

  const tone = options.tone === 'danger' ? 'danger' : 'default';

  return new Promise((resolve) => {
    confirmDialogResolver = resolve;
    state.confirmDialog = {
      eyebrow: options.eyebrow || '操作确认',
      title: options.title || '确认继续当前操作？',
      message: options.message || '该操作会立即生效，请确认后继续。',
      confirmLabel: options.confirmLabel || '确认',
      cancelLabel: options.cancelLabel || '取消',
      tone,
      icon: options.icon || (tone === 'danger' ? 'warning' : 'notes'),
    };
    redraw();
  });
}

function persistSidebarCollapsed() {
  try {
    window.localStorage.setItem(SIDEBAR_STORAGE_KEY, state.sidebarCollapsed ? '1' : '0');
  } catch (_) {
    // Ignore storage failures and keep the UI responsive.
  }
}

window.addEventListener('resize', () => {
  document.querySelectorAll('[data-message-html-frame="true"]').forEach((frame) => {
    resizeMessageHtmlFrame(frame);
  });
});

function applyTheme(theme, persist = true) {
  state.theme = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', state.theme);

  if (!persist) {
    return;
  }

  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, state.theme);
  } catch (_) {
    // Ignore storage failures and keep the UI responsive.
  }
}

function applyThemePreset(presetId) {
  const resolvedPresetId = normalizeSystemThemePresetId(
    String(presetId || state.systemSettings?.themePresetId || 'ocean-mist').trim(),
  );
  state.systemSettings = {
    ...defaultSystemSettings(),
    ...(state.systemSettings || {}),
    themePresetId: resolvedPresetId,
  };
  document.documentElement.setAttribute('data-theme-preset', resolvedPresetId);
}

function buildGeneratedBrandIconSvg(siteName = 'Mail Union') {
  const label = String(siteName || 'Mail Union').trim() || 'Mail Union';
  const initials = label.replace(/\s+/g, '').slice(0, 2).toUpperCase() || 'MU';

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><linearGradient id="mail-union-favicon-gradient" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#14b8a6"/><stop offset="100%" stop-color="#2563eb"/></linearGradient></defs><rect x="4" y="4" width="56" height="56" rx="18" fill="#0f172a"/><rect x="6" y="6" width="52" height="52" rx="16" fill="url(#mail-union-favicon-gradient)" opacity="0.18"/><rect x="9" y="9" width="46" height="46" rx="14" fill="#111c2f"/><text x="32" y="38" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-size="22" font-weight="800" fill="#f8fafc">${initials}</text></svg>`;
}

function buildGeneratedBrandIconDataUrl(siteName = 'Mail Union') {
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(buildGeneratedBrandIconSvg(siteName))}`;
}

function resolveSystemBrandIconHref(settings = {}) {
  if (settings.logoAssetUrl) {
    return String(settings.logoAssetUrl).trim();
  }

  if (String(settings.logoMode || 'auto').trim().toLowerCase() === 'url' && settings.logoUrl) {
    return String(settings.logoUrl).trim();
  }

  return buildGeneratedBrandIconDataUrl(settings.siteName || 'Mail Union');
}

function upsertDocumentLink(id, rel, href) {
  if (!href) {
    return;
  }

  let link = document.querySelector(`#${id}`);
  if (!link) {
    link = document.createElement('link');
    link.id = id;
    document.head.appendChild(link);
  }

  link.rel = rel;
  link.href = href;
}

function applySystemSettingsToDocument() {
  applyThemePreset(state.systemSettings?.themePresetId || 'ocean-mist');
  document.title = String(state.systemSettings?.siteName || 'Mail Union').trim() || 'Mail Union';
  const iconHref = resolveSystemBrandIconHref(state.systemSettings || {});
  upsertDocumentLink('app-favicon', 'icon', iconHref);
  upsertDocumentLink('app-touch-icon', 'apple-touch-icon', iconHref);
}

function applyLoadedSystemSettings(settings = {}) {
  const normalizedSettings = {
    ...defaultSystemSettings(),
    ...(settings || {}),
    themePresetId: normalizeSystemThemePresetId(settings?.themePresetId),
  };

  state.systemSettings = normalizedSettings;
  state.systemSettingsDraft = createSystemSettingsDraft(normalizedSettings);
  state.systemGoogleSecretVisible = false;
  state.systemGoogleSecretLoading = false;
  state.systemMicrosoftSecretVisible = false;
  state.systemMicrosoftSecretLoading = false;
  state.systemSmtpPasswordVisible = false;
  state.systemSmtpPasswordLoading = false;
  state.systemSmtpConnectionLoading = false;
  state.systemSmtpConnectionResult = null;
  state.systemSmtpTestLoading = false;
  state.systemSmtpTestResult = null;
  state.systemSmtpTestEmail = '';
  state.systemRegistrationWhitelistInput = '';
  state.systemTranslationApiKeyVisible = false;
  state.systemTranslationApiKeyLoading = false;
  state.systemTranslationTestLoading = false;
  state.systemTranslationTestResult = null;
  state.systemProxyTestLoading = false;
  state.systemProxyTestResult = null;
  state.systemStorageTestLoading = false;
  state.systemStorageTestResult = null;
  state.systemStorageSecretVisibility = {
    storageS3Secret: false,
    storageWebdavPassword: false,
    storageFtpPassword: false,
  };
  state.systemStorageSecretLoading = {
    storageS3Secret: false,
    storageWebdavPassword: false,
    storageFtpPassword: false,
  };
  state.authMode = normalizeAuthMode(state.authMode, state.portalKind, normalizedSettings);
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('读取 Logo 文件失败，请重新选择一次。'));
    reader.readAsDataURL(file);
  });
}

function updateNotificationCoverPreview(form, category, source = '') {
  const imageNode = form?.querySelector?.(`[data-cover-preview-image="${category}"]`);
  const fallbackNode = form?.querySelector?.(`[data-cover-preview-fallback="${category}"]`);
  const resolvedSource = String(source || '').trim();

  if (imageNode) {
    if (resolvedSource) {
      imageNode.src = resolvedSource;
      imageNode.hidden = false;
    } else {
      imageNode.removeAttribute('src');
      imageNode.hidden = true;
    }
  }

  if (fallbackNode) {
    fallbackNode.hidden = Boolean(resolvedSource);
  }
}

function syncNotificationCoverPreviewFromForm(form, category) {
  if (!form || !NOTIFICATION_COVER_CATEGORIES.includes(String(category || '').trim())) {
    return;
  }

  const resolvedCategory = String(category || '').trim();
  const prefix = notificationCoverFieldPrefix(resolvedCategory);
  const currentCover = state.notificationTemplateOptionsDraft?.covers?.[resolvedCategory] || {};
  const mode = String(
    form?.querySelector?.(`[name="${prefix}Mode"]`)?.value || currentCover.mode || 'builtin',
  ).trim().toLowerCase();
  const builtinSource = notificationCoverBuiltinAssetUrl(resolvedCategory);
  const uploadDataUrl = String(form?.querySelector?.(`[name="${prefix}UploadDataUrl"]`)?.value || '').trim();
  const directUrl = String(form?.querySelector?.(`[name="${prefix}Url"]`)?.value || currentCover.url || '').trim();
  const source =
    mode === 'builtin'
      ? builtinSource
      : mode === 'upload'
        ? uploadDataUrl || currentCover.assetUrl || notificationCoverAssetUrlFromPath(currentCover.assetPath)
        : mode === 'url'
          ? directUrl || currentCover.assetUrl || ''
          : '';

  updateNotificationCoverPreview(form, resolvedCategory, source);
}

async function handleNotificationCoverUploadChange(input) {
  const file = input?.files?.[0];
  if (!file) {
    return;
  }

  if (!String(file.type || '').startsWith('image/')) {
    throw new Error('请上传 PNG、JPG、WEBP、GIF、SVG 这类图片格式的封面文件。');
  }

  if (Number(file.size || 0) > NOTIFICATION_COVER_UPLOAD_MAX_BYTES) {
    throw new Error('通知封面图片不能超过 2 MB，请压缩后再上传。');
  }

  const form = input.closest('[data-form="notification-template-options"]');
  const category = String(input.dataset.coverCategory || '').trim();
  if (!form || !NOTIFICATION_COVER_CATEGORIES.includes(category)) {
    return;
  }

  const prefix = notificationCoverFieldPrefix(category);
  const uploadDataUrl = await readFileAsDataUrl(file);
  const hiddenDataUrlInput = form.querySelector(`[name="${prefix}UploadDataUrl"]`);
  const hiddenFilenameInput = form.querySelector(`[name="${prefix}UploadFilename"]`);
  const modeSelect = form.querySelector(`[name="${prefix}Mode"]`);
  const filenameHint = form.querySelector(`[data-cover-upload-filename="${category}"]`);

  if (hiddenDataUrlInput) {
    hiddenDataUrlInput.value = uploadDataUrl;
  }
  if (hiddenFilenameInput) {
    hiddenFilenameInput.value = String(file.name || '').trim();
  }
  if (modeSelect) {
    modeSelect.value = 'upload';
  }
  if (filenameHint) {
    filenameHint.textContent = `已选择：${file.name}，保存后会写入系统本地封面目录。`;
  }

  updateNotificationCoverPreview(form, category, uploadDataUrl);
}

async function handleSystemLogoUploadChange(input) {
  const file = input?.files?.[0];
  if (!file) {
    return;
  }

  if (!String(file.type || '').startsWith('image/')) {
    throw new Error('请上传 PNG、JPG、SVG、ICO、WEBP 这类图片格式的 Logo 文件。');
  }

  if (Number(file.size || 0) > 8 * 1024 * 1024) {
    throw new Error('Logo 图片不能超过 8 MB，请压缩后再上传。');
  }

  const logoUploadDataUrl = await readFileAsDataUrl(file);
  const previousDraft = createSystemSettingsDraft(state.systemSettingsDraft || state.systemSettings);
  state.systemSettingsDraft = {
    ...previousDraft,
    logoMode: 'upload',
    logoUploadDataUrl,
    logoUploadFilename: String(file.name || '').trim(),
  };
  state.notice = {
    text: `本地 Logo 已选择：${file.name}，点击“保存站点品牌”后生效。`,
    tone: 'info',
  };
}

function syncSystemSettingsDraftFromForm(form) {
  if (!form) {
    return;
  }

  const formData = new FormData(form);
  const previousDraft = createSystemSettingsDraft(state.systemSettingsDraft || state.systemSettings);
  const googleClientId = formValueOrDraft(
    form,
    formData,
    'googleClientId',
    previousDraft.googleClientId || '',
  ).trim();
  const googleClientSecret = formValueOrDraft(
    form,
    formData,
    'googleClientSecret',
    previousDraft.googleClientSecret || '',
  );
  const microsoftClientId = formValueOrDraft(
    form,
    formData,
    'microsoftClientId',
    previousDraft.microsoftClientId || '',
  ).trim();
  const microsoftClientSecret = formValueOrDraft(
    form,
    formData,
    'microsoftClientSecret',
    previousDraft.microsoftClientSecret || '',
  );
  const clearMicrosoftClientSecret = formCheckboxOrDraft(
    form,
    formData,
    'clearMicrosoftClientSecret',
    false,
  );
  const smtpPassword = formValueOrDraft(
    form,
    formData,
    'smtpPassword',
    previousDraft.smtpPassword || '',
  );
  const clearSmtpPasswordRequested = formCheckboxOrDraft(
    form,
    formData,
    'clearSmtpPassword',
    false,
  );
  const clearSmtpPassword = String(smtpPassword || '').trim() ? false : clearSmtpPasswordRequested;
  const translationProvider = String(
    formValueOrDraft(form, formData, 'translationProvider', previousDraft.translationProvider || 'google_free') ||
      previousDraft.translationProvider ||
      'google_free',
  ).trim();
  const translationApiKey = formValueOrDraft(
    form,
    formData,
    'translationApiKey',
    previousDraft.translationApiKey ?? '',
  );
  const clearTranslationApiKey = formCheckboxOrDraft(
    form,
    formData,
    'clearTranslationApiKey',
    false,
  );
  const storageS3Secret = formValueOrDraft(
    form,
    formData,
    'storageS3Secret',
    previousDraft.storageS3Secret || '',
  );
  const storageWebdavPassword = formValueOrDraft(
    form,
    formData,
    'storageWebdavPassword',
    previousDraft.storageWebdavPassword || '',
  );
  const storageFtpPassword = formValueOrDraft(
    form,
    formData,
    'storageFtpPassword',
    previousDraft.storageFtpPassword || '',
  );
  state.systemSettingsDraft = {
    ...previousDraft,
    siteName:
      formValueOrDraft(form, formData, 'siteName', previousDraft.siteName || 'Mail Union').trim() || 'Mail Union',
    logoMode:
      formValueOrDraft(form, formData, 'logoMode', state.systemSettingsDraft?.logoMode || 'auto').trim() || 'auto',
    logoUrl: formValueOrDraft(form, formData, 'logoUrl', previousDraft.logoUrl || ''),
    logoAssetUrl: String(state.systemSettingsDraft?.logoAssetUrl || state.systemSettings?.logoAssetUrl || ''),
    googleClientId,
    googleClientSecret,
    googleClientSecretConfigured: Boolean(
      String(googleClientSecret || '').trim() || state.systemSettings?.googleClientSecretConfigured,
    ),
    googleAppConfigured: Boolean(googleClientId),
    microsoftClientId,
    microsoftClientSecret,
    clearMicrosoftClientSecret,
    microsoftClientSecretConfigured: clearMicrosoftClientSecret
      ? false
      : Boolean(String(microsoftClientSecret || '').trim() || state.systemSettings?.microsoftClientSecretConfigured),
    microsoftTenantId:
      formValueOrDraft(form, formData, 'microsoftTenantId', previousDraft.microsoftTenantId || 'common').trim() ||
      'common',
    microsoftAppConfigured: Boolean(microsoftClientId),
    registrationEnabled: formCheckboxOrDraft(
      form,
      formData,
      'registrationEnabled',
      previousDraft.registrationEnabled,
    ),
    registrationEmailVerificationRequired: formCheckboxOrDraft(
      form,
      formData,
      'registrationEmailVerificationRequired',
      previousDraft.registrationEmailVerificationRequired,
    ),
    registrationEmailDomainWhitelist: parseRegistrationWhitelistDomains(
      formValueOrDraft(
        form,
        formData,
        'registrationEmailDomainWhitelist',
        Array.isArray(previousDraft.registrationEmailDomainWhitelist)
          ? previousDraft.registrationEmailDomainWhitelist.join('\n')
          : '',
      ),
    ),
    passwordResetEnabled: formCheckboxOrDraft(
      form,
      formData,
      'passwordResetEnabled',
      previousDraft.passwordResetEnabled,
    ),
    sessionTimeoutValue: formNumberOrDraft(
      form,
      formData,
      'sessionTimeoutValue',
      Number(previousDraft.sessionTimeoutValue || 7),
    ),
    sessionTimeoutUnit:
      formValueOrDraft(form, formData, 'sessionTimeoutUnit', previousDraft.sessionTimeoutUnit || 'day').trim()
      || 'day',
    smtpHost: formValueOrDraft(form, formData, 'smtpHost', previousDraft.smtpHost || '').trim(),
    smtpPort: formNumberOrDraft(form, formData, 'smtpPort', Number(previousDraft.smtpPort || 587)),
    smtpSecure: formCheckboxOrDraft(form, formData, 'smtpSecure', previousDraft.smtpSecure),
    smtpUsername: formValueOrDraft(form, formData, 'smtpUsername', previousDraft.smtpUsername || '').trim(),
    smtpPassword,
    clearSmtpPassword,
    smtpPasswordConfigured: clearSmtpPassword
      ? false
      : Boolean(String(smtpPassword || '').trim() || state.systemSettings?.smtpPasswordConfigured),
    smtpFromName:
      formValueOrDraft(form, formData, 'smtpFromName', previousDraft.smtpFromName || 'Mail Union').trim() ||
      'Mail Union',
    smtpFromEmail: formValueOrDraft(form, formData, 'smtpFromEmail', previousDraft.smtpFromEmail || '').trim(),
    translationProvider,
    translationTargetLanguage:
      String(
        formValueOrDraft(
          form,
          formData,
          'translationTargetLanguage',
          previousDraft.translationTargetLanguage || 'zh-CN',
        ) ||
          previousDraft.translationTargetLanguage ||
          'zh-CN',
      ).trim() || 'zh-CN',
    translationBaseUrl: formValueOrDraft(
      form,
      formData,
      'translationBaseUrl',
      previousDraft.translationBaseUrl ?? '',
    ).trim(),
    translationRegion: formValueOrDraft(
      form,
      formData,
      'translationRegion',
      previousDraft.translationRegion ?? '',
    ).trim(),
    translationModel: formValueOrDraft(
      form,
      formData,
      'translationModel',
      previousDraft.translationModel ?? '',
    ).trim(),
    translationApiKey,
    clearTranslationApiKey,
    translationApiKeyConfigured: clearTranslationApiKey
      ? false
      : Boolean(String(translationApiKey || '').trim() || state.systemSettings?.translationApiKeyConfigured),
    storageProvider:
      formValueOrDraft(form, formData, 'storageProvider', previousDraft.storageProvider || 'local').trim() || 'local',
    storageSyncPolicy:
      formValueOrDraft(form, formData, 'storageSyncPolicy', previousDraft.storageSyncPolicy || 'all_local').trim()
      || 'all_local',
    storageRemotePathPrefix:
      formValueOrDraft(
        form,
        formData,
        'storageRemotePathPrefix',
        previousDraft.storageRemotePathPrefix || 'mail-union',
      ).trim() || 'mail-union',
    storageS3Bucket: formValueOrDraft(form, formData, 'storageS3Bucket', previousDraft.storageS3Bucket || '').trim(),
    storageS3Region: formValueOrDraft(form, formData, 'storageS3Region', previousDraft.storageS3Region || '').trim(),
    storageS3Endpoint: formValueOrDraft(
      form,
      formData,
      'storageS3Endpoint',
      previousDraft.storageS3Endpoint || '',
    ).trim(),
    storageS3AccessKey: formValueOrDraft(
      form,
      formData,
      'storageS3AccessKey',
      previousDraft.storageS3AccessKey || '',
    ).trim(),
    storageS3Secret,
    storageS3SecretConfigured: Boolean(
      String(storageS3Secret || '').trim() || state.systemSettings?.storageS3SecretConfigured,
    ),
    storageS3ForcePathStyle: formCheckboxOrDraft(
      form,
      formData,
      'storageS3ForcePathStyle',
      previousDraft.storageS3ForcePathStyle,
    ),
    storageWebdavUrl: formValueOrDraft(
      form,
      formData,
      'storageWebdavUrl',
      previousDraft.storageWebdavUrl || '',
    ).trim(),
    storageWebdavUsername: formValueOrDraft(
      form,
      formData,
      'storageWebdavUsername',
      previousDraft.storageWebdavUsername || '',
    ).trim(),
    storageWebdavPassword,
    storageWebdavPasswordConfigured: Boolean(
      String(storageWebdavPassword || '').trim() || state.systemSettings?.storageWebdavPasswordConfigured,
    ),
    storageFtpHost: formValueOrDraft(form, formData, 'storageFtpHost', previousDraft.storageFtpHost || '').trim(),
    storageFtpPort: formNumberOrDraft(form, formData, 'storageFtpPort', Number(previousDraft.storageFtpPort || 21)),
    storageFtpSecure: formCheckboxOrDraft(
      form,
      formData,
      'storageFtpSecure',
      previousDraft.storageFtpSecure,
    ),
    storageFtpUsername: formValueOrDraft(
      form,
      formData,
      'storageFtpUsername',
      previousDraft.storageFtpUsername || '',
    ).trim(),
    storageFtpPassword,
    storageFtpPasswordConfigured: Boolean(
      String(storageFtpPassword || '').trim() || state.systemSettings?.storageFtpPasswordConfigured,
    ),
    backupEnabled: formCheckboxOrDraft(form, formData, 'backupEnabled', previousDraft.backupEnabled),
    backupIntervalHours: formNumberOrDraft(
      form,
      formData,
      'backupIntervalHours',
      Number(previousDraft.backupIntervalHours || 24),
    ),
    backupTarget:
      formValueOrDraft(form, formData, 'backupTarget', previousDraft.backupTarget || 'local').trim() || 'local',
    backupRetentionCount: formNumberOrDraft(
      form,
      formData,
      'backupRetentionCount',
      Number(previousDraft.backupRetentionCount || 10),
    ),
    backupContentMode:
      formValueOrDraft(
        form,
        formData,
        'backupContentMode',
        previousDraft.backupContentMode || 'database_and_site',
      ).trim() || 'database_and_site',
    backupIncludeRuntimeFiles:
      formValueOrDraft(
        form,
        formData,
        'backupContentMode',
        previousDraft.backupContentMode || 'database_and_site',
      ).trim() !== 'database_only',
    outboundProxyMode:
      formValueOrDraft(form, formData, 'outboundProxyMode', previousDraft.outboundProxyMode || 'system').trim() ||
      'system',
    outboundProxyUrl: formValueOrDraft(
      form,
      formData,
      'outboundProxyUrl',
      previousDraft.outboundProxyUrl || '',
    ).trim(),
    outboundProxyBypass: formValueOrDraft(
      form,
      formData,
      'outboundProxyBypass',
      previousDraft.outboundProxyBypass || '',
    ).trim(),
    themePresetId: normalizeSystemThemePresetId(
      String(
        formValueOrDraft(
          form,
          formData,
          'themePresetId',
          state.systemSettingsDraft?.themePresetId || 'ocean-mist',
        ),
      ),
    ),
  };
}

function updateRegistrationWhitelistDomains(domains = []) {
  state.systemSettingsDraft = {
    ...createSystemSettingsDraft(state.systemSettingsDraft || state.systemSettings),
    ...(state.systemSettingsDraft || {}),
    registrationEmailDomainWhitelist: parseRegistrationWhitelistDomains(domains),
  };
}

function addRegistrationWhitelistDomains(rawValue = '') {
  const existing = Array.isArray(state.systemSettingsDraft?.registrationEmailDomainWhitelist)
    ? state.systemSettingsDraft.registrationEmailDomainWhitelist
    : [];
  const nextDomains = parseRegistrationWhitelistDomains(rawValue);
  if (!nextDomains.length) {
    return false;
  }

  updateRegistrationWhitelistDomains([...existing, ...nextDomains]);
  state.systemRegistrationWhitelistInput = '';
  return true;
}

function removeRegistrationWhitelistDomain(domain = '') {
  const normalizedDomain = normalizeRegistrationWhitelistDomain(domain);
  if (!normalizedDomain) {
    return;
  }

  const existing = Array.isArray(state.systemSettingsDraft?.registrationEmailDomainWhitelist)
    ? state.systemSettingsDraft.registrationEmailDomainWhitelist
    : [];
  updateRegistrationWhitelistDomains(existing.filter((item) => item !== normalizedDomain));
}

function stopWorkspaceAutoRefresh() {
  if (workspaceAutoRefreshTimer) {
    clearTimeout(workspaceAutoRefreshTimer);
    workspaceAutoRefreshTimer = null;
  }
}

async function api(url, options = {}, config = {}) {
  const response = await fetch(url, {
    headers: {
      'Content-Type': 'application/json',
    },
    ...options,
  });

  let payload = {};
  try {
    payload = await response.json();
  } catch (_) {
    payload = {};
  }

  if (response.status === 401 && !config.allowUnauthorized) {
    state.user = null;
    state.ready = true;
    redraw();
    throw new Error(payload.error || '登录状态已失效，请重新登录。');
  }

  if (!response.ok) {
    throw new Error(payload.error || '请求失败');
  }

  return payload;
}

function setNotice(text, tone = 'info') {
  state.notice = text ? { text, tone } : null;
  redraw();
}

function scheduleGlobalNoticeDismiss() {
  if (globalNoticeDismissTimer) {
    window.clearTimeout(globalNoticeDismissTimer);
    globalNoticeDismissTimer = null;
  }

  if (!state.notice) {
    return;
  }

  globalNoticeDismissTimer = window.setTimeout(() => {
    globalNoticeDismissTimer = null;
    if (!state.notice) {
      return;
    }
    state.notice = null;
    redraw();
  }, 6000);
}

function setMailboxNotice(text, tone = 'info') {
  state.mailboxNotice = text ? { text, tone } : null;
  redraw();
}

function mailboxFormIsBusy() {
  const activeElement = document.activeElement;
  if (!activeElement || typeof activeElement.closest !== 'function') {
    return false;
  }

  return Boolean(activeElement.closest('[data-form="mailbox"], [data-form="mailbox-import"]'));
}

async function refreshVisibleData() {
  if (!state.user || document.hidden) {
    return;
  }

  if (searchableDropdownInputIsBusy()) {
    return;
  }

  if (mailboxDragState || mailboxDragHoldState) {
    return;
  }

  if (state.messageReaderOpen) {
    return;
  }

  if (state.view === 'inbox') {
    await loadViewData('inbox', {
      preserveSelectedMessageDetail: Boolean(state.selectedMessageId),
    });
    redraw();
    return;
  }

  if (state.view === 'dashboard') {
    await loadViewData('dashboard');
    redraw();
    return;
  }

  if (state.view === 'mailboxes') {
    if (state.mailboxModalOpen || state.mailboxImportModalOpen || mailboxFormIsBusy()) {
      return;
    }

    await loadViewData('mailboxes');
    redraw();
    return;
  }

  if (state.view === 'backups' && state.user.role === 'admin') {
    await loadViewData('backups');
    redraw();
  }
}

function scheduleWorkspaceAutoRefresh(delayMs = visibleMailboxRefreshMs()) {
  stopWorkspaceAutoRefresh();

  if (!state.user) {
    return;
  }

  workspaceAutoRefreshTimer = setTimeout(async () => {
    workspaceAutoRefreshTimer = null;

    try {
      await refreshVisibleData();
    } catch (_) {
      // Keep silent during background refresh; the next cycle can recover.
    } finally {
      if (state.user) {
        scheduleWorkspaceAutoRefresh(visibleMailboxRefreshMs());
      }
    }
  }, delayMs);
}

function notificationLabel(channel) {
  if (channel === 'template') {
    return '通知模板';
  }

  return NOTIFICATION_LABELS[channel] || channel;
}

function buildNotificationTestNotice(channel, payload = {}) {
  const result = payload?.result;
  const fallback = {
    text: `${notificationLabel(channel)}测试消息已发送。`,
    tone: 'success',
  };

  if (!result || typeof result !== 'object') {
    return fallback;
  }

  const status = String(result.status || 'sent').trim().toLowerCase() || 'sent';
  return {
    text: String(result.message || '').trim() || fallback.text,
    tone:
      status === 'warning'
        ? 'warning'
        : status === 'skipped'
          ? 'info'
          : 'success',
  };
}

const NOTIFICATION_TEMPLATE_CHANNELS = ['telegram', 'wecom', 'feishu'];
const NOTIFICATION_COVER_MODES = ['builtin', 'upload', 'url', 'none'];
const NOTIFICATION_COVER_CHANNELS = ['telegram', 'wecomApp'];
const NOTIFICATION_COVER_DELIVERY_MODES = ['cover', 'plain'];
const BUILTIN_NOTIFICATION_COVER_ASSET_PATHS = Object.freeze({
  verification: 'builtin/notification-covers/verification-mail.png',
  order: 'builtin/notification-covers/order-mail.png',
  subscription: 'builtin/notification-covers/subscription-mail.png',
  marketing: 'builtin/notification-covers/marketing-mail.png',
  junk: 'builtin/notification-covers/junk-mail.png',
  standard: 'builtin/notification-covers/standard-mail.png',
});
const BUILTIN_NOTIFICATION_COVER_ASSET_URLS = Object.freeze({
  verification: '/assets/notification-covers/verification-mail.png',
  order: '/assets/notification-covers/order-mail.png',
  subscription: '/assets/notification-covers/subscription-mail.png',
  marketing: '/assets/notification-covers/marketing-mail.png',
  junk: '/assets/notification-covers/junk-mail.png',
  standard: '/assets/notification-covers/standard-mail.png',
});

function notificationCoverFieldPrefix(category = 'standard') {
  const normalized = String(category || 'standard').trim();
  return `cover${normalized.slice(0, 1).toUpperCase()}${normalized.slice(1)}`;
}

function notificationCoverChannelFieldName(channel = 'telegram') {
  const normalized = String(channel || 'telegram').trim();
  return `coverChannel${normalized.slice(0, 1).toUpperCase()}${normalized.slice(1)}`;
}

function normalizeNotificationCoverMode(mode = 'builtin') {
  const normalized = String(mode || 'builtin').trim().toLowerCase();
  if (normalized === 'auto') {
    return 'builtin';
  }
  return NOTIFICATION_COVER_MODES.includes(normalized) ? normalized : 'builtin';
}

function notificationCoverCategoryFromFieldName(name = '') {
  const normalized = String(name || '').trim();
  return (
    NOTIFICATION_COVER_CATEGORIES.find((category) => normalized.startsWith(notificationCoverFieldPrefix(category))) ||
    ''
  );
}

function notificationCoverBuiltinAssetPath(category = 'standard') {
  return BUILTIN_NOTIFICATION_COVER_ASSET_PATHS[String(category || 'standard').trim()] || BUILTIN_NOTIFICATION_COVER_ASSET_PATHS.standard;
}

function notificationCoverBuiltinAssetUrl(category = 'standard') {
  return BUILTIN_NOTIFICATION_COVER_ASSET_URLS[String(category || 'standard').trim()] || BUILTIN_NOTIFICATION_COVER_ASSET_URLS.standard;
}

function notificationCoverAssetUrlFromPath(assetPath = '') {
  const normalized = String(assetPath || '').trim().replace(/\\/g, '/');
  if (!normalized) {
    return '';
  }

  if (normalized.startsWith('builtin/notification-covers/')) {
    return `/assets/notification-covers/${encodeURIComponent(normalized.split('/').pop() || '')}`;
  }

  return `/files/${normalized.split('/').map((segment) => encodeURIComponent(segment)).join('/')}`;
}

function defaultNotificationTemplateOptions() {
  return {
    translateToChinese: false,
    previewBaseUrl: '',
    coverEnabled: true,
    coverChannels: {
      telegram: 'cover',
      wecomApp: 'cover',
    },
    covers: Object.fromEntries(
      NOTIFICATION_COVER_CATEGORIES.map((category) => [
        category,
        {
          mode: 'builtin',
          url: '',
          assetPath: notificationCoverBuiltinAssetPath(category),
          assetUrl: notificationCoverBuiltinAssetUrl(category),
          assetLocalPath: '',
          uploadFilename: '',
          uploadDataUrl: '',
        },
      ]),
    ),
  };
}

function cloneNotificationTemplateOptions(options = null) {
  const defaults = defaultNotificationTemplateOptions();
  const source = options && typeof options === 'object' ? options : {};
  return {
    translateToChinese: Object.prototype.hasOwnProperty.call(source, 'translateToChinese')
      ? Boolean(source.translateToChinese)
      : defaults.translateToChinese,
    previewBaseUrl: String(source.previewBaseUrl || defaults.previewBaseUrl).trim(),
    coverEnabled: Object.prototype.hasOwnProperty.call(source, 'coverEnabled')
      ? Boolean(source.coverEnabled)
      : defaults.coverEnabled,
    coverChannels: Object.fromEntries(
      NOTIFICATION_COVER_CHANNELS.map((channel) => {
        const mode = String(source?.coverChannels?.[channel] || defaults.coverChannels[channel] || 'cover').trim().toLowerCase();
        return [channel, NOTIFICATION_COVER_DELIVERY_MODES.includes(mode) ? mode : 'cover'];
      }),
    ),
    covers: Object.fromEntries(
      NOTIFICATION_COVER_CATEGORIES.map((category) => {
        const current = source?.covers?.[category] || {};
        const fallback = defaults.covers[category] || {};
        const mode = normalizeNotificationCoverMode(
          Object.prototype.hasOwnProperty.call(current, 'mode') ? current.mode : fallback.mode || 'builtin',
        );
        const assetPath = String(
          Object.prototype.hasOwnProperty.call(current, 'assetPath') ? current.assetPath : fallback.assetPath || '',
        ).trim();
        const derivedAssetUrl =
          mode === 'builtin'
            ? notificationCoverBuiltinAssetUrl(category)
            : notificationCoverAssetUrlFromPath(assetPath);
        return [
          category,
          {
            mode,
            url: String(
              Object.prototype.hasOwnProperty.call(current, 'url') ? current.url : fallback.url || '',
            ).trim(),
            assetPath,
            assetUrl: String(
              Object.prototype.hasOwnProperty.call(current, 'assetUrl') ? current.assetUrl : derivedAssetUrl,
            ).trim() || derivedAssetUrl,
            assetLocalPath: String(
              Object.prototype.hasOwnProperty.call(current, 'assetLocalPath')
                ? current.assetLocalPath
                : fallback.assetLocalPath || '',
            ).trim(),
            uploadFilename: String(
              Object.prototype.hasOwnProperty.call(current, 'uploadFilename')
                ? current.uploadFilename
                : fallback.uploadFilename || '',
            ).trim(),
            uploadDataUrl: String(
              Object.prototype.hasOwnProperty.call(current, 'uploadDataUrl')
                ? current.uploadDataUrl
                : fallback.uploadDataUrl || '',
            ).trim(),
          },
        ];
      }),
    ),
  };
}

function syncNotificationTemplateOptionsDraft(options = {}) {
  const { force = false } = options || {};
  if (!force && state.notificationTemplateOptionsDraft) {
    return state.notificationTemplateOptionsDraft;
  }
  state.notificationTemplateOptionsDraft = cloneNotificationTemplateOptions(state.notifications?.template?.options);
  return state.notificationTemplateOptionsDraft;
}

function syncNotificationTemplateOptionsDraftFromForm(form) {
  if (!form) {
    return state.notificationTemplateOptionsDraft;
  }
  state.notificationTemplateOptionsDraft = cloneNotificationTemplateOptions(notificationTemplateOptionsFromForm(form));
  return state.notificationTemplateOptionsDraft;
}

function notificationTemplateSetting() {
  const base = state.notifications?.template || {
    presetId: 'default',
    templates: {
      telegram: '',
      wecom: '',
      feishu: '',
    },
    options: defaultNotificationTemplateOptions(),
    presets: [],
    sample: {},
  };

  return {
    ...base,
    options: cloneNotificationTemplateOptions(state.notificationTemplateOptionsDraft || base.options),
  };
}

function notificationTemplatePreset(presetId) {
  const template = notificationTemplateSetting();
  return (
    template.presets?.find((preset) => preset.id === presetId) ||
    template.presets?.[0] || {
      templates: {},
      name: '默认简洁',
    }
  );
}

function normalizeTemplateDraftText(value) {
  return String(value || '').replace(/\r\n?/g, '\n');
}

function templateChannelUsesPresetDefault(channel, draft) {
  const preset = notificationTemplatePreset(draft?.presetId || notificationTemplateSetting().presetId);
  const currentValue = normalizeTemplateDraftText(draft?.templates?.[channel] || '');
  const presetValue = normalizeTemplateDraftText(preset.templates?.[channel] || '');
  return !currentValue.trim() || currentValue === presetValue;
}

function templateFormDraft(form) {
  return {
    presetId: form?.querySelector('[name="presetId"]')?.value || notificationTemplateSetting().presetId || 'default',
    templates: Object.fromEntries(
      NOTIFICATION_TEMPLATE_CHANNELS.map((channel) => [
        channel,
        form?.querySelector(`[name="${channel}"]`)?.value || '',
      ]),
    ),
  };
}

function notificationTemplateOptionsFromForm(form) {
  const mergeMode = String(form?.dataset?.templateOptionsMerge || '').trim().toLowerCase();
  const current =
    mergeMode === 'saved'
      ? cloneNotificationTemplateOptions(state.notifications?.template?.options)
      : notificationTemplateSetting().options || {};
  const coverChannels = Object.fromEntries(
    NOTIFICATION_COVER_CHANNELS.map((channel) => {
      const fieldName = notificationCoverChannelFieldName(channel);
      const mode = String(
        form?.querySelector(`[name="${fieldName}"]`)?.value || current?.coverChannels?.[channel] || 'cover',
      ).trim().toLowerCase();
      return [channel, NOTIFICATION_COVER_DELIVERY_MODES.includes(mode) ? mode : 'cover'];
    }),
  );
  const covers = Object.fromEntries(
    NOTIFICATION_COVER_CATEGORIES.map((category) => {
      const prefix = notificationCoverFieldPrefix(category);
      const currentCover = current?.covers?.[category] || {};
      const normalizedMode = normalizeNotificationCoverMode(
        form?.querySelector(`[name="${prefix}Mode"]`)?.value || currentCover.mode || 'builtin',
      );

      return [
        category,
        {
          mode: normalizedMode,
          url: String(form?.querySelector(`[name="${prefix}Url"]`)?.value || currentCover.url || '').trim(),
          uploadDataUrl: String(form?.querySelector(`[name="${prefix}UploadDataUrl"]`)?.value || '').trim(),
          uploadFilename: String(
            form?.querySelector(`[name="${prefix}UploadFilename"]`)?.value || currentCover.uploadFilename || '',
          ).trim(),
          assetPath: String(
            form?.querySelector(`[name="${prefix}AssetPath"]`)?.value || currentCover.assetPath || '',
          ).trim(),
        },
      ];
    }),
  );

  return {
    translateToChinese:
      form?.querySelector('[name="translateToChinese"]')?.checked ?? Boolean(current.translateToChinese),
    previewBaseUrl:
      String(form?.querySelector('[name="previewBaseUrl"]')?.value || current.previewBaseUrl || '').trim(),
    coverEnabled:
      form?.querySelector('[name="coverEnabled"]')?.checked ?? (current.coverEnabled ?? true),
    coverChannels,
    covers,
  };
}

function resolveTemplatePreviewText(channel, draft) {
  const template = notificationTemplateSetting();
  const preset = notificationTemplatePreset(draft?.presetId || template.presetId);
  const sample = template.sample || {};
  const source = templateChannelUsesPresetDefault(channel, draft)
    ? String(preset.templates?.[channel] || '')
    : String(draft?.templates?.[channel] || '');

  return String(source || '')
    .replaceAll('{subject}', sample.subject || '')
    .replaceAll('{from}', sample.from || '')
    .replaceAll('{mailbox}', sample.mailbox || '')
    .replaceAll('{time}', sample.time || '')
    .replaceAll('{summary}', sample.summary || '');
}

function updateNotificationTemplatePreview(form = document.querySelector('[data-form="notification-template"]')) {
  if (!form) {
    return;
  }

  const draft = templateFormDraft(form);
  const preset = notificationTemplatePreset(draft.presetId);

  for (const card of form.querySelectorAll('.template-preset-card')) {
    card.classList.toggle('active', card.dataset.presetId === draft.presetId);
  }

  const currentPresetTag = form.closest('.template-panel')?.querySelector('.template-panel-meta .tag');
  if (currentPresetTag) {
    currentPresetTag.textContent = preset.name || '默认简洁';
  }

  for (const channel of NOTIFICATION_TEMPLATE_CHANNELS) {
    const stateTag = form.querySelector(`[data-template-state="${channel}"]`);
    if (stateTag) {
      stateTag.textContent = templateChannelUsesPresetDefault(channel, draft) ? '使用预设默认' : '已自定义';
    }

    const previewTag = form.querySelector(`[data-template-preview="${channel}"]`);
    if (previewTag) {
      previewTag.textContent = resolveTemplatePreviewText(channel, draft);
    }

    const previewBadge = form
      .querySelector(`[data-template-preview="${channel}"]`)
      ?.closest('.template-preview-card')
      ?.querySelector('.tag');
    if (previewBadge) {
      previewBadge.textContent = templateChannelUsesPresetDefault(channel, draft) ? '预览预设默认' : '预览自定义文案';
    }
  }
}

function setNotificationTemplatePreset(presetId) {
  const form = document.querySelector('[data-form="notification-template"]');
  if (!form) {
    return;
  }

  const input = form.querySelector('[name="presetId"]');
  if (!input) {
    return;
  }

  input.value = presetId || notificationTemplateSetting().presetId || 'default';
  loadNotificationTemplatePreset(form);
}

function loadNotificationTemplatePreset(form = document.querySelector('[data-form="notification-template"]')) {
  if (!form) {
    return;
  }

  const preset = notificationTemplatePreset(
    form.querySelector('[name="presetId"]')?.value || notificationTemplateSetting().presetId,
  );

  for (const channel of NOTIFICATION_TEMPLATE_CHANNELS) {
    const input = form.querySelector(`[name="${channel}"]`);
    if (input) {
      input.value = String(preset.templates?.[channel] || '');
    }
  }

  updateNotificationTemplatePreview(form);
}

function clearNotificationTemplateOverrides(form = document.querySelector('[data-form="notification-template"]')) {
  if (!form) {
    return;
  }

  for (const channel of NOTIFICATION_TEMPLATE_CHANNELS) {
    const input = form.querySelector(`[name="${channel}"]`);
    if (input) {
      input.value = '';
    }
  }

  updateNotificationTemplatePreview(form);
}

function stopWecomDiscoveryAutoRefresh() {
  if (wecomDiscoveryRefreshTimer) {
    clearTimeout(wecomDiscoveryRefreshTimer);
    wecomDiscoveryRefreshTimer = null;
  }
}

function startWecomDiscoveryAutoRefresh(rounds = 5, delayMs = 1500) {
  stopWecomDiscoveryAutoRefresh();

  if (
    !state.user
    || state.view !== 'notifications'
    || rounds <= 0
    || !Boolean(state.notifications?.wecom?.botReady)
  ) {
    return;
  }

  const tick = async (remaining) => {
    if (!state.user || state.view !== 'notifications') {
      stopWecomDiscoveryAutoRefresh();
      return;
    }

    try {
      await loadNotifications();
      redraw();
    } catch (_) {
      // Ignore transient polling failures and keep the current UI usable.
    }

    if (remaining <= 1) {
      wecomDiscoveryRefreshTimer = null;
      return;
    }

    wecomDiscoveryRefreshTimer = setTimeout(() => {
      tick(remaining - 1);
    }, delayMs);
  };

  wecomDiscoveryRefreshTimer = setTimeout(() => {
    tick(rounds);
  }, delayMs);
}

function providerPreset(providerId) {
  return state.providers.find((provider) => provider.id === providerId) || state.providers[0];
}

function defaultMailboxProviderId() {
  return state.providers.find((provider) => provider.id === 'gmail')?.id || state.providers[0]?.id || 'generic';
}

function createMailboxDraft(providerId = defaultMailboxProviderId()) {
  const preset = providerPreset(providerId) || {};
  const isOutlookProvider = String(providerId || '').trim().toLowerCase() === 'outlook';
  return {
    mailboxId: '',
    ownerUserId: state.selectedOwnerUserId || state.user?.id || '',
    provider: providerId,
    authType: defaultAuthTypeForProvider(providerId),
    name: '',
    email: '',
    username: '',
    password: '',
    googleClientId: '',
    googleClientSecret: '',
    microsoftClientId: systemMicrosoftClientId(),
    microsoftClientSecret: '',
    microsoftTenantId: systemMicrosoftTenantId(),
    microsoftProtocolMode: isOutlookProvider ? 'graph_only' : 'graph_imap_dual',
    microsoftRefreshToken: '',
    microsoftGraphRefreshToken: '',
    microsoftImapRefreshToken: '',
    syncAttachments: true,
    oauthEmail: '',
    oauthConfigured: false,
    oauthGraphReady: false,
    oauthImapReady: false,
    imapHost: preset.imapHost || '',
    imapPort: Number(preset.imapPort || 993),
    syncIntervalSeconds: 5,
    sortOrder: 100,
    isPinned: false,
    secure: Boolean(preset.secure),
  };
}

function createMailboxDraftFromMailbox(mailbox) {
  return {
    mailboxId: mailbox.id,
    ownerUserId: mailbox.ownerUserId || state.user?.id || '',
    provider: mailbox.provider || defaultMailboxProviderId(),
    authType: mailbox.authType || defaultAuthTypeForProvider(mailbox.provider),
    name: mailbox.name || '',
    email: mailbox.email || '',
    username: mailbox.username || '',
    password: '',
    googleClientId: mailbox.oauthClientId || '',
    googleClientSecret: '',
    microsoftClientId: systemMicrosoftClientId() || mailbox.oauthClientId || '',
    microsoftClientSecret: '',
    microsoftTenantId: systemMicrosoftTenantId() || mailbox.oauthTenantId || 'common',
    microsoftProtocolMode: normalizeMicrosoftProtocolMode(mailbox.oauthProtocolMode || 'graph_imap_dual'),
    microsoftRefreshToken: '',
    microsoftGraphRefreshToken: '',
    microsoftImapRefreshToken: '',
    syncAttachments: mailbox.syncAttachments !== undefined ? Boolean(mailbox.syncAttachments) : true,
    oauthEmail: mailbox.oauthEmail || mailbox.email || '',
    oauthConfigured: Boolean(mailbox.oauthConfigured),
    oauthGraphReady: Boolean(mailbox.oauthGraphReady),
    oauthImapReady: Boolean(mailbox.oauthImapReady),
    imapHost: mailbox.imapHost || '',
    imapPort: Number(mailbox.imapPort || 993),
    syncIntervalSeconds: Number(mailbox.syncIntervalSeconds || 5),
    sortOrder: Number(mailbox.sortOrder ?? 100),
    isPinned: Boolean(mailbox.isPinned),
    secure: Boolean(mailbox.secure),
  };
}

function createMailboxImportDraft() {
  return {
    ownerUserId: state.selectedOwnerUserId || state.user?.id || '',
    importText: '',
    microsoftClientSecret: '',
    microsoftTenantId: systemMicrosoftTenantId(),
    microsoftProtocolMode: 'graph_only',
    imapHost: 'outlook.office365.com',
    imapPort: 993,
    secure: true,
    syncIntervalSeconds: 5,
    sortOrder: 100,
    isPinned: false,
  };
}

function ensureMailboxDraft() {
  if (!state.user) {
    return;
  }

  if (!state.mailboxDraft) {
    state.mailboxDraft = createMailboxDraft();
    return;
  }

  if (!state.mailboxDraft.provider) {
    state.mailboxDraft.provider = defaultMailboxProviderId();
  }

  if (!state.mailboxDraft.authType) {
    state.mailboxDraft.authType = defaultAuthTypeForProvider(state.mailboxDraft.provider);
  }

  if (!state.mailboxDraft.microsoftProtocolMode) {
    state.mailboxDraft.microsoftProtocolMode = 'graph_imap_dual';
  }

  if (!state.mailboxDraft.microsoftClientId && isSystemMicrosoftConfigured()) {
    state.mailboxDraft.microsoftClientId = systemMicrosoftClientId();
  }

  if (!state.mailboxDraft.microsoftTenantId) {
    state.mailboxDraft.microsoftTenantId = systemMicrosoftTenantId();
  }

  if (!state.editingMailboxId && !state.mailboxDraft.ownerUserId) {
    state.mailboxDraft.ownerUserId = state.selectedOwnerUserId || state.user.id;
  }
}

function resetMailboxComposer() {
  state.mailboxModalOpen = false;
  state.mailboxGuideOpen = false;
  state.mailboxPasswordVisible = false;
  state.mailboxOwnerFilterOpen = false;
  state.mailboxOwnerSearch = '';
  state.editingMailboxId = null;
  state.mailboxDraft = createMailboxDraft();
  state.mailboxNotice = null;
  shouldFocusMailboxOwnerSearch = false;
}

function resetMailboxImportComposer() {
  state.mailboxImportModalOpen = false;
  state.mailboxImportDraft = createMailboxImportDraft();
  state.mailboxImportNotice = null;
}

function openMailboxCreateModal(providerId = defaultMailboxProviderId()) {
  state.mailboxModalOpen = true;
  state.mailboxGuideOpen = false;
  state.mailboxPasswordVisible = false;
  state.mailboxOwnerFilterOpen = false;
  state.mailboxOwnerSearch = '';
  state.editingMailboxId = null;
  state.mailboxDraft = createMailboxDraft(providerId);
  state.mailboxNotice = null;
  shouldFocusMailboxOwnerSearch = false;
}

function openMicrosoftMailboxImportModal() {
  const baseDraft = createMailboxImportDraft();
  const mailboxDraft = state.mailboxDraft || {};
  state.mailboxModalOpen = false;
  state.mailboxGuideOpen = false;
  state.mailboxPasswordVisible = false;
  state.mailboxImportModalOpen = true;
  state.mailboxImportDraft = {
    ...baseDraft,
    ownerUserId: mailboxDraft.ownerUserId || baseDraft.ownerUserId,
    microsoftClientSecret: mailboxDraft.microsoftClientSecret || baseDraft.microsoftClientSecret,
    microsoftTenantId: mailboxDraft.microsoftTenantId || baseDraft.microsoftTenantId,
    microsoftProtocolMode: normalizeMicrosoftProtocolMode(
      mailboxDraft.microsoftProtocolMode || baseDraft.microsoftProtocolMode,
    ),
    imapHost: mailboxDraft.imapHost || baseDraft.imapHost,
    imapPort: Number(mailboxDraft.imapPort || baseDraft.imapPort || 993),
    secure: Object.prototype.hasOwnProperty.call(mailboxDraft, 'secure')
      ? Boolean(mailboxDraft.secure)
      : baseDraft.secure,
    syncIntervalSeconds: Number(mailboxDraft.syncIntervalSeconds || baseDraft.syncIntervalSeconds || 5),
    sortOrder: Number(mailboxDraft.sortOrder ?? baseDraft.sortOrder ?? 100),
    isPinned: Object.prototype.hasOwnProperty.call(mailboxDraft, 'isPinned')
      ? Boolean(mailboxDraft.isPinned)
      : baseDraft.isPinned,
  };
  state.mailboxImportNotice = null;
}

function closeMailboxModal() {
  resetMailboxComposer();
}

function closeMailboxImportModal() {
  resetMailboxImportComposer();
}

function openMailboxGuide() {
  if (!state.mailboxModalOpen) {
    return;
  }

  state.mailboxGuideOpen = true;
}

function closeMailboxGuide() {
  state.mailboxGuideOpen = false;
}

function openNotificationGuide(channel = '') {
  state.notificationGuideChannel = String(channel || '').trim().toLowerCase();
}

function closeNotificationGuide() {
  state.notificationGuideChannel = '';
}

function openNotificationEmojiGuide() {
  state.notificationEmojiGuideOpen = true;
}

function closeNotificationEmojiGuide() {
  state.notificationEmojiGuideOpen = false;
}

function openSystemGoogleGuide() {
  state.systemMicrosoftGuideOpen = false;
  state.systemGoogleGuideOpen = true;
}

function closeSystemGoogleGuide() {
  state.systemGoogleGuideOpen = false;
}

function openSystemMicrosoftGuide() {
  state.systemGoogleGuideOpen = false;
  state.systemMicrosoftGuideOpen = true;
}

function closeSystemMicrosoftGuide() {
  state.systemMicrosoftGuideOpen = false;
}

async function toggleMailboxPasswordVisibility() {
  if (!state.mailboxModalOpen) {
    return;
  }

  if (state.mailboxPasswordVisible) {
    state.mailboxPasswordVisible = false;
    redraw();
    return;
  }

  const form = document.querySelector('[data-form="mailbox"]');
  if (form) {
    syncMailboxDraftFromForm(form);
  }

  const needsStoredPassword =
    !String(state.mailboxDraft?.password || '').trim() &&
    Boolean(state.mailboxDraft?.mailboxId || state.editingMailboxId) &&
    String(state.mailboxDraft?.authType || 'password').trim() === 'password';

  if (needsStoredPassword) {
    const mailboxId = state.mailboxDraft?.mailboxId || state.editingMailboxId;
    const data = await api(`/api/mailboxes/${mailboxId}/password`, {
      method: 'POST',
      body: '{}',
    });
    state.mailboxDraft.password = String(data.password || '');
  }

  state.mailboxPasswordVisible = true;
  redraw();
}

function openUserComposer(userId = '') {
  state.editingUserId = userId || null;
  state.userModalOpen = true;
}

function closeUserComposer() {
  state.editingUserId = null;
  state.userModalOpen = false;
}

function isMailboxInteraction(element) {
  return Boolean(
    element?.closest?.('[data-form="mailbox"], [data-form="mailbox-import"], [data-form="mailbox-interval"], .mailbox-modal, .mailbox-row-card'),
  );
}

function syncMailboxDraftFromForm(form) {
  if (!form || !state.user) {
    return;
  }

  const formData = new FormData(form);
  const provider = String(formData.get('provider') || defaultMailboxProviderId());
  const preset = providerPreset(provider) || {};
  const currentDraft = state.mailboxDraft || {};

  state.mailboxDraft = {
    mailboxId: String(formData.get('mailboxId') || ''),
    ownerUserId: String(formData.get('ownerUserId') || state.user.id),
    provider,
    authType: ['gmail', 'outlook'].includes(provider)
      ? String(formData.get('authType') || defaultAuthTypeForProvider(provider))
      : 'password',
    name: String(formData.get('name') || ''),
    email: String(formData.get('email') || ''),
    username: String(formData.get('username') || ''),
    password: String(formData.get('password') || ''),
    googleClientId: formValueOrFallback(formData, 'googleClientId', currentDraft.googleClientId || ''),
    googleClientSecret: formValueOrFallback(formData, 'googleClientSecret', currentDraft.googleClientSecret || ''),
    microsoftClientId: formValueOrFallback(
      formData,
      'microsoftClientId',
      currentDraft.microsoftClientId || systemMicrosoftClientId(),
    ),
    microsoftClientSecret: formValueOrFallback(
      formData,
      'microsoftClientSecret',
      currentDraft.microsoftClientSecret || '',
    ),
    microsoftTenantId: formValueOrFallback(
      formData,
      'microsoftTenantId',
      currentDraft.microsoftTenantId || systemMicrosoftTenantId(),
    ),
    microsoftProtocolMode: normalizeMicrosoftProtocolMode(
      formData.get('microsoftProtocolMode') || (provider === 'outlook' ? 'graph_only' : 'graph_imap_dual'),
    ),
    microsoftRefreshToken: String(formData.get('microsoftRefreshToken') || ''),
    microsoftGraphRefreshToken: String(formData.get('microsoftGraphRefreshToken') || ''),
    microsoftImapRefreshToken: String(formData.get('microsoftImapRefreshToken') || ''),
    oauthEmail: String(formData.get('oauthEmail') || ''),
    oauthConfigured:
      formData.get('oauthConfigured') === 'true' || formData.get('oauthConfigured') === '1',
    oauthGraphReady:
      formData.get('oauthGraphReady') === 'true' || formData.get('oauthGraphReady') === '1',
    oauthImapReady:
      formData.get('oauthImapReady') === 'true' || formData.get('oauthImapReady') === '1',
    imapHost: String(formData.get('imapHost') || preset.imapHost || ''),
    imapPort: Number(formData.get('imapPort') || preset.imapPort || 993),
    syncAttachments: formData.get('syncAttachments') === 'on',
    syncIntervalSeconds: Number(formData.get('syncIntervalSeconds') || 5),
    sortOrder: Number(formData.get('sortOrder') || 100),
    isPinned: formData.get('isPinned') === 'on',
    secure: formData.get('secure') === 'on',
  };

  if (
    provider === 'outlook' &&
    normalizeMicrosoftProtocolMode(state.mailboxDraft.microsoftProtocolMode) !== 'graph_only' &&
    isSystemMicrosoftConfigured()
  ) {
    state.mailboxDraft.microsoftClientId = systemMicrosoftClientId();
    state.mailboxDraft.microsoftTenantId = systemMicrosoftTenantId();
  }
}

function mailboxPayloadFromForm(form) {
  syncMailboxDraftFromForm(form);

  return {
    mailboxId: state.mailboxDraft?.mailboxId || '',
    ownerUserId: state.mailboxDraft?.ownerUserId || state.user.id,
    provider: state.mailboxDraft?.provider || defaultMailboxProviderId(),
    authType: state.mailboxDraft?.authType || 'password',
    name: state.mailboxDraft?.name || '',
    email: state.mailboxDraft?.email || '',
    username: state.mailboxDraft?.username || '',
    password: state.mailboxDraft?.password || '',
    googleClientId: state.mailboxDraft?.googleClientId || '',
    googleClientSecret: state.mailboxDraft?.googleClientSecret || '',
    microsoftClientId: state.mailboxDraft?.microsoftClientId || '',
    microsoftClientSecret: state.mailboxDraft?.microsoftClientSecret || '',
    microsoftTenantId: state.mailboxDraft?.microsoftTenantId || 'common',
    microsoftProtocolMode: state.mailboxDraft?.microsoftProtocolMode || 'graph_imap_dual',
    microsoftRefreshToken: state.mailboxDraft?.microsoftRefreshToken || '',
    microsoftGraphRefreshToken: state.mailboxDraft?.microsoftGraphRefreshToken || '',
    microsoftImapRefreshToken: state.mailboxDraft?.microsoftImapRefreshToken || '',
    oauthEmail: state.mailboxDraft?.oauthEmail || '',
    oauthConfigured: Boolean(state.mailboxDraft?.oauthConfigured),
    oauthGraphReady: Boolean(state.mailboxDraft?.oauthGraphReady),
    oauthImapReady: Boolean(state.mailboxDraft?.oauthImapReady),
    imapHost: state.mailboxDraft?.imapHost || '',
    imapPort: Number(state.mailboxDraft?.imapPort || 993),
    syncAttachments: Boolean(state.mailboxDraft?.syncAttachments),
    syncIntervalSeconds: Number(state.mailboxDraft?.syncIntervalSeconds || 5),
    sortOrder: Number(state.mailboxDraft?.sortOrder ?? 100),
    isPinned: Boolean(state.mailboxDraft?.isPinned),
    secure: Boolean(state.mailboxDraft?.secure),
  };
}

async function updateMailboxDisplay(mailboxId, input = {}) {
  const payload = {};
  if (input.sortOrder !== undefined) {
    payload.sortOrder = Number(input.sortOrder);
  }
  if (input.isPinned !== undefined) {
    payload.isPinned = Boolean(input.isPinned);
  }

  return api(`/api/mailboxes/${mailboxId}/display`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  });
}

function isGmailOauthPayload(payload) {
  return String(payload?.provider || '').trim() === 'gmail' &&
    String(payload?.authType || '').trim() === 'gmail_oauth';
}

function isMicrosoftOauthPayload(payload) {
  return String(payload?.provider || '').trim() === 'outlook' &&
    String(payload?.authType || '').trim() === 'microsoft_oauth';
}

function shouldStartGoogleOauth(payload) {
  if (!isGmailOauthPayload(payload)) {
    return false;
  }

  const existingMailbox = payload.mailboxId
    ? state.mailboxes.find((mailbox) => mailbox.id === payload.mailboxId) || null
    : null;
  const clientIdChanged =
    Boolean(payload.googleClientId) &&
    String(payload.googleClientId || '').trim() !== String(existingMailbox?.oauthClientId || '').trim();

  return (
    !payload.mailboxId ||
    !Boolean(state.mailboxDraft?.oauthConfigured) ||
    clientIdChanged ||
    Boolean(payload.googleClientSecret)
  );
}

function shouldStartMicrosoftOauth(payload) {
  if (!isMicrosoftOauthPayload(payload)) {
    return false;
  }
  if (hasManualMicrosoftRefreshToken(payload)) {
    return false;
  }
  if (normalizeMicrosoftProtocolMode(payload.microsoftProtocolMode) === 'graph_only') {
    return false;
  }

  const existingMailbox = payload.mailboxId
    ? state.mailboxes.find((mailbox) => mailbox.id === payload.mailboxId) || null
    : null;
  const clientIdChanged =
    Boolean(payload.microsoftClientId) &&
    String(payload.microsoftClientId || '').trim() !== String(existingMailbox?.oauthClientId || '').trim();
  const tenantChanged =
    String(payload.microsoftTenantId || 'common').trim().toLowerCase() !==
    String(existingMailbox?.oauthTenantId || 'common').trim().toLowerCase();

  return (
    !payload.mailboxId ||
    !Boolean(state.mailboxDraft?.oauthConfigured) ||
    clientIdChanged ||
    tenantChanged ||
    Boolean(payload.microsoftClientSecret)
  );
}

async function waitForOauthResult(pathname, requestId, popupWindow = null, failureLabel = 'OAuth2') {
  const startedAt = Date.now();

  while (Date.now() - startedAt < 180000) {
    const data = await api(`${pathname}?requestId=${encodeURIComponent(requestId)}`);

    if (data.status === 'completed' || data.status === 'completed_with_warning') {
      try {
        popupWindow?.close();
      } catch (_) {
        // Ignore popup close failures.
      }

      return data;
    }

    if (data.status === 'error') {
      try {
        popupWindow?.close();
      } catch (_) {
        // Ignore popup close failures.
      }

      throw new Error(data.error || `${failureLabel} 授权失败。`);
    }

    await new Promise((resolve) => window.setTimeout(resolve, 1200));
  }

  try {
    popupWindow?.close();
  } catch (_) {
    // Ignore popup close failures.
  }

  throw new Error(`等待${failureLabel}授权超时，请重新尝试。`);
}

async function startOauthPopup(authorizeUrl, popupName) {
  let popupWindow = null;
  let popupError = null;

  try {
    popupWindow = window.open(
      authorizeUrl,
      popupName,
      'popup=yes,width=560,height=720,resizable=yes,scrollbars=yes',
    );
  } catch (error) {
    popupError = error;
  }

  if (popupWindow) {
    try {
      popupWindow.focus();
    } catch (_) {
      // Ignore focus failures and continue polling.
    }

    return popupWindow;
  }

  try {
    window.location.assign(authorizeUrl);
    return null;
  } catch (fallbackError) {
    const detail = String(
      fallbackError?.message || popupError?.message || '',
    ).trim();
    let copied = false;

    try {
      await navigator.clipboard.writeText(authorizeUrl);
      copied = true;
    } catch (_) {
      copied = false;
    }

    throw new Error(
      copied
        ? detail
          ? `无法自动打开授权页面，授权链接已复制到剪贴板，请手动打开后继续。底层错误：${detail}`
          : '无法自动打开授权页面，授权链接已复制到剪贴板，请手动打开后继续。'
        : detail
          ? `无法自动打开授权页面，请允许当前站点弹窗，或手动打开授权链接后继续：${authorizeUrl}。底层错误：${detail}`
          : `无法自动打开授权页面，请允许当前站点弹窗，或手动打开授权链接后继续：${authorizeUrl}`,
    );
  }
}

async function startGoogleOauthForMailbox(form = document.querySelector('[data-form="mailbox"]')) {
  if (!form) {
    throw new Error('未找到邮箱表单。');
  }

  const payload = mailboxPayloadFromForm(form);
  if (!isGmailOauthPayload(payload)) {
    throw new Error('当前邮箱并没有使用 Google OAuth2 模式。');
  }

  const data = await api('/api/oauth/google/start', {
    method: 'POST',
    body: JSON.stringify({
      ...payload,
      portalPath: state.portalPath,
      publicBaseUrl: window.location.origin,
    }),
  });

  setMailboxNotice('Google 授权页已打开，完成授权后系统会自动返回并回填结果。', 'info');
  const popupWindow = await startOauthPopup(data.authorizeUrl, 'mail-union-google-oauth');
  if (!popupWindow) {
    return null;
  }
  const result = await waitForOauthResult('/api/oauth/google/status', data.requestId, popupWindow, 'Google OAuth2');

  state.notice = {
    text: payload.mailboxId
      ? `Gmail 已重新完成 Google 授权，并同步了 ${result.email || '当前账号'}。`
      : `Gmail 已通过 Google OAuth2 接入，并同步了 ${result.email || '当前账号'}。`,
    tone: 'success',
  };
  if (result.warning) {
    state.notice = {
      text: `Gmail 已完成 Google OAuth2 授权，但首次同步失败：${result.warning}`,
      tone: 'info',
    };
  }
  resetMailboxComposer();
  redraw();
  await refreshWorkspace();
  return result;
}

async function startMicrosoftOauthForMailbox(form = document.querySelector('[data-form="mailbox"]')) {
  if (!form) {
    throw new Error('未找到邮箱表单。');
  }

  const payload = mailboxPayloadFromForm(form);
  if (!isMicrosoftOauthPayload(payload)) {
    throw new Error('当前邮箱并没有使用 Microsoft OAuth2 模式。');
  }
  if (!isSystemMicrosoftConfigured() && !String(payload.microsoftClientId || '').trim()) {
    throw new Error(
      state.user?.role === 'admin'
        ? '请先到系统设置完成 Microsoft 应用配置，再回来连接 Outlook。'
        : '当前系统尚未配置 Microsoft 应用，请联系管理员处理。',
    );
  }
  if (normalizeMicrosoftProtocolMode(payload.microsoftProtocolMode) === 'graph_only') {
    throw new Error('Graph-only 模式请直接填写 refresh token，或改成双协议 / IMAP 模式后再点“连接 Microsoft”。');
  }

  const data = await api('/api/oauth/microsoft/start', {
    method: 'POST',
    body: JSON.stringify({
      ...payload,
      portalPath: state.portalPath,
      publicBaseUrl: window.location.origin,
    }),
  });

  setMailboxNotice('Microsoft 授权页已打开，完成授权后系统会自动返回并回填结果。', 'info');
  const popupWindow = await startOauthPopup(data.authorizeUrl, 'mail-union-microsoft-oauth');
  if (!popupWindow) {
    return null;
  }
  const result = await waitForOauthResult('/api/oauth/microsoft/status', data.requestId, popupWindow, 'Microsoft OAuth2');
  if (result.warning) {
    state.notice = {
      text: `Outlook 已完成 Microsoft OAuth2 授权，但首次同步失败：${result.warning}`,
      tone: 'info',
    };
    resetMailboxComposer();
    redraw();
    await refreshWorkspace();
    return result;
  }

  state.notice = {
    text: payload.mailboxId
      ? `Outlook 已重新完成 Microsoft 授权，并同步了 ${result.email || '当前账号'}。`
      : `Outlook 已通过 Microsoft OAuth2 接入，并同步了 ${result.email || '当前账号'}。`,
    tone: 'success',
  };
  resetMailboxComposer();
  redraw();
  await refreshWorkspace();
  return result;
}

async function loadSession() {
  const data = await api('/api/auth/me', {}, { allowUnauthorized: true });
  state.user = data.user || null;
  state.usersForAssignment = data.usersForAssignment || [];
}

function applyVersionPayload(payload = {}) {
  const current = payload.current || payload.currentVersion || state.appVersion.current || null;
  const latest = payload.latest || state.appVersion.latest || null;
  const updateState = payload.updateState || current?.updateState || state.appVersion.updateState || null;
  state.appVersion = {
    ...state.appVersion,
    current,
    latest,
    checkedAt: payload.checkedAt || state.appVersion.checkedAt || '',
    isNewer: Boolean(payload.isNewer),
    error: String(payload.error || ''),
    updateEnabled: Boolean(payload.updateEnabled ?? current?.updateEnabled ?? state.appVersion.updateEnabled),
    updateRunning: Boolean(payload.updateRunning ?? current?.updateRunning ?? updateState?.running),
    updateState,
  };
}

async function loadAppVersion() {
  const data = await api('/api/version', {}, { allowUnauthorized: true });
  applyVersionPayload(data || {});
}

async function checkAppVersion(options = {}) {
  const force = Boolean(options.force);
  state.appVersionCheckLoading = true;
  if (force) {
    redraw();
  }

  try {
    const data = await api(`/api/version/check${force ? '?force=1' : ''}`);
    applyVersionPayload(data || {});
    if (force) {
      state.notice = {
        text: state.appVersion.isNewer
          ? `发现新版本 ${state.appVersion.latest?.tag || ''}，可以查看 GitHub Release。`
          : state.appVersion.error
            ? `版本检查失败：${state.appVersion.error}`
            : '当前已经是最新版本。',
        tone: state.appVersion.error ? 'error' : state.appVersion.isNewer ? 'info' : 'success',
      };
    }
  } catch (error) {
    state.appVersion = {
      ...state.appVersion,
      error: String(error.message || error),
    };
    if (force) {
      state.notice = {
        text: `版本检查失败：${error.message}`,
        tone: 'error',
      };
    }
  } finally {
    state.appVersionCheckLoading = false;
  }
}

async function startAppUpdate() {
  if (state.user?.role !== 'admin') {
    state.notice = {
      text: '只有管理员可以执行系统更新。',
      tone: 'error',
    };
    return;
  }

  if (!state.appVersion.updateEnabled) {
    state.notice = {
      text: '当前未配置 MAILUNION_UPDATE_COMMAND，只能查看新版本，不能在后台直接更新。',
      tone: 'info',
    };
    return;
  }

  const latestTag = state.appVersion.latest?.tag || '最新版本';
  const confirmed = await openConfirmDialog({
    eyebrow: '系统更新',
    title: `确认执行更新到 ${latestTag}？`,
    message: '系统会执行服务器上预先配置的更新命令。请确认你已经做好备份，并且更新命令会按当前部署方式完成拉取、安装和重启。',
    confirmLabel: '执行更新',
    cancelLabel: '取消',
    tone: 'danger',
    icon: 'system',
  });

  if (!confirmed) {
    return;
  }

  state.appVersionUpdateLoading = true;
  redraw();

  try {
    const data = await api('/api/version/update', {
      method: 'POST',
      body: JSON.stringify({}),
    });
    applyVersionPayload(data || {});
    state.notice = {
      text: data.message || '更新命令已开始执行。',
      tone: 'success',
    };
  } catch (error) {
    state.notice = {
      text: `更新启动失败：${error.message}`,
      tone: 'error',
    };
  } finally {
    state.appVersionUpdateLoading = false;
  }
}

async function loadProviders() {
  const data = await api('/api/providers');
  state.providers = data.providers || [];
  state.usersForAssignment = data.usersForAssignment || state.usersForAssignment;
  ensureMailboxDraft();
}

async function loadDashboard() {
  state.dashboard = await api('/api/dashboard');
}

async function loadSystemSettings() {
  const data = await api('/api/system-settings', {}, { allowUnauthorized: true });
  applyLoadedSystemSettings(data.settings || {});
  applySystemSettingsToDocument();
}

async function loadAttachmentMetadata() {
  if (state.user?.role !== 'admin') {
    state.attachmentMetadata = [];
    state.attachmentMetadataPagination = {
      page: 1,
      pageSize: 10,
      totalItems: 0,
      totalPages: 1,
    };
    state.attachmentMetadataSyncResult = null;
    clearAttachmentMetadataSelection();
    return;
  }

  state.attachmentMetadataLoading = true;
  try {
    const requestedPage = normalizePageNumber(state.attachmentMetadataPage, 1);
    const requestedPageSize = normalizePageSize(state.attachmentMetadataPageSize, 10);
    const params = new URLSearchParams();
    params.set('page', String(requestedPage));
    params.set('pageSize', String(requestedPageSize));
    const data = await api(`/api/attachment-metadata?${params.toString()}`);
    state.attachmentMetadata = Array.isArray(data.attachments) ? data.attachments : [];
    state.attachmentMetadataPagination = {
      page: Number(data.pagination?.page || requestedPage),
      pageSize: normalizePageSize(data.pagination?.pageSize || requestedPageSize, requestedPageSize),
      totalItems: Number(data.pagination?.totalItems || 0),
      totalPages: Math.max(Number(data.pagination?.totalPages || 1), 1),
    };
    state.attachmentMetadataPage = state.attachmentMetadataPagination.page;
    state.attachmentMetadataPageSize = state.attachmentMetadataPagination.pageSize;
    pruneAttachmentMetadataSelection();
  } catch (error) {
    state.attachmentMetadata = [];
    state.attachmentMetadataPagination = {
      page: 1,
      pageSize: normalizePageSize(state.attachmentMetadataPageSize, 10),
      totalItems: 0,
      totalPages: 1,
    };
    clearAttachmentMetadataSelection();
    state.notice = {
      text: `附件元数据加载失败：${error.message}`,
      tone: 'error',
    };
  } finally {
    state.attachmentMetadataLoading = false;
  }
}

async function syncSelectedMailboxAttachments() {
  if (state.user?.role !== 'admin') {
    return;
  }

  state.attachmentMetadataSyncLoading = true;
  redraw();

  try {
    const requestedPage = normalizePageNumber(state.attachmentMetadataPage, 1);
    const requestedPageSize = normalizePageSize(state.attachmentMetadataPageSize, 10);
    const params = new URLSearchParams();
    params.set('page', String(requestedPage));
    params.set('pageSize', String(requestedPageSize));
    const data = await api(`/api/attachment-metadata/sync-selected?${params.toString()}`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    state.attachmentMetadata = Array.isArray(data.attachments) ? data.attachments : [];
    state.attachmentMetadataPagination = {
      page: Number(data.pagination?.page || requestedPage),
      pageSize: normalizePageSize(data.pagination?.pageSize || requestedPageSize, requestedPageSize),
      totalItems: Number(data.pagination?.totalItems || 0),
      totalPages: Math.max(Number(data.pagination?.totalPages || 1), 1),
    };
    state.attachmentMetadataPage = state.attachmentMetadataPagination.page;
    state.attachmentMetadataPageSize = state.attachmentMetadataPagination.pageSize;
    state.attachmentMetadataSyncResult = data.result || null;
    clearAttachmentMetadataSelection();
    state.notice = {
      text: '已完成已勾选邮箱附件同步。',
      tone: Number(data.result?.errorCount || 0) > 0 ? 'info' : 'success',
    };
  } catch (error) {
    state.notice = {
      text: `附件手动同步失败：${error.message}`,
      tone: 'error',
    };
  } finally {
    state.attachmentMetadataSyncLoading = false;
  }
}

function summarizeAttachmentBulkDeleteResult(result = {}) {
  const updatedCount = Number(result?.updatedCount || 0);
  const deletedCount = Number(result?.deletedCount || 0);
  const missingFileCount = Number(result?.missingFileCount || 0);
  const skippedCount = Number(result?.skippedCount || 0);
  const errorCount = Number(result?.errorCount || 0);
  const parts = [`已移出本地附件列表 ${updatedCount} 个`, `实际删除文件 ${deletedCount} 个`];

  if (missingFileCount > 0) {
    parts.push(`${missingFileCount} 个本地文件已不存在`);
  }

  if (skippedCount > 0) {
    parts.push(`${skippedCount} 个无需处理`);
  }

  if (errorCount > 0) {
    parts.push(`${errorCount} 个处理失败`);
  }

  return `${parts.join('，')}。`;
}

async function bulkDeleteAttachmentMetadata() {
  if (state.user?.role !== 'admin') {
    return;
  }

  const selectedIds = new Set(state.attachmentMetadataSelectedIds || []);
  const selectedItems = (Array.isArray(state.attachmentMetadata) ? state.attachmentMetadata : [])
    .filter((item) => selectedIds.has(attachmentMetadataSelectionId(item)));

  if (!selectedItems.length) {
    state.notice = {
      text: '请先勾选需要删除的本地附件。',
      tone: 'info',
    };
    return;
  }

  const confirmed = await openConfirmDialog({
    eyebrow: '附件清理',
    title: `确认删除 ${selectedItems.length} 个本地附件？`,
    message: '只会删除已经同步到本地的附件文件，并保留邮件中的附件元数据；后续需要时可以重新同步回来。',
    confirmLabel: '删除附件',
    cancelLabel: '取消',
    tone: 'danger',
  });

  if (!confirmed) {
    return;
  }

  state.attachmentMetadataBulkDeleteLoading = true;
  redraw();

  try {
    const requestedPage = normalizePageNumber(state.attachmentMetadataPage, 1);
    const requestedPageSize = normalizePageSize(state.attachmentMetadataPageSize, 10);
    const params = new URLSearchParams();
    params.set('page', String(requestedPage));
    params.set('pageSize', String(requestedPageSize));
    const data = await api(`/api/attachment-metadata/bulk-delete?${params.toString()}`, {
      method: 'POST',
      body: JSON.stringify({
        attachments: selectedItems.map((item) => ({
          messageId: item.messageId,
          attachmentIndex: item.attachmentIndex,
        })),
      }),
    });

    state.attachmentMetadata = Array.isArray(data.attachments) ? data.attachments : [];
    state.attachmentMetadataPagination = {
      page: Number(data.pagination?.page || requestedPage),
      pageSize: normalizePageSize(data.pagination?.pageSize || requestedPageSize, requestedPageSize),
      totalItems: Number(data.pagination?.totalItems || 0),
      totalPages: Math.max(Number(data.pagination?.totalPages || 1), 1),
    };
    state.attachmentMetadataPage = state.attachmentMetadataPagination.page;
    state.attachmentMetadataPageSize = state.attachmentMetadataPagination.pageSize;
    clearAttachmentMetadataSelection();
    state.attachmentMetadataSyncResult = null;
    state.notice = {
      text: summarizeAttachmentBulkDeleteResult(data.result || {}),
      tone: Number(data.result?.errorCount || 0) > 0 ? 'info' : 'success',
    };
  } catch (error) {
    state.notice = {
      text: `批量删除附件失败：${error.message}`,
      tone: 'error',
    };
  } finally {
    state.attachmentMetadataBulkDeleteLoading = false;
  }
}

async function loadBackups() {
  if (state.user?.role !== 'admin') {
    state.backups = [];
    state.backupDeleteLoadingId = '';
    return;
  }

  const data = await api('/api/backups');
  state.backups = data.backups || [];
  if (!state.backups.some((backup) => String(backup?.id || '').trim() === String(state.backupDeleteLoadingId || '').trim())) {
    state.backupDeleteLoadingId = '';
  }
}

async function loadNotifications() {
  const data = await api('/api/notifications');
  state.notifications = data.notifications || null;
  state.wecomDiscovery = data.wecomDiscovery || null;
  syncNotificationDraftsFromSettings();
  syncNotificationTemplateOptionsDraft({ force: true });
  syncNotificationRevealValuesFromSettings();
}

async function loadViewData(view = state.view, options = {}) {
  const activeView = String(view || state.view || 'dashboard').trim() || 'dashboard';
  const preserveSelectedMessageDetail = Boolean(options.preserveSelectedMessageDetail);
  const tasks = [];

  if (activeView === 'dashboard') {
    tasks.push(loadDashboard(), loadMailboxes());
    await Promise.all(tasks);
    return;
  }

  if (activeView === 'inbox') {
    tasks.push(loadMailboxes(), loadMessages({ preserveSelectedMessageDetail }));
    if (state.user?.role === 'admin') {
      tasks.push(loadUsers());
    }
    await Promise.all(tasks);
    return;
  }

  if (activeView === 'mailboxes') {
    tasks.push(loadMailboxes());
    if (state.user?.role === 'admin') {
      tasks.push(loadUsers());
    }
    await Promise.all(tasks);
    ensureMailboxDraft();
    return;
  }

  if (activeView === 'notifications') {
    await loadNotifications();
    return;
  }

  if (activeView === 'users' && state.user?.role === 'admin') {
    await loadUsers();
    return;
  }

  if (activeView === 'backups' && state.user?.role === 'admin') {
    await loadBackups();
    return;
  }

  if (activeView === 'system' && state.user?.role === 'admin') {
    await loadSystemSettings();
    if (state.systemSettingsGroup === 'metadata') {
      await loadAttachmentMetadata();
    }
  }
}

function consumeOauthRedirectNotice() {
  const oauthResult = readOauthResultFromUrl();
  if (!oauthResult) {
    return;
  }

  const providerLabel =
    oauthResult.provider === 'microsoft'
      ? 'Microsoft'
      : oauthResult.provider === 'google'
        ? 'Google'
        : oauthResult.provider;
  const defaultMessage =
    oauthResult.status === 'error'
      ? `${providerLabel} 授权失败，请重试。`
      : `${providerLabel} 授权完成。`;

  state.notice = {
    text: oauthResult.message || defaultMessage,
    tone: oauthResult.status === 'error' ? 'error' : 'success',
  };
  clearOauthResultFromUrl();
}

async function toggleNotificationConfigVisibility(channel, field) {
  if (!REVEALABLE_NOTIFICATION_CHANNELS.includes(channel)) {
    return;
  }

  if (!NOTIFICATION_CONFIG_FIELDS[channel]?.includes(field)) {
    return;
  }

  if (state.notificationConfigVisibility[channel]?.[field]) {
    state.notificationConfigVisibility[channel][field] = false;
    return;
  }

  if (!state.notifications?.[channel]?.configured) {
    state.notificationConfigVisibility[channel][field] = true;
    return;
  }

  state.notificationConfigLoading[channel][field] = true;
  redraw();

  try {
    if (!state.notificationConfigValues[channel]) {
      const data = await api(`/api/notifications/${channel}/reveal`);
      state.notificationConfigValues[channel] = data.setting || {};
    }
    state.notificationConfigVisibility[channel][field] = true;
  } finally {
    state.notificationConfigLoading[channel][field] = false;
  }
}

async function toggleSystemGoogleSecretVisibility(form = document.querySelector('[data-form="system-settings"]')) {
  if (!form) {
    return;
  }

  syncSystemSettingsDraftFromForm(form);

  if (state.systemGoogleSecretVisible) {
    state.systemGoogleSecretVisible = false;
    redraw();
    return;
  }

  if (String(state.systemSettingsDraft?.googleClientSecret || '').trim()) {
    state.systemGoogleSecretVisible = true;
    redraw();
    return;
  }

  if (!state.systemSettings?.googleClientSecretConfigured) {
    state.systemGoogleSecretVisible = true;
    redraw();
    return;
  }

  state.systemGoogleSecretLoading = true;
  redraw();

  try {
    const data = await api('/api/system-settings/reveal?field=googleClientSecret');
    state.systemSettingsDraft = {
      ...createSystemSettingsDraft(state.systemSettingsDraft || state.systemSettings),
      ...state.systemSettingsDraft,
      googleClientSecret: String(data.setting?.googleClientSecret || ''),
    };
    state.systemGoogleSecretVisible = true;
  } finally {
    state.systemGoogleSecretLoading = false;
  }

  redraw();
}

async function toggleSystemMicrosoftSecretVisibility(form = document.querySelector('[data-form="system-settings"]')) {
  if (!form) {
    return;
  }

  syncSystemSettingsDraftFromForm(form);

  if (state.systemMicrosoftSecretVisible) {
    state.systemMicrosoftSecretVisible = false;
    redraw();
    return;
  }

  if (String(state.systemSettingsDraft?.microsoftClientSecret || '').trim()) {
    state.systemMicrosoftSecretVisible = true;
    redraw();
    return;
  }

  if (!state.systemSettings?.microsoftClientSecretConfigured) {
    state.systemMicrosoftSecretVisible = true;
    redraw();
    return;
  }

  state.systemMicrosoftSecretLoading = true;
  redraw();

  try {
    const data = await api('/api/system-settings/reveal');
    state.systemSettingsDraft = {
      ...createSystemSettingsDraft(state.systemSettingsDraft || state.systemSettings),
      ...state.systemSettingsDraft,
      microsoftClientSecret: String(data.setting?.microsoftClientSecret || ''),
    };
    state.systemMicrosoftSecretVisible = true;
  } finally {
    state.systemMicrosoftSecretLoading = false;
  }

  redraw();
}

async function toggleSystemSmtpPasswordVisibility(form = document.querySelector('[data-form="system-settings"]')) {
  if (!form) {
    return;
  }

  syncSystemSettingsDraftFromForm(form);

  if (state.systemSmtpPasswordVisible) {
    state.systemSmtpPasswordVisible = false;
    redraw();
    return;
  }

  if (String(state.systemSettingsDraft?.smtpPassword || '').trim()) {
    state.systemSmtpPasswordVisible = true;
    redraw();
    return;
  }

  if (!state.systemSettings?.smtpPasswordConfigured) {
    state.systemSmtpPasswordVisible = true;
    redraw();
    return;
  }

  state.systemSmtpPasswordLoading = true;
  redraw();

  try {
    const data = await api('/api/system-settings/reveal?field=smtpPassword');
    state.systemSettingsDraft = {
      ...createSystemSettingsDraft(state.systemSettingsDraft || state.systemSettings),
      ...state.systemSettingsDraft,
      smtpPassword: String(data.setting?.smtpPassword || ''),
    };
    state.systemSmtpPasswordVisible = true;
  } finally {
    state.systemSmtpPasswordLoading = false;
  }

  redraw();
}

async function toggleSystemTranslationApiKeyVisibility(
  form = document.querySelector('[data-form="system-settings"]'),
) {
  if (!form) {
    return;
  }

  syncSystemSettingsDraftFromForm(form);

  if (state.systemTranslationApiKeyVisible) {
    state.systemTranslationApiKeyVisible = false;
    redraw();
    return;
  }

  if (String(state.systemSettingsDraft?.translationApiKey || '').trim()) {
    state.systemTranslationApiKeyVisible = true;
    redraw();
    return;
  }

  if (!state.systemSettings?.translationApiKeyConfigured) {
    state.systemTranslationApiKeyVisible = true;
    redraw();
    return;
  }

  state.systemTranslationApiKeyLoading = true;
  redraw();

  try {
    const data = await api('/api/system-settings/reveal?field=translationApiKey');
    state.systemSettingsDraft = {
      ...createSystemSettingsDraft(state.systemSettingsDraft || state.systemSettings),
      ...state.systemSettingsDraft,
      translationApiKey: String(data.setting?.translationApiKey || ''),
    };
    state.systemTranslationApiKeyVisible = true;
  } finally {
    state.systemTranslationApiKeyLoading = false;
  }

  redraw();
}

async function toggleSystemStorageSecretVisibility(
  field,
  form = document.querySelector('[data-form="system-settings"]'),
) {
  if (!form || !field) {
    return;
  }

  syncSystemSettingsDraftFromForm(form);

  if (state.systemStorageSecretVisibility?.[field]) {
    state.systemStorageSecretVisibility = {
      ...state.systemStorageSecretVisibility,
      [field]: false,
    };
    redraw();
    return;
  }

  if (String(state.systemSettingsDraft?.[field] || '').trim()) {
    state.systemStorageSecretVisibility = {
      ...state.systemStorageSecretVisibility,
      [field]: true,
    };
    redraw();
    return;
  }

  const configuredField =
    field === 'storageS3Secret'
      ? 'storageS3SecretConfigured'
      : field === 'storageWebdavPassword'
        ? 'storageWebdavPasswordConfigured'
        : 'storageFtpPasswordConfigured';

  if (!state.systemSettings?.[configuredField]) {
    state.systemStorageSecretVisibility = {
      ...state.systemStorageSecretVisibility,
      [field]: true,
    };
    redraw();
    return;
  }

  state.systemStorageSecretLoading = {
    ...state.systemStorageSecretLoading,
    [field]: true,
  };
  redraw();

  try {
    const data = await api(`/api/system-settings/reveal?field=${encodeURIComponent(field)}`);
    state.systemSettingsDraft = {
      ...createSystemSettingsDraft(state.systemSettingsDraft || state.systemSettings),
      ...state.systemSettingsDraft,
      [field]: String(data.setting?.[field] || ''),
    };
    state.systemStorageSecretVisibility = {
      ...state.systemStorageSecretVisibility,
      [field]: true,
    };
  } finally {
    state.systemStorageSecretLoading = {
      ...state.systemStorageSecretLoading,
      [field]: false,
    };
  }

  redraw();
}

async function loadUsers() {
  if (state.user.role !== 'admin') {
    state.users = [];
    return;
  }
  const data = await api('/api/users');
  state.users = data.users || [];
}

async function loadMailboxes() {
  const params = new URLSearchParams();
  params.set('limit', '5000');
  if (state.user.role === 'admin' && state.selectedOwnerUserId) {
    params.set('ownerUserId', state.selectedOwnerUserId);
  }
  const data = await api(`/api/mailboxes?${params.toString()}`);
  state.mailboxes = data.mailboxes || [];
  clearMailboxSelection();
  if (state.selectedMailboxId && !state.mailboxes.some((mailbox) => mailbox.id === state.selectedMailboxId)) {
    state.selectedMailboxId = '';
  }
  if (state.editingMailboxId && !state.mailboxes.some((mailbox) => mailbox.id === state.editingMailboxId)) {
    resetMailboxComposer();
  }
}

async function loadMessageDetail(messageId) {
  if (!messageId) {
    state.selectedMessage = null;
    return null;
  }

  const detail = await api(`/api/messages/${messageId}`);
  state.selectedMessage = detail.message || null;
  return state.selectedMessage;
}

function messageTranslationFor(messageId) {
  if (!messageId) {
    return null;
  }
  return state.messageTranslations?.[messageId] || null;
}

async function translateSelectedMessage(messageId) {
  if (!messageId) {
    throw new Error('未找到要翻译的邮件。');
  }

  delete state.messageTranslationErrors[messageId];
  state.messageTranslationLoadingId = messageId;
  redraw();

  try {
    const data = await api(`/api/messages/${messageId}/translate`, {
      method: 'POST',
      body: '{}',
    });
    state.messageTranslations = {
      ...state.messageTranslations,
      [messageId]: data.translation || null,
    };
    state.notice = {
      text: '邮件翻译已完成。',
      tone: 'success',
    };
  } catch (error) {
    state.messageTranslationErrors = {
      ...state.messageTranslationErrors,
      [messageId]: error.message,
    };
    throw error;
  } finally {
    if (state.messageTranslationLoadingId === messageId) {
      state.messageTranslationLoadingId = '';
    }
  }
}

function syncSelectedMessages() {
  const visibleIds = new Set(state.messages.map((message) => message.id));
  state.selectedMessageIds = (state.selectedMessageIds || []).filter((messageId) => visibleIds.has(messageId));
}

function clearMailboxSelection() {
  state.selectedMailboxIds = [];
}

function setMailboxSelected(mailboxId, checked) {
  const current = new Set(state.selectedMailboxIds || []);
  if (checked) {
    current.add(mailboxId);
  } else {
    current.delete(mailboxId);
  }
  state.selectedMailboxIds = Array.from(current);
}

function clearAttachmentMetadataSelection() {
  state.attachmentMetadataSelectedIds = [];
}

function pruneAttachmentMetadataSelection() {
  const visibleSet = new Set(visibleAttachmentMetadataSelectionIds());
  state.attachmentMetadataSelectedIds = (state.attachmentMetadataSelectedIds || []).filter((id) => visibleSet.has(id));
}

function setAttachmentMetadataSelected(selectionId, checked) {
  const normalizedSelectionId = String(selectionId || '').trim();
  if (!normalizedSelectionId) {
    return;
  }

  const current = new Set(state.attachmentMetadataSelectedIds || []);
  if (checked) {
    current.add(normalizedSelectionId);
  } else {
    current.delete(normalizedSelectionId);
  }
  state.attachmentMetadataSelectedIds = Array.from(current);
}

function clearMessageSelection() {
  state.selectedMessageIds = [];
}

function setMessageSelected(messageId, checked) {
  const current = new Set(state.selectedMessageIds || []);
  if (checked) {
    current.add(messageId);
  } else {
    current.delete(messageId);
  }
  state.selectedMessageIds = Array.from(current);
}

function patchLocalMessage(messageId, nextFields) {
  if (!messageId) {
    return;
  }

  const messageIndex = state.messages.findIndex((message) => message.id === messageId);
  const previousMessage = messageIndex >= 0 ? state.messages[messageIndex] : null;
  const nextMessage = previousMessage
    ? {
        ...previousMessage,
        ...nextFields,
      }
    : null;

  if (messageIndex >= 0 && nextMessage) {
    if (messageMatchesCurrentFolder(nextMessage)) {
      state.messages[messageIndex] = nextMessage;
    } else {
      state.messages.splice(messageIndex, 1);
    }
  }

  if (state.selectedMessage?.id === messageId) {
    state.selectedMessage = {
      ...state.selectedMessage,
      ...nextFields,
    };
  }

  if (previousMessage) {
    if (
      !isSpecialMessageFolderKind(previousMessage.folderKind) &&
      previousMessage.isRead !== nextFields.isRead &&
      typeof nextFields.isRead === 'boolean'
    ) {
      state.messageFolderCounts.unreadCount += nextFields.isRead ? -1 : 1;
      state.messageFolderCounts.readCount += nextFields.isRead ? 1 : -1;

      const mailbox = state.mailboxes.find((item) => item.id === previousMessage.mailboxId);
      if (mailbox) {
        mailbox.unreadCount = Math.max(
          0,
          Number(mailbox.unreadCount || 0) + (nextFields.isRead ? -1 : 1),
        );
      }
    }

    if (
      !isSpecialMessageFolderKind(previousMessage.folderKind) &&
      previousMessage.isStarred !== nextFields.isStarred &&
      typeof nextFields.isStarred === 'boolean'
    ) {
      state.messageFolderCounts.starredCount += nextFields.isStarred ? 1 : -1;
    }
  }

  syncSelectedMessages();
}

function messageMatchesCurrentFolder(message) {
  if (!message) {
    return false;
  }

  const folderKind = String(message.folderKind || 'inbox').trim().toLowerCase();

  if (state.inboxFolder === 'trash') {
    return folderKind === 'trash';
  }

  if (state.inboxFolder === 'junk') {
    return folderKind === 'junk';
  }

  if (isSpecialMessageFolderKind(folderKind)) {
    return false;
  }

  if (state.inboxFolder === 'unread') {
    return !message.isRead;
  }

  if (state.inboxFolder === 'read') {
    return Boolean(message.isRead);
  }

  if (state.inboxFolder === 'starred') {
    return Boolean(message.isStarred);
  }

  return true;
}

function closeMessageReader(clearCurrent = false) {
  state.messageReaderOpen = false;
  closeAttachmentPreviewModal();
  if (clearCurrent) {
    state.selectedMessageId = null;
    state.selectedMessage = null;
  }
}

async function updateMessageState(messageId, nextFields) {
  const data = await api(`/api/messages/${messageId}`, {
    method: 'PATCH',
    body: JSON.stringify(nextFields),
  });

  patchLocalMessage(messageId, {
    isRead: data.message?.isRead,
    isStarred: data.message?.isStarred,
  });

  return data.message || null;
}

async function updateMessagesStateBulk(messageIds, nextFields) {
  const ids = Array.from(
    new Set((messageIds || []).map((messageId) => String(messageId || '').trim()).filter(Boolean)),
  );
  if (!ids.length) {
    return [];
  }

  const data = await api('/api/messages/bulk', {
    method: 'PATCH',
    body: JSON.stringify({
      messageIds: ids,
      ...nextFields,
    }),
  });

  const updatedById = new Map((data.messages || []).map((message) => [message.id, message]));
  for (const messageId of ids) {
    const updated = updatedById.get(messageId);
    if (!updated) {
      continue;
    }

    patchLocalMessage(messageId, {
      isRead: updated.isRead,
      isStarred: updated.isStarred,
    });
  }

  return data.messages || [];
}

async function openMessage(messageId, options = {}) {
  const { switchToInbox = false } = options;
  if (!messageId) {
    return;
  }

  if (switchToInbox) {
    state.view = 'inbox';
    state.inboxFolder = 'all';
    state.selectedMailboxId = '';
  }

  state.selectedMessageId = messageId;
  state.messageReaderOpen = true;
  await loadMessages();
  const detail = await loadMessageDetail(messageId);

  if (detail && !detail.isRead) {
    await updateMessageState(messageId, { isRead: true });
  }
}

async function applyBulkMessageState(nextFields, successText) {
  const selectedIds = state.selectedMessageIds || [];
  if (!selectedIds.length) {
    throw new Error('请先勾选要操作的邮件。');
  }

  await updateMessagesStateBulk(selectedIds, nextFields);
  syncSelectedMessages();
  state.notice = {
    text: successText,
    tone: 'success',
  };
}

async function deleteMessages(messageIds, options = {}) {
  const ids = Array.from(
    new Set((messageIds || []).map((messageId) => String(messageId || '').trim()).filter(Boolean)),
  );
  if (!ids.length) {
    throw new Error('请先选择要删除的邮件。');
  }

  const permanent = Boolean(options.permanent);
  const data = await api('/api/messages/bulk-delete', {
    method: 'POST',
    body: JSON.stringify({
      messageIds: ids,
      permanent,
    }),
  });

  clearMessageSelection();
  if (ids.includes(state.selectedMessageId)) {
    closeMessageReader(true);
  }

  await Promise.all([loadDashboard(), loadMailboxes()]);
  await loadMessages();

  state.notice = {
    text: permanent ? '邮件已彻底删除并同步到官方邮箱。' : '邮件已删除并同步到官方邮箱。',
    tone: 'success',
  };

  return data;
}

async function deleteSelectedMessages() {
  const selectedSet = new Set(state.selectedMessageIds || []);
  const selectedMessages = state.messages.filter((message) => selectedSet.has(message.id));
  if (!selectedMessages.length) {
    throw new Error('请先勾选要删除的邮件。');
  }

  const permanent = selectedMessages.every((message) => String(message.folderKind || '').toLowerCase() === 'trash');
  const confirmText = permanent
    ? '这些邮件已经在“已删除”中，继续会彻底删除官方邮箱中的对应邮件。确定继续吗？'
    : '删除后会同步移动到官方邮箱的“已删除/垃圾箱”。确定继续吗？';
  const confirmed = await openConfirmDialog({
    eyebrow: '邮件删除',
    title: permanent ? '确认彻底删除这些邮件？' : '确认删除这些邮件？',
    message: confirmText,
    confirmLabel: permanent ? '彻底删除' : '删除邮件',
    cancelLabel: '先取消',
    tone: 'danger',
    icon: 'warning',
  });
  if (!confirmed) {
    return;
  }

  await deleteMessages(
    selectedMessages.map((message) => message.id),
    { permanent },
  );
}

async function deleteCurrentMessage(messageId) {
  const sourceMessage =
    state.messages.find((message) => message.id === messageId) ||
    (state.selectedMessage?.id === messageId ? state.selectedMessage : null);
  if (!sourceMessage) {
    throw new Error('未找到要删除的邮件。');
  }

  const permanent = String(sourceMessage.folderKind || '').toLowerCase() === 'trash';
  const confirmText = permanent
    ? '这封邮件已经在“已删除”中，继续会彻底删除官方邮箱中的对应邮件。确定继续吗？'
    : '删除后会同步移动到官方邮箱的“已删除/垃圾箱”。确定继续吗？';
  const confirmed = await openConfirmDialog({
    eyebrow: '邮件删除',
    title: permanent ? '确认彻底删除这封邮件？' : '确认删除这封邮件？',
    message: confirmText,
    confirmLabel: permanent ? '彻底删除' : '删除邮件',
    cancelLabel: '先取消',
    tone: 'danger',
    icon: 'warning',
  });
  if (!confirmed) {
    return;
  }

  await deleteMessages([messageId], { permanent });
}

async function loadMessages(options = {}) {
  const params = new URLSearchParams();
  if (state.selectedMailboxId) params.set('mailboxId', state.selectedMailboxId);
  const searchQuery = String(state.search || '').trim();
  if (searchQuery) params.set('q', searchQuery);
  params.set('folder', state.inboxFolder || 'all');
  params.set('page', String(normalizePageNumber(state.inboxPage, 1)));
  params.set('pageSize', String(normalizePageSize(state.inboxPageSize, 10)));
  if (state.user.role === 'admin' && state.selectedOwnerUserId) {
    params.set('ownerUserId', state.selectedOwnerUserId);
  }
  const data = await api(`/api/messages?${params.toString()}`);
  state.messages = data.messages || [];
  state.inboxPagination = {
    page: Number(data.pagination?.page || 1),
    pageSize: normalizePageSize(data.pagination?.pageSize || state.inboxPageSize, state.inboxPageSize),
    totalItems: Number(data.pagination?.totalItems || 0),
    totalPages: Math.max(Number(data.pagination?.totalPages || 1), 1),
  };
  state.inboxPage = state.inboxPagination.page;
  state.inboxPageSize = state.inboxPagination.pageSize;
  state.messageFolderCounts = {
    unreadCount: Number(data.folderCounts?.unreadCount || 0),
    readCount: Number(data.folderCounts?.readCount || 0),
    starredCount: Number(data.folderCounts?.starredCount || 0),
    totalCount: Number(data.folderCounts?.totalCount || 0),
    trashCount: Number(data.folderCounts?.trashCount || 0),
    junkCount: Number(data.folderCounts?.junkCount || 0),
  };

  syncSelectedMessages();
  const selectedMessageStillVisible = state.messages.some((message) => message.id === state.selectedMessageId);
  const preserveSelectedMessageDetail = Boolean(options.preserveSelectedMessageDetail);
  if (!selectedMessageStillVisible && !state.messageReaderOpen) {
    state.selectedMessageId = null;
  }

  if (!selectedMessageStillVisible && !state.messageReaderOpen) {
    state.selectedMessage = null;
    return;
  }

  if (state.selectedMessageId) {
    if (
      !preserveSelectedMessageDetail ||
      !state.selectedMessage ||
      state.selectedMessage.id !== state.selectedMessageId
    ) {
      await loadMessageDetail(state.selectedMessageId);
    }
  } else {
    state.selectedMessage = null;
  }
}

async function refreshWorkspace() {
  if (!state.user) {
    return;
  }

  await loadProviders();
  await loadViewData(state.view, {
    preserveSelectedMessageDetail: Boolean(state.selectedMessageId),
  });
  ensureMailboxDraft();
  scheduleWorkspaceAutoRefresh();
}

async function login(form) {
  const formData = new FormData(form);
  const data = await api('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({
      username: formData.get('username'),
      password: formData.get('password'),
    }),
  });

  state.user = data.user;
  state.usersForAssignment = data.usersForAssignment || [];
  state.authMode = 'login';
  const targetPortalPath = resolvePortalPathForUser(data.user);
  replacePortalPath(targetPortalPath, `#${defaultViewForPortal(targetPortalPath, data.user)}`);
  state.notice = { text: '登录成功，欢迎回来。', tone: 'success' };
  await refreshWorkspace();
  scheduleWorkspaceAutoRefresh(1200);
}

async function register(form) {
  const formData = new FormData(form);
  await api('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({
      name: formData.get('name'),
      username: formData.get('username'),
      email: formData.get('email'),
      emailCode: formData.get('emailCode'),
      avatarUrl: formData.get('avatarUrl'),
      password: formData.get('password'),
    }),
  });

  state.authMode = 'login';
  state.authCodeResult = null;
  state.notice = { text: '注册成功，请等待管理员启用账号。', tone: 'success' };
}

async function requestAuthEmailCode(form, purpose = 'register') {
  if (!form) {
    return;
  }

  const formData = new FormData(form);
  const payload =
    purpose === 'reset'
      ? {
          purpose: 'reset',
          login: formData.get('login') || formData.get('username'),
          email: formData.get('email'),
        }
      : {
          purpose: 'register',
          email: formData.get('email'),
        };

  state.authCodeSending = true;
  state.authCodePurpose = purpose;
  redraw();

  try {
    const data = await api('/api/auth/email-code', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    state.authCodeResult = {
      tone: 'success',
      purpose,
      text: String(data.message || '验证码已发送。').trim() || '验证码已发送。',
    };
    state.notice = state.authCodeResult;
  } finally {
    state.authCodeSending = false;
    state.authCodePurpose = '';
    redraw();
  }
}

async function resetPassword(form) {
  const formData = new FormData(form);
  await api('/api/auth/password-reset', {
    method: 'POST',
    body: JSON.stringify({
      login: formData.get('login') || formData.get('username'),
      email: formData.get('email'),
      emailCode: formData.get('emailCode'),
      password: formData.get('password'),
    }),
  });

  state.authMode = 'login';
  state.authCodeResult = null;
  state.notice = { text: '密码已重置，请使用新密码登录。', tone: 'success' };
}

function openMailboxEditor(mailboxId) {
  const mailbox = state.mailboxes.find((entry) => entry.id === mailboxId);
  if (!mailbox) {
    throw new Error('未找到要编辑的邮箱配置。');
  }

  state.mailboxModalOpen = true;
  state.mailboxGuideOpen = false;
  state.mailboxPasswordVisible = false;
  state.mailboxOwnerFilterOpen = false;
  state.mailboxOwnerSearch = '';
  state.editingMailboxId = mailbox.id;
  state.mailboxDraft = createMailboxDraftFromMailbox(mailbox);
  state.mailboxNotice = null;
  shouldFocusMailboxOwnerSearch = false;
}

async function saveMailbox(form) {
  const payload = mailboxPayloadFromForm(form);
  if (shouldStartGoogleOauth(payload)) {
    await startGoogleOauthForMailbox(form);
    return;
  }
  if (shouldStartMicrosoftOauth(payload)) {
    await startMicrosoftOauthForMailbox(form);
    return;
  }

  const mailboxId = payload.mailboxId || state.editingMailboxId || '';

  await api(mailboxId ? `/api/mailboxes/${mailboxId}` : '/api/mailboxes', {
    method: mailboxId ? 'PATCH' : 'POST',
    body: JSON.stringify(payload),
  });

  state.notice = {
    text: mailboxId ? '邮箱配置已更新，正在后台重新同步。' : '邮箱添加成功，正在后台同步首批邮件。',
    tone: 'success',
  };
  resetMailboxComposer();
  redraw();
  await refreshWorkspace();
}

async function saveMicrosoftMailboxImport(form) {
  const formData = new FormData(form);
  const importFile = formData.get('importFile');
  let importText = String(formData.get('importText') || '');

  if (importFile instanceof File && importFile.size > 0) {
    importText = await importFile.text();
  }

  const payload = {
    ownerUserId: String(formData.get('ownerUserId') || state.user?.id || ''),
    importText,
    microsoftClientSecret: String(formData.get('microsoftClientSecret') || ''),
    microsoftTenantId: String(formData.get('microsoftTenantId') || systemMicrosoftTenantId()),
    microsoftProtocolMode: normalizeMicrosoftProtocolMode(
      formData.get('microsoftProtocolMode') || 'graph_imap_dual',
    ),
    imapHost: String(formData.get('imapHost') || 'outlook.office365.com'),
    imapPort: Number(formData.get('imapPort') || 993),
    secure: formData.get('secure') === 'on',
    syncIntervalSeconds: Number(formData.get('syncIntervalSeconds') || 5),
    sortOrder: Number(formData.get('sortOrder') || 100),
    isPinned: formData.get('isPinned') === 'on',
  };

  const data = await api('/api/mailboxes/import/microsoft', {
    method: 'POST',
    body: JSON.stringify(payload),
  });

  const failures = (data.results || []).filter((item) => !item.ok);
  if (failures.length) {
    state.mailboxImportNotice = {
      tone: 'error',
      text: failures
        .slice(0, 3)
        .map((item) => `${item.email || '未识别邮箱'}：${item.error || '导入失败'}`)
        .join('\n'),
    };
  } else {
    resetMailboxImportComposer();
  }

  const warningCount = Number(data.warningCount || 0);
  state.notice = {
    tone: failures.length || warningCount ? 'info' : 'success',
    text: `Outlook 导入完成：新增 ${Number(data.createdCount || 0)}，更新 ${Number(data.updatedCount || 0)}，失败 ${Number(data.failedCount || 0)}，待检查 ${warningCount}。`,
  };
  await refreshWorkspace();
}

async function saveMailboxInterval(form) {
  const mailboxId = form.dataset.mailboxId;
  const formData = new FormData(form);
  const syncIntervalSeconds = Number(formData.get('syncIntervalSeconds'));

  await api(`/api/mailboxes/${mailboxId}/interval`, {
    method: 'PATCH',
    body: JSON.stringify({
      syncIntervalSeconds,
    }),
  });

  state.notice = { text: `同步频率已更新为 ${syncIntervalSeconds} 秒。`, tone: 'success' };
  await Promise.all([loadMailboxes(), loadDashboard()]);
}

async function saveUserLegacy(form) {
  const formData = new FormData(form);
  const userId = formData.get('userId');
  const payload = {
    name: formData.get('name'),
    username: formData.get('username'),
    email: formData.get('email'),
    avatarUrl: formData.get('avatarUrl'),
    role: formData.get('role'),
    status: formData.get('status'),
    password: formData.get('password'),
  };

  await api(userId ? `/api/users/${userId}` : '/api/users', {
    method: userId ? 'PATCH' : 'POST',
    body: JSON.stringify(payload),
  });

  state.editingUserId = null;
  state.notice = { text: userId ? '用户资料已更新。' : '新用户已创建。', tone: 'success' };
  await refreshWorkspace();
}

async function saveUser(form) {
  const formData = new FormData(form);
  const userId = formData.get('userId');
  const payload = {
    name: formData.get('name'),
    username: formData.get('username'),
    email: formData.get('email'),
    avatarUrl: formData.get('avatarUrl'),
    role: formData.get('role'),
    status: formData.get('status'),
    password: formData.get('password'),
  };

  await api(userId ? `/api/users/${userId}` : '/api/users', {
    method: userId ? 'PATCH' : 'POST',
    body: JSON.stringify(payload),
  });

  closeUserComposer();
  state.notice = { text: userId ? '用户资料已更新。' : '新用户已创建。', tone: 'success' };
  await refreshWorkspace();
}

async function saveProfile(form) {
  const formData = new FormData(form);
  const data = await api('/api/profile', {
    method: 'PATCH',
    body: JSON.stringify({
      name: formData.get('name'),
      username: formData.get('username'),
      avatarUrl: formData.get('avatarUrl'),
      currentPassword: formData.get('currentPassword'),
      newPassword: formData.get('newPassword'),
    }),
  });

  state.user = data.user;
  state.notice = { text: '个人资料已更新。', tone: 'success' };
}

async function saveSystemSettings(form, scope = 'all') {
  syncSystemSettingsDraftFromForm(form);
  const formData = new FormData(form);
  const draft = getPersistableSystemSettingsDraft();
  let payload = {};

  if (scope === 'google') {
    payload = {
      googleClientId: draft.googleClientId,
      googleClientSecret: draft.googleClientSecret,
    };
  } else if (scope === 'auth') {
    payload = {
      registrationEnabled: draft.registrationEnabled,
      registrationEmailVerificationRequired: draft.registrationEmailVerificationRequired,
      registrationEmailDomainWhitelist: draft.registrationEmailDomainWhitelist,
      passwordResetEnabled: draft.passwordResetEnabled,
      sessionTimeoutValue: draft.sessionTimeoutValue,
      sessionTimeoutUnit: draft.sessionTimeoutUnit,
    };
  } else if (scope === 'smtp') {
    payload = {
      smtpHost: draft.smtpHost,
      smtpPort: draft.smtpPort,
      smtpSecure: draft.smtpSecure,
      smtpUsername: draft.smtpUsername,
      smtpPassword: draft.smtpPassword,
      clearSmtpPassword: draft.clearSmtpPassword,
      smtpFromName: draft.smtpFromName,
      smtpFromEmail: draft.smtpFromEmail,
    };
  } else if (scope === 'microsoft') {
    payload = {
      microsoftClientId: draft.microsoftClientId,
      microsoftClientSecret: draft.microsoftClientSecret,
      clearMicrosoftClientSecret: draft.clearMicrosoftClientSecret,
      microsoftTenantId: draft.microsoftTenantId,
    };
  } else if (scope === 'brand') {
    payload = {
      siteName: draft.siteName,
      logoMode: draft.logoMode,
      logoUrl: draft.logoUrl,
      ...(draft.logoMode === 'upload'
        ? {
            logoUploadDataUrl: draft.logoUploadDataUrl,
            logoUploadFilename: draft.logoUploadFilename,
          }
        : {}),
    };
  } else if (scope === 'storage') {
    payload = {
      storageProvider: draft.storageProvider,
      storageSyncPolicy: draft.storageSyncPolicy,
      storageRemotePathPrefix: draft.storageRemotePathPrefix,
      storageS3Bucket: draft.storageS3Bucket,
      storageS3Region: draft.storageS3Region,
      storageS3Endpoint: draft.storageS3Endpoint,
      storageS3AccessKey: draft.storageS3AccessKey,
      storageS3Secret: draft.storageS3Secret,
      storageS3ForcePathStyle: draft.storageS3ForcePathStyle,
      storageWebdavUrl: draft.storageWebdavUrl,
      storageWebdavUsername: draft.storageWebdavUsername,
      storageWebdavPassword: draft.storageWebdavPassword,
      storageFtpHost: draft.storageFtpHost,
      storageFtpPort: draft.storageFtpPort,
      storageFtpSecure: draft.storageFtpSecure,
      storageFtpUsername: draft.storageFtpUsername,
      storageFtpPassword: draft.storageFtpPassword,
    };
  } else if (scope === 'backup') {
    payload = {
      backupEnabled: draft.backupEnabled,
      backupIntervalHours: draft.backupIntervalHours,
      backupTarget: draft.backupTarget,
      backupRetentionCount: draft.backupRetentionCount,
      backupContentMode: draft.backupContentMode,
      backupIncludeRuntimeFiles: draft.backupIncludeRuntimeFiles,
    };
  } else if (scope === 'theme') {
    payload = {
      themePresetId: draft.themePresetId,
    };
  } else if (scope === 'proxy') {
    payload = {
      outboundProxyMode: draft.outboundProxyMode,
      outboundProxyUrl: draft.outboundProxyUrl,
      outboundProxyBypass: draft.outboundProxyBypass,
    };
  } else if (scope === 'translation') {
    payload = {
      translationProvider: draft.translationProvider,
      translationTargetLanguage: draft.translationTargetLanguage,
      translationBaseUrl: draft.translationBaseUrl,
      translationRegion: draft.translationRegion,
      translationModel: draft.translationModel,
      translationApiKey: draft.translationApiKey,
      clearTranslationApiKey: draft.clearTranslationApiKey,
    };
  } else {
    payload = {
      siteName: draft.siteName,
      logoMode: draft.logoMode,
      logoUrl: draft.logoUrl,
      ...(draft.logoMode === 'upload'
        ? {
            logoUploadDataUrl: draft.logoUploadDataUrl,
            logoUploadFilename: draft.logoUploadFilename,
          }
        : {}),
      googleClientId: draft.googleClientId,
      googleClientSecret: draft.googleClientSecret,
      microsoftClientId: draft.microsoftClientId,
      microsoftClientSecret: draft.microsoftClientSecret,
      clearMicrosoftClientSecret: draft.clearMicrosoftClientSecret,
      microsoftTenantId: draft.microsoftTenantId,
      registrationEnabled: draft.registrationEnabled,
      registrationEmailVerificationRequired: draft.registrationEmailVerificationRequired,
      registrationEmailDomainWhitelist: draft.registrationEmailDomainWhitelist,
      passwordResetEnabled: draft.passwordResetEnabled,
      sessionTimeoutValue: draft.sessionTimeoutValue,
      sessionTimeoutUnit: draft.sessionTimeoutUnit,
      smtpHost: draft.smtpHost,
      smtpPort: draft.smtpPort,
      smtpSecure: draft.smtpSecure,
      smtpUsername: draft.smtpUsername,
      smtpPassword: draft.smtpPassword,
      clearSmtpPassword: draft.clearSmtpPassword,
      smtpFromName: draft.smtpFromName,
      smtpFromEmail: draft.smtpFromEmail,
      translationProvider: draft.translationProvider,
      translationTargetLanguage: draft.translationTargetLanguage,
      translationBaseUrl: draft.translationBaseUrl,
      translationRegion: draft.translationRegion,
      translationModel: draft.translationModel,
      translationApiKey: draft.translationApiKey,
      clearTranslationApiKey: draft.clearTranslationApiKey,
      storageProvider: draft.storageProvider,
      storageSyncPolicy: draft.storageSyncPolicy,
      storageRemotePathPrefix: draft.storageRemotePathPrefix,
      storageS3Bucket: draft.storageS3Bucket,
      storageS3Region: draft.storageS3Region,
      storageS3Endpoint: draft.storageS3Endpoint,
      storageS3AccessKey: draft.storageS3AccessKey,
      storageS3Secret: draft.storageS3Secret,
      storageS3ForcePathStyle: draft.storageS3ForcePathStyle,
      storageWebdavUrl: draft.storageWebdavUrl,
      storageWebdavUsername: draft.storageWebdavUsername,
      storageWebdavPassword: draft.storageWebdavPassword,
      storageFtpHost: draft.storageFtpHost,
      storageFtpPort: draft.storageFtpPort,
      storageFtpSecure: draft.storageFtpSecure,
      storageFtpUsername: draft.storageFtpUsername,
      storageFtpPassword: draft.storageFtpPassword,
      backupEnabled: draft.backupEnabled,
      backupIntervalHours: draft.backupIntervalHours,
      backupTarget: draft.backupTarget,
      backupRetentionCount: draft.backupRetentionCount,
      backupContentMode: draft.backupContentMode,
      backupIncludeRuntimeFiles: draft.backupIncludeRuntimeFiles,
      outboundProxyMode: draft.outboundProxyMode,
      outboundProxyUrl: draft.outboundProxyUrl,
      outboundProxyBypass: draft.outboundProxyBypass,
      themePresetId: draft.themePresetId,
    };
  }
  const data = await api('/api/system-settings', {
    method: 'PUT',
    body: JSON.stringify(payload),
  });

  applyLoadedSystemSettings(data.settings || {});
  if (state.mailboxDraft?.provider === 'outlook') {
    state.mailboxDraft.microsoftClientId = systemMicrosoftClientId();
    state.mailboxDraft.microsoftTenantId = systemMicrosoftTenantId();
    if (!state.mailboxImportModalOpen) {
      state.mailboxImportDraft = createMailboxImportDraft();
    }
  }
  applySystemSettingsToDocument();
  state.notice = {
    text:
      scope === 'google'
        ? 'Google 应用配置已保存。'
        : scope === 'storage'
          ? '远程存储配置已保存。'
          : scope === 'backup'
            ? '系统备份配置已保存。'
            : scope === 'microsoft'
              ? 'Microsoft 应用配置已保存。'
              : scope === 'auth'
                ? '注册与找回密码设置已保存。'
                : scope === 'smtp'
                  ? 'SMTP 邮件配置已保存。'
                  : scope === 'brand'
                    ? '站点品牌已保存。'
                    : scope === 'translation'
                      ? '翻译引擎配置已保存。'
                      : scope === 'theme'
                        ? '主题模板已保存。'
                        : scope === 'proxy'
                          ? '外网代理配置已保存。'
                          : '系统设置已保存。',
    tone: 'success',
  };
}

async function deleteSelectedMailboxes() {
  const selectedIds = Array.from(
    new Set((state.selectedMailboxIds || []).map((mailboxId) => String(mailboxId || '').trim()).filter(Boolean)),
  );
  if (!selectedIds.length) {
    throw new Error('请先勾选要删除的邮箱。');
  }

  const confirmed = await openConfirmDialog({
    eyebrow: '邮箱删除',
    title: `确认删除 ${selectedIds.length} 个邮箱？`,
    message: `将要删除 ${selectedIds.length} 个邮箱，以及它们已同步到系统的本地邮件。确定继续吗？`,
    confirmLabel: '删除邮箱',
    cancelLabel: '先取消',
    tone: 'danger',
    icon: 'warning',
  });
  if (!confirmed) {
    return;
  }

  const currentEditingMailboxId = state.editingMailboxId || state.mailboxDraft?.mailboxId || '';
  await api('/api/mailboxes/bulk-delete', {
    method: 'POST',
    body: JSON.stringify({
      mailboxIds: selectedIds,
    }),
  });

  clearMailboxSelection();
  if (currentEditingMailboxId && selectedIds.includes(currentEditingMailboxId)) {
    resetMailboxComposer();
  }

  await refreshWorkspace();
  state.notice = {
    text: `已删除 ${selectedIds.length} 个邮箱。`,
    tone: 'success',
  };
}

function backupDestinationLabel(destination = 'local') {
  return destination === 'remote' ? '远程存储' : destination === 'both' ? '本地 + 远程' : '本地';
}

function backupContentModeLabel(contentMode = 'database_and_site') {
  return contentMode === 'database_only'
    ? '仅备份数据库'
    : contentMode === 'site_only'
      ? '仅备份网站数据'
      : '备份数据库 + 网站数据';
}

function backupRestoreComponentLabel(component = '') {
  const normalizedComponent = String(component || '').trim();
  return BACKUP_RESTORE_COMPONENT_LABELS[normalizedComponent] || normalizedComponent || '未命名内容';
}

function normalizeBackupRestoreMode(value = '', fallback = 'full_site_data') {
  const normalizedMode = String(value || fallback || 'full_site_data').trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(BACKUP_RESTORE_MODE_LABELS, normalizedMode)
    ? normalizedMode
    : 'full_site_data';
}

function backupRestoreModeLabel(mode = '') {
  const normalizedMode = normalizeBackupRestoreMode(mode);
  return BACKUP_RESTORE_MODE_LABELS[normalizedMode] || BACKUP_RESTORE_MODE_LABELS.full_site_data;
}

function clearBackupRestoreSelection() {
  state.backupRestoreFile = null;
  state.backupRestoreFilename = '';
}

async function handleBackupRestoreFileChange(input) {
  const file = input?.files?.[0];
  if (!file) {
    clearBackupRestoreSelection();
    redraw();
    return;
  }

  const filename = String(file.name || '').trim();
  const lowerName = filename.toLowerCase();
  const isZipLike =
    lowerName.endsWith('.zip') ||
    String(file.type || '').trim() === 'application/zip' ||
    String(file.type || '').trim() === 'application/x-zip-compressed';
  if (!isZipLike) {
    throw new Error('请上传系统导出的 ZIP 备份数据包。');
  }

  state.backupRestoreFile = file;
  state.backupRestoreFilename = filename || '未命名备份包.zip';
  state.notice = {
    text: `已选择还原包：${state.backupRestoreFilename}。确认后会先自动生成一份恢复前安全备份，再执行系统还原。`,
    tone: 'info',
  };
  redraw();
}

async function restoreBackupArchive() {
  if (!state.backupRestoreFile) {
    throw new Error('请先选择一个系统备份 ZIP 数据包。');
  }

  const restoreMode = normalizeBackupRestoreMode(state.backupRestoreMode);
  const restoreModeLabel = backupRestoreModeLabel(restoreMode);
  const confirmed = await openConfirmDialog({
    eyebrow: '系统还原',
    title: '确认覆盖当前系统数据？',
    message:
      restoreMode === 'database_only'
        ? '系统会先自动生成一份恢复前安全备份，然后仅覆盖当前数据库。还原完成后，当前后台会退出登录。'
        : restoreMode === 'attachments_only'
          ? '系统会先自动生成一份恢复前安全备份，然后仅覆盖当前本地附件目录。数据库、日志和 .env 配置不会被改动。'
          : '系统会先自动生成一份恢复前安全备份，然后按备份包内的数据完整恢复数据库、本地附件目录、日志和 .env 配置。若恢复包包含数据库，当前后台会退出登录。',
    confirmLabel: '开始还原',
    cancelLabel: '先取消',
    tone: 'danger',
    icon: 'warning',
  });
  if (!confirmed) {
    return;
  }

  state.backupRestoreLoading = true;
  redraw();

  try {
    const response = await fetch(`/api/backups/restore?mode=${encodeURIComponent(restoreMode)}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/zip',
      },
      body: state.backupRestoreFile,
    });

    let payload = {};
    try {
      payload = await response.json();
    } catch (_) {
      payload = {};
    }

    if (!response.ok) {
      throw new Error(payload.error || '系统还原失败。');
    }

    const restoredComponents = Array.isArray(payload.restoredComponents)
      ? payload.restoredComponents.map((item) => backupRestoreComponentLabel(item)).filter(Boolean)
      : [];
    const clearedComponents = Array.isArray(payload.clearedComponents)
      ? payload.clearedComponents.map((item) => backupRestoreComponentLabel(item)).filter(Boolean)
      : [];
    const warnings = Array.isArray(payload.warnings)
      ? payload.warnings.map((item) => String(item || '').trim()).filter(Boolean)
      : [];
    const safetyBackupFilename = String(payload?.safetyBackup?.filename || '').trim();
    const noticeParts = [`系统还原已完成（${restoreModeLabel}）`];

    if (restoredComponents.length) {
      noticeParts.push(`已恢复：${restoredComponents.join('、')}`);
    }
    if (clearedComponents.length) {
      noticeParts.push(`已清空：${clearedComponents.join('、')}`);
    }
    if (safetyBackupFilename) {
      noticeParts.push(`恢复前安全备份：${safetyBackupFilename}（位于 runtime/backups）`);
    }
    if (payload.restartRecommended) {
      noticeParts.push('恢复包涉及 .env 配置，请手动重启服务后再继续使用');
    }
    if (payload.requiresReauth) {
      noticeParts.push('数据库已恢复，当前后台需要重新登录');
    }
    if (warnings.length) {
      noticeParts.push(`恢复提醒：${warnings.join('；')}`);
    }

    clearBackupRestoreSelection();
    state.notice = {
      text: noticeParts.join('；'),
      tone: warnings.length ? 'info' : 'success',
    };

    if (Array.isArray(payload.backups)) {
      state.backups = payload.backups;
    }

    if (payload.requiresReauth) {
      stopWorkspaceAutoRefresh();
      try {
        await loadSystemSettings();
      } catch (_) {
        // Ignore refresh failure after restoring and signing out.
      }
      state.user = null;
      state.usersForAssignment = [];
      state.dashboard = null;
      state.backups = [];
      state.notifications = null;
      state.authMode = 'login';
      state.view = 'dashboard';
      replacePortalPath('/login');
      redraw();
      return;
    }
  } finally {
    state.backupRestoreLoading = false;
  }
}

async function runBackup(destination = 'local', backupContentMode = '') {
  const resolvedContentMode =
    String(
      backupContentMode
      || state.systemSettingsDraft?.backupContentMode
      || state.systemSettings?.backupContentMode
      || 'database_and_site',
    ).trim() || 'database_and_site';
  const resolvedDestination =
    String(
      destination
      || state.backupRunDestination
      || state.systemSettingsDraft?.backupTarget
      || state.systemSettings?.backupTarget
      || 'local',
    ).trim() || 'local';
  state.systemSettingsDraft = {
    ...createSystemSettingsDraft(state.systemSettingsDraft || state.systemSettings),
    ...(state.systemSettingsDraft || {}),
    backupContentMode: resolvedContentMode,
    backupIncludeRuntimeFiles: resolvedContentMode !== 'database_only',
  };
  state.backupRunDestination = resolvedDestination;
  state.backupRunContentMode = resolvedContentMode;
  state.backupRunLoading = resolvedDestination;
  redraw();

  try {
    const data = await api('/api/backups/run', {
      method: 'POST',
      body: JSON.stringify({
        destination: resolvedDestination,
        backupContentMode: resolvedContentMode,
      }),
    });

    state.backups = data.backups || [];
    state.notice = {
      text: `系统备份已开始执行，目标：${backupDestinationLabel(resolvedDestination)}，内容：${backupContentModeLabel(resolvedContentMode)}。`,
      tone: 'success',
    };
  } finally {
    state.backupRunLoading = '';
  }
}

async function refreshBackups() {
  await loadBackups();
  state.notice = {
    text: '备份记录已刷新。',
    tone: 'success',
  };
}

function downloadBackup(downloadUrl) {
  if (!downloadUrl) {
    throw new Error('当前备份文件暂时不可下载。');
  }

  window.location.assign(downloadUrl);
}

async function deleteBackupById(backupId = '') {
  const normalizedBackupId = String(backupId || '').trim();
  if (!normalizedBackupId) {
    throw new Error('未找到要删除的备份记录。');
  }

  const backup = (state.backups || []).find((item) => String(item?.id || '').trim() === normalizedBackupId);
  const backupName = String(backup?.filename || '这条备份记录').trim() || '这条备份记录';
  const confirmed = await openConfirmDialog({
    eyebrow: '删除备份',
    title: '删除这条备份记录？',
    message: `删除后会一并清理本地备份文件和可访问的远程备份路径：${backupName}`,
    confirmLabel: '删除备份',
    cancelLabel: '取消',
    tone: 'danger',
    icon: 'warning',
  });
  if (!confirmed) {
    return;
  }

  state.backupDeleteLoadingId = normalizedBackupId;
  redraw();

  try {
    const data = await api(`/api/backups/${encodeURIComponent(normalizedBackupId)}`, {
      method: 'DELETE',
    });
    state.backups = Array.isArray(data.backups) ? data.backups : [];
    const warnings = Array.isArray(data.warnings)
      ? data.warnings.map((item) => String(item || '').trim()).filter(Boolean)
      : [];
    state.notice = {
      text: warnings.length
        ? `备份记录已删除，但有 ${warnings.length} 条清理提醒：${warnings.join('；')}`
        : '备份记录已删除。',
      tone: warnings.length ? 'info' : 'success',
    };
  } finally {
    state.backupDeleteLoadingId = '';
  }
}

async function testSystemSmtpConnection(form) {
  if (!form) {
    return;
  }

  const payload = buildSmtpSystemSettingsPayload(form, { includeTestEmail: false });
  state.systemSmtpConnectionLoading = true;
  state.systemSmtpConnectionResult = null;
  redraw();

  try {
    const data = await api('/api/system-settings/test-smtp?mode=verify', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    state.systemSmtpConnectionResult = {
      tone: 'success',
      text: String(data.message || 'SMTP 连接测试成功。').trim() || 'SMTP 连接测试成功。',
    };
    state.notice = {
      text: state.systemSmtpConnectionResult.text,
      tone: 'success',
    };
  } catch (error) {
    state.systemSmtpConnectionResult = {
      tone: 'error',
      text: String(error.message || error).trim() || 'SMTP 连接测试失败。',
    };
    state.notice = {
      text: state.systemSmtpConnectionResult.text,
      tone: 'error',
    };
  } finally {
    state.systemSmtpConnectionLoading = false;
    redraw();
  }
}

async function sendSystemSmtpTestEmail(form) {
  if (!form) {
    return;
  }

  const payload = buildSmtpSystemSettingsPayload(form);
  state.systemSmtpTestLoading = true;
  state.systemSmtpTestResult = null;
  redraw();

  try {
    const data = await api('/api/system-settings/test-smtp?mode=draft', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    state.systemSmtpTestResult = {
      tone: 'success',
      text: String(data.message || 'SMTP 测试成功。').trim() || 'SMTP 测试成功。',
    };
    state.notice = {
      text: state.systemSmtpTestResult.text,
      tone: 'success',
    };
  } catch (error) {
    state.systemSmtpTestResult = {
      tone: 'error',
      text: String(error.message || error).trim() || 'SMTP 测试失败。',
    };
    state.notice = {
      text: state.systemSmtpTestResult.text,
      tone: 'error',
    };
  } finally {
    state.systemSmtpTestLoading = false;
    redraw();
  }
}

async function testSystemTranslationSettings(form) {
  if (!form) {
    return;
  }

  const payload = buildTranslationSystemSettingsPayload(form);
  state.systemTranslationTestLoading = true;
  state.systemTranslationTestResult = null;
  redraw();

  try {
    const data = await api('/api/system-settings/test-translation', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    const translatedPreview = String(
      data.test?.translatedBody || data.test?.translatedSubject || '',
    ).trim();
    state.systemTranslationTestResult = {
      tone: 'success',
      text: String(data.message || '翻译配置测试通过。').trim() || '翻译配置测试通过。',
      providerLabel: String(data.test?.providerLabel || '').trim(),
      targetLanguage: String(data.test?.targetLanguage || '').trim(),
      fallbackNotice: String(data.test?.fallbackNotice || '').trim(),
      translatedPreview,
    };
    state.notice = {
      text: '翻译配置测试通过。',
      tone: 'success',
    };
  } catch (error) {
    state.systemTranslationTestResult = {
      tone: 'error',
      text: String(error.message || error || '翻译配置测试失败。').trim() || '翻译配置测试失败。',
      providerLabel: '',
      targetLanguage: '',
      fallbackNotice: '',
      translatedPreview: '',
    };
    state.notice = {
      text: String(error.message || error || '翻译配置测试失败。').trim() || '翻译配置测试失败。',
      tone: 'error',
    };
  } finally {
    state.systemTranslationTestLoading = false;
  }
}

async function testSystemProxySettings(form) {
  if (!form) {
    return;
  }

  const payload = buildProxySystemSettingsPayload(form);
  state.systemProxyTestLoading = true;
  state.systemProxyTestResult = null;
  redraw();

  try {
    const data = await api('/api/system-settings/test-proxy', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    const proxyTest = data.proxyTest || {};
    const passed = Number(proxyTest.successCount || 0) >= Number(proxyTest.totalCount || 0);
    state.systemProxyTestResult = {
      tone: passed ? 'success' : 'error',
      text:
        String(data.message || '').trim()
        || (passed ? '外网代理连通测试通过。' : '外网代理测试未全部通过。'),
      targets: Array.isArray(proxyTest.targets) ? proxyTest.targets : [],
    };
    state.notice = {
      text: state.systemProxyTestResult.text,
      tone: passed ? 'success' : 'error',
    };
  } catch (error) {
    state.systemProxyTestResult = {
      tone: 'error',
      text: String(error.message || error || '外网代理测试失败。').trim() || '外网代理测试失败。',
      targets: [],
    };
    state.notice = {
      text: state.systemProxyTestResult.text,
      tone: 'error',
    };
  } finally {
    state.systemProxyTestLoading = false;
  }
}

async function testSystemStorageSettings(form) {
  if (!form) {
    return;
  }

  const payload = buildStorageSystemSettingsPayload(form);
  state.systemStorageTestLoading = true;
  state.systemStorageTestResult = null;
  redraw();

  try {
    const data = await api('/api/system-settings/test-storage', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    const test = data.test || {};
    state.systemStorageTestResult = {
      tone: 'success',
      text: String(data.message || test.message || '远程存储测试通过。').trim() || '远程存储测试通过。',
      provider: String(test.provider || payload.storageProvider || '').trim(),
      remotePath: String(test.remotePath || '').trim(),
      remoteUrl: String(test.remoteUrl || '').trim(),
      deleted: Boolean(test.deleted),
      writable: Boolean(test.writable),
    };
    state.notice = {
      text: state.systemStorageTestResult.text,
      tone: 'success',
    };
  } catch (error) {
    state.systemStorageTestResult = {
      tone: 'error',
      text: String(error.message || error || '远程存储测试失败。').trim() || '远程存储测试失败。',
      provider: String(payload.storageProvider || '').trim(),
      remotePath: '',
      remoteUrl: '',
      deleted: false,
      writable: false,
    };
    state.notice = {
      text: state.systemStorageTestResult.text,
      tone: 'error',
    };
  } finally {
    state.systemStorageTestLoading = false;
  }
}

async function saveNotification(form) {
  const formData = new FormData(form);
  const channel = form.dataset.channel || String(form.dataset.form || '').replace('notification-', '');
  const templateOptionsLabel = String(form.dataset.templateOptionsLabel || '').trim();
  if (form.dataset.form === 'notification-template-options') {
    syncNotificationTemplateOptionsDraftFromForm(form);
  }
  const wecomKind = String(form.dataset.wecomKind || formData.get('mode') || '').trim().toLowerCase() === 'app' ? 'app' : 'bot';
  const currentWecom = state.notifications?.wecom || {};
  const currentWecomMode = String(currentWecom.mode || 'bot').trim().toLowerCase() === 'app' ? 'app' : 'bot';
  const requestedWecomEnabled = formData.get('enabled') === 'on';
  const nextWecomMode =
    requestedWecomEnabled
      ? wecomKind
      : Boolean(currentWecom.enabled) && currentWecomMode !== wecomKind
        ? currentWecomMode
        : wecomKind;
  const nextWecomEnabled =
    requestedWecomEnabled
      ? true
      : Boolean(currentWecom.enabled) && currentWecomMode !== wecomKind;

  const payload =
    channel === 'telegram'
      ? {
          enabled: formData.get('enabled') === 'on',
          botToken: formData.get('botToken'),
          chatId: formData.get('chatId'),
        }
      : channel === 'wecom'
        ? {
            enabled: nextWecomEnabled,
            mode: nextWecomMode,
            botId: formData.get('botId'),
            botSecret: formData.get('botSecret'),
            targetId: formData.get('targetId'),
            corpId: formData.get('corpId'),
            agentId: formData.get('agentId'),
            receiverType: formData.get('receiverType') || 'user',
            receiverId: formData.get('receiverId'),
            appBaseUrl: formData.get('appBaseUrl'),
            callbackToken: formData.get('callbackToken'),
            encodingAesKey: formData.get('encodingAesKey'),
            appSecret: formData.get('appSecret'),
          }
        : channel === 'template'
          ? {
              presetId: formData.get('presetId'),
              ...(form.dataset.form === 'notification-template-options'
                ? {
                    options: notificationTemplateOptionsFromForm(form),
                  }
                : {
                    templates: Object.fromEntries(
                      NOTIFICATION_TEMPLATE_CHANNELS.map((item) => [item, formData.get(item) || '']),
                    ),
                  }),
            }
          : {
              enabled: formData.get('enabled') === 'on',
              webhookUrl: formData.get('webhookUrl'),
              signSecret: formData.get('signSecret'),
            };

  await api(`/api/notifications/${channel}`, {
    method: 'PUT',
    body: JSON.stringify(payload),
  });

  await loadNotifications();
  if (REVEALABLE_NOTIFICATION_CHANNELS.includes(channel)) {
    clearNotificationConfigState(channel);
    syncNotificationDraftsFromSettings(channel, { force: true });
  }
  if (channel === 'wecom') {
    startWecomDiscoveryAutoRefresh();
  }
  if (channel === 'template') {
    state.notificationCoverEditorCategory = '';
    updateNotificationTemplatePreview();
  }

  state.notice =
    channel === 'template' && form.dataset.form === 'notification-template-options' && templateOptionsLabel
      ? {
          text: `${templateOptionsLabel}已保存。`,
          tone: 'success',
        }
      : {
          text: `${notificationLabel(channel)}通知配置已保存。`,
          tone: 'success',
        };
}

async function testMailbox() {
  const form = document.querySelector('[data-form="mailbox"]');
  if (!form) return;
  const payload = mailboxPayloadFromForm(form);
  if (isGmailOauthPayload(payload) && !state.mailboxDraft?.oauthConfigured) {
    throw new Error('Gmail 的 Google OAuth2 模式不需要密码测试，请先点击“连接 Google”完成授权。');
  }
  if (
    isMicrosoftOauthPayload(payload) &&
    !state.mailboxDraft?.oauthConfigured &&
    !hasManualMicrosoftRefreshToken(payload)
  ) {
    throw new Error('Outlook 的 Microsoft OAuth2 模式不需要密码测试，请先点击“连接 Microsoft”完成授权。');
  }

  setMailboxNotice('正在测试连接，请稍等…', 'info');

  const data = await api('/api/mailboxes/test', {
    method: 'POST',
    body: JSON.stringify(payload),
  });

  state.mailboxNotice = {
    text: `连接成功，邮箱里当前大约有 ${data.probe.exists} 封邮件。`,
    tone: 'success',
  };
}

async function syncAllVisible() {
  await api('/api/sync-all', { method: 'POST', body: '{}' });
  state.notice = { text: '当前可见邮箱已发起同步。', tone: 'success' };
  await refreshWorkspace();
}

async function openMailboxFolder(mailboxId, folder = 'all') {
  state.view = 'inbox';
  state.selectedMailboxId = mailboxId || '';
  state.inboxFolder = folder || 'all';
  state.selectedMessageId = null;
  state.selectedMessage = null;
  clearMessageSelection();
  closeMessageReader();
  window.location.hash = 'inbox';
  await loadMessages();
}

function setView(view) {
  stopWecomDiscoveryAutoRefresh();
  finishMailboxDragCleanup();
  state.topbarAccountMenuOpen = false;
  shouldFocusMailboxSearch = false;
  shouldFocusMailboxToolbarOwnerSearch = false;
  state.mailboxToolbarOwnerFilterOpen = false;
  state.mailboxOwnerFilterOpen = false;
  state.inboxOwnerFilterOpen = false;
  state.inboxMailboxFilterOpen = false;
  shouldFocusMailboxOwnerSearch = false;
  shouldFocusInboxOwnerSearch = false;
  shouldFocusInboxMailboxSearch = false;
  if (view !== 'mailboxes' && state.mailboxModalOpen) {
    closeMailboxModal();
  }
  if (view !== 'mailboxes' && state.mailboxImportModalOpen) {
    closeMailboxImportModal();
  }
  if (view !== 'users' && state.userModalOpen) {
    closeUserComposer();
  }
  if (view !== 'inbox' && state.messageReaderOpen) {
    closeMessageReader();
  }
  if (state.attachmentPreviewModal) {
    closeAttachmentPreviewModal();
  }
  if (view !== 'notifications') {
    closeNotificationGuide();
    closeNotificationEmojiGuide();
    state.notificationCoverEditorCategory = '';
    state.notificationChannelEditorKey = '';
  }
  if (view !== 'system') {
    closeSystemGoogleGuide();
    closeSystemMicrosoftGuide();
  }
  if (view === 'inbox' && state.view !== 'inbox') {
    state.inboxFolder = 'all';
    state.selectedMailboxId = '';
    state.selectedMessageId = null;
    state.selectedMessage = null;
    clearMessageSelection();
    closeMessageReader();
  }
  state.view = menuItems(state).some((item) => item.id === view) ? view : 'dashboard';
  window.location.hash = state.view;
  redraw();

  if (state.user) {
    loadViewData(state.view)
      .then(() => redraw())
      .catch(() => {});
  }

  scheduleWorkspaceAutoRefresh(1200);

  if (state.view === 'notifications' && state.user) {
    startWecomDiscoveryAutoRefresh(2, 800);
  }
}

function fillWecomTarget(targetId) {
  const normalizedTargetId = String(targetId || '');
  state.notificationDrafts.wecom = {
    ...createNotificationDraft('wecom', state.notifications?.wecom || null),
    ...(state.notificationDrafts.wecom || {}),
    targetId: normalizedTargetId,
  };
  const form = document.querySelector('[data-form="notification-wecom-bot"]');
  const input = form?.querySelector('[name="targetId"]');
  if (!input) {
    return true;
  }

  input.value = normalizedTargetId;
  syncNotificationDraftFromForm(form);
  return true;
}

async function saveWecomTargetSelection(targetId) {
  const current = state.notifications?.wecom || {};
  const currentMode = String(current.mode || 'bot').trim().toLowerCase() === 'app' ? 'app' : 'bot';
  const currentEnabled = Boolean(current.enabled);

  await api('/api/notifications/wecom', {
    method: 'PUT',
    body: JSON.stringify({
      enabled: currentEnabled,
      mode: currentEnabled ? currentMode : 'bot',
      botId: current.botId,
      targetId,
    }),
  });

  await loadNotifications();
  fillWecomTarget(targetId);
}

document.addEventListener('submit', async (event) => {
  const form = event.target.closest('form');
  if (!form) return;
  event.preventDefault();

  try {
    if (form.dataset.form === 'login') await login(form);
    if (form.dataset.form === 'register') await register(form);
    if (form.dataset.form === 'forgot-password') await resetPassword(form);
    if (form.dataset.form === 'mailbox') await saveMailbox(form);
    if (form.dataset.form === 'mailbox-import') await saveMicrosoftMailboxImport(form);
    if (form.dataset.form === 'mailbox-interval') await saveMailboxInterval(form);
    if (form.dataset.form === 'user') await saveUser(form);
    if (form.dataset.form === 'profile') await saveProfile(form);
    if (form.dataset.form === 'system-settings') await saveSystemSettings(form);
    if (form.dataset.form === 'backup-settings') await saveSystemSettings(form, 'backup');
    if (String(form.dataset.form || '').startsWith('notification-')) {
      await saveNotification(form);
    }
    redraw();
  } catch (error) {
    if (form.dataset.form === 'mailbox-import') {
      state.mailboxImportNotice = { text: error.message, tone: 'error' };
      redraw();
    } else if (isMailboxInteraction(form)) {
      setMailboxNotice(error.message, 'error');
    } else {
      setNotice(error.message, 'error');
    }
  }
});

document.addEventListener('click', async (event) => {
  const clickedInsideMailboxToolbarOwnerFilter = Boolean(event.target.closest('[data-mailbox-toolbar-owner-filter]'));
  const clickedInsideMailboxOwnerFilter = Boolean(event.target.closest('[data-mailbox-owner-filter]'));
  const clickedInsideInboxOwnerFilter = Boolean(event.target.closest('[data-inbox-owner-filter]'));
  const clickedInsideInboxMailboxFilter = Boolean(event.target.closest('[data-inbox-mailbox-filter]'));
  const clickedInsideMailboxColumns = Boolean(event.target.closest('[data-mailbox-columns]'));
  const clickedInsideTopbarAccount = Boolean(event.target.closest('[data-topbar-account]'));
  const clickedInsideVersionWidget = Boolean(event.target.closest('[data-version-widget]'));
  let closedInlineFilter = false;
  if (state.mailboxToolbarOwnerFilterOpen && !clickedInsideMailboxToolbarOwnerFilter) {
    state.mailboxToolbarOwnerFilterOpen = false;
    shouldFocusMailboxToolbarOwnerSearch = false;
    clearSearchComposition('mailbox-toolbar-owner-search');
    closedInlineFilter = true;
  }
  if (state.mailboxOwnerFilterOpen && !clickedInsideMailboxOwnerFilter) {
    state.mailboxOwnerFilterOpen = false;
    shouldFocusMailboxOwnerSearch = false;
    clearSearchComposition('mailbox-owner-search');
    closedInlineFilter = true;
  }
  if (state.inboxOwnerFilterOpen && !clickedInsideInboxOwnerFilter) {
    state.inboxOwnerFilterOpen = false;
    shouldFocusInboxOwnerSearch = false;
    clearSearchComposition('inbox-owner-search');
    closedInlineFilter = true;
  }
  if (state.inboxMailboxFilterOpen && !clickedInsideInboxMailboxFilter) {
    state.inboxMailboxFilterOpen = false;
    shouldFocusInboxMailboxSearch = false;
    clearSearchComposition('inbox-mailbox-search');
    closedInlineFilter = true;
  }
  if (state.topbarAccountMenuOpen && !clickedInsideTopbarAccount) {
    state.topbarAccountMenuOpen = false;
    closedInlineFilter = true;
  }
  if (state.mailboxColumnMenuOpen && !clickedInsideMailboxColumns) {
    state.mailboxColumnMenuOpen = false;
    closedInlineFilter = true;
  }
  if (state.appVersionPopoverOpen && !clickedInsideVersionWidget) {
    state.appVersionPopoverOpen = false;
    closedInlineFilter = true;
  }
  if (
    closedInlineFilter &&
    !event.target.closest(
      '[data-action], [data-view], [data-version-widget], [data-mailbox-guide-overlay], [data-mailbox-import-overlay], [data-notification-guide-overlay], [data-notification-cover-editor-overlay], [data-notification-channel-editor-overlay], [data-notification-tool-overlay], [data-system-google-guide-overlay], [data-system-microsoft-guide-overlay], [data-mailbox-overlay], [data-user-overlay], [data-message-reader-overlay], [data-attachment-preview-overlay], [data-confirm-overlay]',
    )
  ) {
    redraw();
    return;
  }

  if (event.target.matches('[data-mailbox-guide-overlay]')) {
    closeMailboxGuide();
    redraw();
    return;
  }

  if (event.target.matches('[data-notification-guide-overlay]')) {
    closeNotificationGuide();
    redraw();
    return;
  }

  if (event.target.matches('[data-notification-cover-editor-overlay]')) {
    const notificationTemplateOptionsForm =
      event.target.closest('[data-form="notification-template-options"]')
      || document.querySelector('[data-form="notification-template-options"]');
    if (notificationTemplateOptionsForm) {
      syncNotificationTemplateOptionsDraftFromForm(notificationTemplateOptionsForm);
    }
    state.notificationCoverEditorCategory = '';
    redraw();
    return;
  }

  if (event.target.matches('[data-notification-channel-editor-overlay]')) {
    syncActiveNotificationChannelEditorDraft();
    state.notificationChannelEditorKey = '';
    redraw();
    return;
  }

  if (event.target.matches('[data-notification-tool-overlay]')) {
    state.notificationToolModalKey = '';
    redraw();
    return;
  }

  if (event.target.matches('[data-system-google-guide-overlay]')) {
    closeSystemGoogleGuide();
    redraw();
    return;
  }

  if (event.target.matches('[data-system-microsoft-guide-overlay]')) {
    closeSystemMicrosoftGuide();
    redraw();
    return;
  }

  if (event.target.matches('[data-emoji-guide-overlay]')) {
    closeNotificationEmojiGuide();
    redraw();
    return;
  }

  if (event.target.matches('[data-mailbox-overlay]')) {
    closeMailboxModal();
    redraw();
    return;
  }

  if (event.target.matches('[data-mailbox-import-overlay]')) {
    closeMailboxImportModal();
    redraw();
    return;
  }

  if (event.target.matches('[data-user-overlay]')) {
    closeUserComposer();
    redraw();
    return;
  }

  if (event.target.matches('[data-message-reader-overlay]')) {
    closeMessageReader();
    redraw();
    return;
  }

  if (event.target.matches('[data-attachment-preview-overlay]')) {
    closeAttachmentPreviewModal();
    redraw();
    return;
  }

  if (event.target.matches('[data-confirm-overlay]')) {
    resolveConfirmDialog(false);
    redraw();
    return;
  }

  const target = event.target.closest('[data-action], [data-view]');
  if (!target) return;

  try {
    if (target.dataset.view) {
      setView(target.dataset.view);
      return;
    }

    const { action } = target.dataset;
    if (action === 'toggle-theme') {
      applyTheme(state.theme === 'dark' ? 'light' : 'dark');
      redraw();
      return;
    }
    if (action === 'toggle-topbar-account-menu') {
      state.topbarAccountMenuOpen = !state.topbarAccountMenuOpen;
      redraw();
      return;
    }
    if (action === 'toggle-mailbox-column-menu') {
      state.mailboxColumnMenuOpen = !state.mailboxColumnMenuOpen;
      redraw();
      return;
    }
    if (action === 'open-profile-from-account') {
      state.topbarAccountMenuOpen = false;
      setView('profile');
      return;
    }
    if (action === 'toggle-sidebar') {
      state.sidebarCollapsed = !state.sidebarCollapsed;
      persistSidebarCollapsed();
      redraw();
      return;
    }
    if (action === 'toggle-app-version-popover') {
      state.appVersionPopoverOpen = !state.appVersionPopoverOpen;
      redraw();
      if (state.appVersionPopoverOpen && state.user && !state.appVersion.checkedAt && !state.appVersionCheckLoading) {
        await checkAppVersion({ force: false });
        redraw();
      }
      return;
    }
    if (action === 'check-app-version') {
      state.appVersionPopoverOpen = true;
      await checkAppVersion({ force: true });
      redraw();
      return;
    }
    if (action === 'start-app-update') {
      state.appVersionPopoverOpen = true;
      await startAppUpdate();
      redraw();
      return;
    }
    if (action === 'open-attachment-preview-modal') {
      if (openAttachmentPreviewModalFromElement(target)) {
        redraw();
      }
      return;
    }
    if (action === 'close-attachment-preview-modal') {
      closeAttachmentPreviewModal();
      redraw();
      return;
    }
    if (action === 'close-confirm-dialog') {
      resolveConfirmDialog(false);
      redraw();
      return;
    }
    if (action === 'confirm-dialog-confirm') {
      resolveConfirmDialog(true);
      redraw();
      return;
    }
    if (action === 'toggle-mailbox-toolbar-owner-filter') {
      state.mailboxToolbarOwnerFilterOpen = !state.mailboxToolbarOwnerFilterOpen;
      shouldFocusMailboxToolbarOwnerSearch = state.mailboxToolbarOwnerFilterOpen;
      if (!state.mailboxToolbarOwnerFilterOpen) {
        clearSearchComposition('mailbox-toolbar-owner-search');
      }
      redraw();
      return;
    }
    if (action === 'owner-filter' && Object.prototype.hasOwnProperty.call(target.dataset, 'userId')) {
      state.selectedOwnerUserId = target.dataset.userId || '';
      state.mailboxPage = 1;
      state.inboxPage = 1;
      clearMailboxSelection();
      if (!state.editingMailboxId && state.mailboxDraft) {
        state.mailboxDraft.ownerUserId = target.dataset.userId || state.user.id;
      }
      state.mailboxToolbarOwnerFilterOpen = false;
      state.mailboxToolbarOwnerSearch = '';
      shouldFocusMailboxToolbarOwnerSearch = false;
      clearSearchComposition('mailbox-toolbar-owner-search');
      state.inboxOwnerFilterOpen = false;
      shouldFocusInboxOwnerSearch = false;
      clearSearchComposition('inbox-owner-search');
      state.inboxMailboxFilterOpen = false;
      clearSearchComposition('inbox-mailbox-search');
      clearMessageSelection();
      closeMessageReader();
      await refreshWorkspace();
      redraw();
      return;
    }
    if (action === 'toggle-mailbox-owner-filter') {
      state.mailboxOwnerFilterOpen = !state.mailboxOwnerFilterOpen;
      shouldFocusMailboxOwnerSearch = state.mailboxOwnerFilterOpen;
      if (!state.mailboxOwnerFilterOpen) {
        clearSearchComposition('mailbox-owner-search');
      }
      redraw();
      return;
    }
    if (action === 'select-mailbox-owner') {
      state.mailboxDraft = {
        ...(state.mailboxDraft || {}),
        ownerUserId: target.dataset.userId || state.mailboxDraft?.ownerUserId || state.user?.id || '',
      };
      state.mailboxOwnerFilterOpen = false;
      state.mailboxOwnerSearch = '';
      shouldFocusMailboxOwnerSearch = false;
      clearSearchComposition('mailbox-owner-search');
      redraw();
      return;
    }
    if (action === 'toggle-inbox-owner-filter') {
      state.inboxOwnerFilterOpen = !state.inboxOwnerFilterOpen;
      state.inboxMailboxFilterOpen = false;
      shouldFocusInboxOwnerSearch = state.inboxOwnerFilterOpen;
      shouldFocusInboxMailboxSearch = false;
      clearSearchComposition('inbox-mailbox-search');
      if (!state.inboxOwnerFilterOpen) {
        clearSearchComposition('inbox-owner-search');
      }
      redraw();
      return;
    }
    if (action === 'select-inbox-owner') {
      state.selectedOwnerUserId = target.dataset.userId || '';
      state.inboxOwnerFilterOpen = false;
      state.inboxPage = 1;
      shouldFocusInboxOwnerSearch = false;
      clearSearchComposition('inbox-owner-search');
      state.selectedMessageId = null;
      state.selectedMessage = null;
      clearMessageSelection();
      closeMessageReader();
      await refreshWorkspace();
      redraw();
      return;
    }
    if (action === 'toggle-inbox-mailbox-filter') {
      state.inboxMailboxFilterOpen = !state.inboxMailboxFilterOpen;
      state.inboxOwnerFilterOpen = false;
      shouldFocusInboxMailboxSearch = state.inboxMailboxFilterOpen;
      shouldFocusInboxOwnerSearch = false;
      clearSearchComposition('inbox-owner-search');
      if (!state.inboxMailboxFilterOpen) {
        clearSearchComposition('inbox-mailbox-search');
      }
      redraw();
      return;
    }
    if (action === 'select-inbox-mailbox') {
      state.selectedMailboxId = target.dataset.mailboxId || '';
      state.inboxMailboxFilterOpen = false;
      state.inboxOwnerFilterOpen = false;
      state.inboxPage = 1;
      shouldFocusInboxMailboxSearch = false;
      shouldFocusInboxOwnerSearch = false;
      clearSearchComposition('inbox-mailbox-search');
      clearSearchComposition('inbox-owner-search');
      state.selectedMessageId = null;
      state.selectedMessage = null;
      clearMessageSelection();
      closeMessageReader();
      await loadMessages();
      scheduleWorkspaceAutoRefresh();
      redraw();
      return;
    }
    if (action === 'scroll-public-section') {
      const targetId = String(target.dataset.target || '').trim();
      const requestedMode = String(target.dataset.mode || '').trim();
      const shouldSwitchMode = requestedMode === 'register' || requestedMode === 'login';
      if (shouldSwitchMode) {
        state.authMode = requestedMode;
        state.notice = null;
        redraw();
      }
      requestAnimationFrame(() => {
        const section = document.getElementById(targetId);
        section?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
      return;
    }
    if (action === 'switch-auth-mode') {
      state.authMode = normalizeAuthMode(target.dataset.mode, state.portalKind, state.systemSettings);
      state.notice = null;
      state.authCodeResult = null;
      redraw();
      if (!state.user) {
        requestAnimationFrame(() => {
          document.querySelector('.auth-portal-card, .public-auth-card')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
      }
      return;
    }
    if (action === 'toggle-notification-config-visibility') {
      const notificationForm = target.closest('form');
      if (notificationForm) {
        syncNotificationDraftFromForm(notificationForm);
      }
      await toggleNotificationConfigVisibility(target.dataset.channel || '', target.dataset.field || '');
      redraw();
      return;
    }
    if (action === 'toggle-system-google-secret-visibility') {
      await toggleSystemGoogleSecretVisibility(target.closest('form'));
      return;
    }
    if (action === 'toggle-system-microsoft-secret-visibility') {
      await toggleSystemMicrosoftSecretVisibility(target.closest('form'));
      return;
    }
    if (action === 'toggle-system-smtp-password-visibility') {
      await toggleSystemSmtpPasswordVisibility(target.closest('form'));
      return;
    }
    if (action === 'toggle-system-storage-secret-visibility') {
      await toggleSystemStorageSecretVisibility(target.dataset.field || '', target.closest('form'));
      return;
    }
    if (action === 'toggle-system-translation-api-key-visibility') {
      await toggleSystemTranslationApiKeyVisibility(target.closest('form'));
      return;
    }
    if (action === 'switch-system-settings-group') {
      const nextGroup = String(target.dataset.group || '').trim() || 'general';
      const form = findSystemSettingsForm(target);
      if (form) {
        syncSystemSettingsDraftFromForm(form);
      }
      state.systemSettingsGroup = nextGroup;
      if (nextGroup === 'metadata' && state.user?.role === 'admin') {
        await loadAttachmentMetadata();
      }
      redraw();
      requestAnimationFrame(() => {
        document.querySelector('.system-settings-shell')?.scrollIntoView({
          behavior: 'smooth',
          block: 'start',
        });
      });
      return;
    }
    if (action === 'reload-attachment-metadata') {
      clearAttachmentMetadataSelection();
      await loadAttachmentMetadata();
      redraw();
      return;
    }
    if (action === 'go-attachment-page') {
      const nextPage = normalizePageNumber(target.dataset.page || 1, state.attachmentMetadataPage);
      if (nextPage !== state.attachmentMetadataPage) {
        state.attachmentMetadataPage = nextPage;
        clearAttachmentMetadataSelection();
        await loadAttachmentMetadata();
      }
      redraw();
      return;
    }
    if (action === 'jump-attachment-page') {
      const jumpInput = target.closest('.pagination-jump')?.querySelector('[data-page-input="attachment"]');
      const nextPage = normalizePageNumber(jumpInput?.value || state.attachmentMetadataPage, state.attachmentMetadataPage);
      if (nextPage !== state.attachmentMetadataPage) {
        state.attachmentMetadataPage = nextPage;
        clearAttachmentMetadataSelection();
        await loadAttachmentMetadata();
      }
      redraw();
      return;
    }
    if (action === 'sync-selected-mailbox-attachments') {
      await syncSelectedMailboxAttachments();
      redraw();
      return;
    }
    if (action === 'bulk-delete-attachment-metadata') {
      await bulkDeleteAttachmentMetadata();
      redraw();
      return;
    }
    if (action === 'remove-registration-domain') {
      removeRegistrationWhitelistDomain(target.dataset.domain || '');
      redraw();
      return;
    }
    if (action === 'save-google-system-settings') {
      await saveSystemSettings(target.closest('form'), 'google');
      redraw();
      return;
    }
    if (action === 'save-auth-system-settings') {
      await saveSystemSettings(target.closest('form'), 'auth');
      redraw();
      return;
    }
    if (action === 'save-smtp-system-settings') {
      await saveSystemSettings(target.closest('form'), 'smtp');
      redraw();
      return;
    }
    if (action === 'save-microsoft-system-settings') {
      await saveSystemSettings(target.closest('form'), 'microsoft');
      redraw();
      return;
    }
    if (action === 'save-storage-system-settings') {
      await saveSystemSettings(target.closest('form'), 'storage');
      redraw();
      return;
    }
    if (action === 'test-storage-system-settings') {
      await testSystemStorageSettings(target.closest('form'));
      redraw();
      return;
    }
    if (action === 'save-proxy-system-settings') {
      await saveSystemSettings(target.closest('form'), 'proxy');
      redraw();
      return;
    }
    if (action === 'save-backup-system-settings') {
      await saveSystemSettings(target.closest('form'), 'backup');
      redraw();
      return;
    }
    if (action === 'save-translation-system-settings') {
      await saveSystemSettings(target.closest('form'), 'translation');
      redraw();
      return;
    }
    if (action === 'test-translation-system-settings') {
      await testSystemTranslationSettings(target.closest('form'));
      redraw();
      return;
    }
    if (action === 'test-smtp-connection') {
      await testSystemSmtpConnection(target.closest('form'));
      redraw();
      return;
    }
    if (action === 'test-smtp-system-settings') {
      await sendSystemSmtpTestEmail(target.closest('form'));
      redraw();
      return;
    }
    if (action === 'send-smtp-test-email') {
      await sendSystemSmtpTestEmail(target.closest('form'));
      redraw();
      return;
    }
    if (action === 'test-proxy-system-settings') {
      await testSystemProxySettings(target.closest('form'));
      redraw();
      return;
    }
    if (action === 'send-auth-email-code') {
      await requestAuthEmailCode(target.closest('form'), target.dataset.purpose || 'register');
      redraw();
      return;
    }
    if (action === 'save-brand-system-settings') {
      await saveSystemSettings(target.closest('form'), 'brand');
      redraw();
      return;
    }
    if (action === 'save-theme-system-settings') {
      await saveSystemSettings(target.closest('form'), 'theme');
      redraw();
      return;
    }
    if (action === 'logout') {
      await api('/api/auth/logout', { method: 'POST', body: '{}' });
      stopWorkspaceAutoRefresh();
      state.user = null;
      state.topbarAccountMenuOpen = false;
      state.appVersionPopoverOpen = false;
      clearNotificationConfigState();
      clearNotificationDraftState();
      state.backups = [];
      state.backupRunLoading = '';
      clearBackupRestoreSelection();
      state.backupRestoreLoading = false;
      state.authMode = 'login';
      state.view = 'dashboard';
      replacePortalPath('/login');
      state.editingUserId = null;
      state.userModalOpen = false;
      state.notice = { text: '你已退出登录。', tone: 'info' };
      redraw();
      return;
    }
    if (action === 'test-mailbox') {
      await testMailbox();
      redraw();
      return;
    }
    if (action === 'start-google-oauth') {
      await startGoogleOauthForMailbox(target.closest('form'));
      redraw();
      return;
    }
    if (action === 'start-microsoft-oauth') {
      await startMicrosoftOauthForMailbox(target.closest('form'));
      redraw();
      return;
    }
    if (action === 'set-outlook-entry-mode') {
      const form = target.closest('form');
      const nextMode = String(target.dataset.mode || '').trim() || 'graph_only';
      if (form) {
        const modeInput = form.querySelector('input[name="microsoftProtocolMode"]');
        if (modeInput) {
          modeInput.value = nextMode;
        }
        state.mailboxNotice = null;
        state.mailboxPasswordVisible = false;
        syncMailboxDraftFromForm(form);
        redraw();
      }
      return;
    }
    if (action === 'create-mailbox') {
      openMailboxCreateModal();
      redraw();
      return;
    }
    if (action === 'open-microsoft-mailbox-import') {
      openMicrosoftMailboxImportModal();
      redraw();
      return;
    }
    if (action === 'close-mailbox-import-modal') {
      closeMailboxImportModal();
      redraw();
      return;
    }
    if (action === 'open-mailbox-guide') {
      openMailboxGuide();
      redraw();
      return;
    }
    if (action === 'open-notification-guide') {
      openNotificationGuide(target.dataset.channel || '');
      redraw();
      return;
    }
    if (action === 'open-notification-cover-editor') {
      const notificationTemplateOptionsForm =
        target.closest('[data-form="notification-template-options"]')
        || document.querySelector('[data-form="notification-template-options"]');
      if (notificationTemplateOptionsForm) {
        syncNotificationTemplateOptionsDraftFromForm(notificationTemplateOptionsForm);
      } else {
        syncNotificationTemplateOptionsDraft();
      }
      state.notificationCoverEditorCategory = String(target.dataset.category || '').trim();
      redraw();
      return;
    }
    if (action === 'close-notification-cover-editor') {
      const notificationTemplateOptionsForm =
        target.closest('[data-form="notification-template-options"]')
        || document.querySelector('[data-form="notification-template-options"]');
      if (notificationTemplateOptionsForm) {
        syncNotificationTemplateOptionsDraftFromForm(notificationTemplateOptionsForm);
      }
      state.notificationCoverEditorCategory = '';
      redraw();
      return;
    }
    if (action === 'open-notification-channel-editor') {
      const editorKey = String(target.dataset.editor || '').trim();
      const editorChannel = editorKey.startsWith('wecom') ? 'wecom' : editorKey;
      if (REVEALABLE_NOTIFICATION_CHANNELS.includes(editorChannel)) {
        syncNotificationDraftsFromSettings(editorChannel);
      }
      state.notificationChannelEditorKey = editorKey;
      redraw();
      return;
    }
    if (action === 'close-notification-channel-editor') {
      syncActiveNotificationChannelEditorDraft();
      state.notificationChannelEditorKey = '';
      redraw();
      return;
    }
    if (action === 'open-notification-tool-modal') {
      state.notificationToolModalKey = String(target.dataset.tool || '').trim();
      redraw();
      return;
    }
    if (action === 'close-notification-tool-modal') {
      state.notificationToolModalKey = '';
      redraw();
      return;
    }
    if (action === 'open-notification-emoji-guide') {
      openNotificationEmojiGuide();
      redraw();
      return;
    }
    if (action === 'open-system-google-guide') {
      openSystemGoogleGuide();
      redraw();
      return;
    }
    if (action === 'open-system-microsoft-guide') {
      openSystemMicrosoftGuide();
      redraw();
      return;
    }
    if (action === 'toggle-mailbox-password') {
      await toggleMailboxPasswordVisibility();
      return;
    }
    if (action === 'close-mailbox-guide') {
      closeMailboxGuide();
      redraw();
      return;
    }
    if (action === 'close-notification-guide') {
      closeNotificationGuide();
      redraw();
      return;
    }
    if (action === 'close-notification-emoji-guide') {
      closeNotificationEmojiGuide();
      redraw();
      return;
    }
    if (action === 'close-system-google-guide') {
      closeSystemGoogleGuide();
      redraw();
      return;
    }
    if (action === 'close-system-microsoft-guide') {
      closeSystemMicrosoftGuide();
      redraw();
      return;
    }
    if (action === 'create-user') {
      openUserComposer();
      redraw();
      return;
    }
    if (action === 'set-mailbox-provider-filter') {
      state.mailboxProviderFilter = target.dataset.provider || 'all';
      state.mailboxPage = 1;
      clearMailboxSelection();
      redraw();
      return;
    }
    if (action === 'sync-all') {
      await syncAllVisible();
      redraw();
      return;
    }
    if (action === 'refresh-backups') {
      await refreshBackups();
      redraw();
      return;
    }
    if (action === 'run-backup') {
      const runPanel = target.closest('[data-backup-run-panel="true"]');
      const backupDestination = String(
        runPanel?.querySelector?.('[name="backupRunDestination"]')?.value
        || target.dataset.destination
        || state.backupRunDestination
        || state.systemSettingsDraft?.backupTarget
        || state.systemSettings?.backupTarget
        || 'local',
      ).trim() || 'local';
      const backupContentMode = String(
        runPanel?.querySelector?.('[name="backupRunContentMode"]')?.value
        || state.backupRunContentMode
        || state.systemSettingsDraft?.backupContentMode
        || state.systemSettings?.backupContentMode
        || 'database_and_site',
      ).trim() || 'database_and_site';
      await runBackup(backupDestination, backupContentMode);
      redraw();
      return;
    }
    if (action === 'download-backup') {
      downloadBackup(target.dataset.url || '');
      return;
    }
    if (action === 'delete-backup') {
      await deleteBackupById(target.dataset.backupId || '');
      redraw();
      return;
    }
    if (action === 'restore-backup') {
      await restoreBackupArchive();
      redraw();
      return;
    }
    if (action === 'set-inbox-folder') {
      state.inboxFolder = target.dataset.folder || 'all';
      state.inboxPage = 1;
      state.selectedMessageId = null;
      state.selectedMessage = null;
      clearMessageSelection();
      closeMessageReader();
      await loadMessages();
      redraw();
      return;
    }
    if (action === 'select-template-preset') {
      setNotificationTemplatePreset(target.dataset.presetId || notificationTemplateSetting().presetId);
      return;
    }
    if (action === 'load-template-preset') {
      loadNotificationTemplatePreset();
      return;
    }
    if (action === 'test-notification') {
      const payload = await api(`/api/notifications/${target.dataset.channel}/test`, {
        method: 'POST',
        body: '{}',
      });
      state.notice = buildNotificationTestNotice(target.dataset.channel, payload);
      redraw();
      return;
    }
    if (action === 'refresh-wecom-discovery') {
      await loadNotifications();
      startWecomDiscoveryAutoRefresh(3, 1200);
      state.notice = { text: '企业微信会话助手已刷新。', tone: 'success' };
      redraw();
      return;
    }
    if (action === 'use-wecom-target') {
      const targetId = target.dataset.targetId || '';
      if (!targetId || !fillWecomTarget(targetId)) {
        throw new Error('未找到企业微信目标 ID 输入框。');
      }
      await saveWecomTargetSelection(targetId);
      state.notice = { text: `已自动保存目标 ID：${targetId}`, tone: 'success' };
      redraw();
      return;
    }
    if (action === 'test-notification') {
      const payload = await api(`/api/notifications/${target.dataset.channel}/test`, {
        method: 'POST',
        body: '{}',
      });
      state.notice = buildNotificationTestNotice(target.dataset.channel, payload);
      redraw();
      return;
    }
    if (action === 'refresh-wecom-discovery') {
      await loadNotifications();
      startWecomDiscoveryAutoRefresh(3, 1200);
      state.notice = { text: '企业微信会话助手已刷新。', tone: 'success' };
      redraw();
      return;
    }
    if (action === 'use-wecom-target') {
      const targetId = target.dataset.targetId || '';
      if (!targetId || !fillWecomTarget(targetId)) {
        throw new Error('未找到企业微信会话 ID 输入框。');
      }
      await saveWecomTargetSelection(targetId);
      state.notice = { text: `已自动保存目标 ID：${targetId}`, tone: 'success' };
      redraw();
      return;
    }
    if (action === 'sync-mailbox') {
      await api(`/api/mailboxes/${target.dataset.mailboxId}/sync`, {
        method: 'POST',
        body: '{}',
      });
      state.notice = { text: '邮箱同步已完成。', tone: 'success' };
      await refreshWorkspace();
      redraw();
      return;
    }
    if (action === 'bulk-delete-mailboxes') {
      await deleteSelectedMailboxes();
      redraw();
      return;
    }
    if (action === 'toggle-mailbox-pin') {
      const mailboxId = target.dataset.mailboxId || '';
      const nextPinned = target.dataset.nextPinned === 'true';
      if (!mailboxId) {
        throw new Error('未找到要更新的邮箱。');
      }

      await updateMailboxDisplay(mailboxId, { isPinned: nextPinned });
      state.notice = {
        text: nextPinned ? '邮箱已置顶。' : '邮箱已取消置顶。',
        tone: 'success',
      };
      await refreshWorkspace();
      redraw();
      return;
    }
    if (action === 'open-mailbox-modal' || action === 'edit-mailbox') {
      if (Date.now() < suppressMailboxOpenUntil) {
        return;
      }
      openMailboxEditor(target.dataset.mailboxId);
      redraw();
      return;
    }
    if (action === 'open-mailbox-folder') {
      await openMailboxFolder(target.dataset.mailboxId || '', target.dataset.folder || 'unread');
      redraw();
      return;
    }
    if (action === 'cancel-mailbox-edit' || action === 'close-mailbox-modal') {
      closeMailboxModal();
      redraw();
      return;
    }
    if (action === 'delete-mailbox') {
      const confirmed = await openConfirmDialog({
        eyebrow: '邮箱删除',
        title: '确认删除这个邮箱？',
        message: '删除该邮箱后，本地同步邮件也会一起删除。确定继续吗？',
        confirmLabel: '删除邮箱',
        cancelLabel: '先取消',
        tone: 'danger',
        icon: 'warning',
      });
      if (!confirmed) return;
      await api(`/api/mailboxes/${target.dataset.mailboxId}`, { method: 'DELETE' });
      clearMailboxSelection();
      state.notice = { text: '邮箱已删除。', tone: 'success' };
      await refreshWorkspace();
      redraw();
      return;
    }
    if (action === 'go-mailbox-page') {
      state.mailboxPage = normalizePageNumber(target.dataset.page || 1, state.mailboxPage);
      redraw();
      return;
    }
    if (action === 'go-inbox-page') {
      const nextPage = normalizePageNumber(target.dataset.page || 1, state.inboxPage);
      if (nextPage !== state.inboxPage) {
        state.inboxPage = nextPage;
        clearMessageSelection();
        closeMessageReader();
        await loadMessages();
      }
      redraw();
      return;
    }
    if (action === 'jump-mailbox-page') {
      const jumpInput = target.closest('.pagination-jump')?.querySelector('[data-page-input="mailbox"]');
      state.mailboxPage = normalizePageNumber(jumpInput?.value || state.mailboxPage, state.mailboxPage);
      redraw();
      return;
    }
    if (action === 'jump-inbox-page') {
      const jumpInput = target.closest('.pagination-jump')?.querySelector('[data-page-input="inbox"]');
      const nextPage = normalizePageNumber(jumpInput?.value || state.inboxPage, state.inboxPage);
      if (nextPage !== state.inboxPage) {
        state.inboxPage = nextPage;
        clearMessageSelection();
        closeMessageReader();
        await loadMessages();
      }
      redraw();
      return;
    }
    if (action === 'select-message' || action === 'open-message') {
      await openMessage(target.dataset.messageId, { switchToInbox: action === 'open-message' });
      redraw();
      return;
    }
    if (action === 'close-message-reader') {
      closeMessageReader();
      redraw();
      return;
    }
    if (action === 'delete-current-message') {
      await deleteCurrentMessage(target.dataset.messageId);
      redraw();
      return;
    }
    if (action === 'toggle-message-read') {
      const messageId = target.dataset.messageId;
      const nextRead = target.dataset.nextRead === 'true';
      if (!messageId) {
        throw new Error('未找到要更新的邮件。');
      }

      await updateMessageState(messageId, { isRead: nextRead });
      redraw();
      return;
    }
    if (action === 'toggle-message-star') {
      const messageId = target.dataset.messageId;
      const sourceMessage =
        state.messages.find((message) => message.id === messageId) ||
        (state.selectedMessage?.id === messageId ? state.selectedMessage : null);
      if (!messageId || !sourceMessage) {
        throw new Error('未找到要更新的邮件。');
      }

      await updateMessageState(messageId, { isStarred: !sourceMessage.isStarred });
      redraw();
      return;
    }
    if (action === 'translate-message') {
      await translateSelectedMessage(target.dataset.messageId || state.selectedMessageId);
      redraw();
      return;
    }
    if (action === 'bulk-message-state') {
      const mode = target.dataset.mode || '';
      if (mode === 'read') {
        await applyBulkMessageState({ isRead: true }, '已将所选邮件标记为已读。');
      } else if (mode === 'unread') {
        await applyBulkMessageState({ isRead: false }, '已将所选邮件标记为未读。');
      } else if (mode === 'star') {
        await applyBulkMessageState({ isStarred: true }, '已为所选邮件加上星标。');
      } else if (mode === 'unstar') {
        await applyBulkMessageState({ isStarred: false }, '已取消所选邮件的星标。');
      }
      redraw();
      return;
    }
    if (action === 'bulk-delete-messages') {
      await deleteSelectedMessages();
      redraw();
      return;
    }
    if (action === 'edit-user') {
      openUserComposer(target.dataset.userId);
      redraw();
      return;
    }
    if (action === 'cancel-user-edit' || action === 'close-user-modal') {
      closeUserComposer();
      redraw();
      return;
    }
    if (action === 'refresh-inbox') {
      await loadMailboxes();
      await loadMessages();
      await loadDashboard();
      redraw();
    }
  } catch (error) {
    if (isMailboxInteraction(target)) {
      setMailboxNotice(error.message, 'error');
    } else {
      setNotice(error.message, 'error');
    }
  }
});

document.addEventListener('change', async (event) => {
  const target = event.target;

  try {
    const backupRunPanel = target?.closest?.('[data-backup-run-panel="true"]');
    if (backupRunPanel) {
      if (target.name === 'backupRunContentMode') {
        state.backupRunContentMode = String(target.value || '').trim() || 'database_and_site';
        redraw();
        return;
      }
      if (target.name === 'backupRunDestination') {
        state.backupRunDestination = String(target.value || '').trim() || 'local';
        redraw();
        return;
      }
    }

    if (target?.dataset?.action === 'registration-whitelist-input') {
      state.systemRegistrationWhitelistInput = String(target.value || '');
      if (addRegistrationWhitelistDomains(target.value)) {
        redraw();
      }
      return;
    }

    if (target?.name === 'smtpTestEmail') {
      state.systemSmtpTestEmail = String(target.value || '').trim();
    }

    if (target?.name === 'backupRestoreFile') {
      await handleBackupRestoreFileChange(target);
      return;
    }

    if (target?.name === 'backupRestoreMode') {
      state.backupRestoreMode = normalizeBackupRestoreMode(target.value, state.backupRestoreMode);
      redraw();
      return;
    }

    const notificationTemplateOptionsForm = target?.closest?.('[data-form="notification-template-options"]');
    if (notificationTemplateOptionsForm && String(target.name || '').endsWith('UploadFile')) {
      await handleNotificationCoverUploadChange(target);
      syncNotificationTemplateOptionsDraftFromForm(notificationTemplateOptionsForm);
      return;
    }
    if (notificationTemplateOptionsForm) {
      syncNotificationTemplateOptionsDraftFromForm(notificationTemplateOptionsForm);
      const coverCategory = notificationCoverCategoryFromFieldName(target.name || '');
      if (coverCategory) {
        syncNotificationCoverPreviewFromForm(notificationTemplateOptionsForm, coverCategory);
      }
    }

    const systemSettingsForm = findSystemSettingsForm(target);
    if (systemSettingsForm) {
      if (target.name === 'logoUploadFile') {
        await handleSystemLogoUploadChange(target);
        redraw();
        return;
      }
      syncSystemSettingsDraftFromForm(systemSettingsForm);
      state.authMode = normalizeAuthMode(state.authMode, state.portalKind, state.systemSettingsDraft);
      if (isAuthSystemSettingsField(target)) {
        state.authCodeResult = null;
      }
      if (isSmtpSystemSettingsField(target)) {
        state.systemSmtpTestResult = null;
        state.systemSmtpConnectionResult = null;
      }
      if (isTranslationSystemSettingsField(target)) {
        state.systemTranslationTestResult = null;
      }
      if (isStorageSystemSettingsField(target)) {
        state.systemStorageTestResult = null;
      }
      if (
        target.name === 'outboundProxyMode'
        || target.name === 'outboundProxyUrl'
        || target.name === 'outboundProxyBypass'
      ) {
        state.systemProxyTestResult = null;
      }
      if (
        target.name === 'translationProvider'
        || target.name === 'logoMode'
        || target.name === 'storageProvider'
        || target.name === 'themePresetId'
        || target.name === 'clearTranslationApiKey'
        || target.name === 'clearMicrosoftClientSecret'
        || target.name === 'clearSmtpPassword'
        || target.name === 'outboundProxyMode'
      ) {
        if (target.name === 'translationProvider') {
          state.systemTranslationApiKeyVisible = false;
          state.systemTranslationApiKeyLoading = false;
        }
        if (target.name === 'storageProvider') {
          state.systemStorageSecretVisibility = {
            storageS3Secret: false,
            storageWebdavPassword: false,
            storageFtpPassword: false,
          };
          state.systemStorageSecretLoading = {
            storageS3Secret: false,
            storageWebdavPassword: false,
            storageFtpPassword: false,
          };
          state.systemStorageTestResult = null;
        }
        redraw();
      } else if (
        target.name === 'registrationEnabled'
        || target.name === 'registrationEmailVerificationRequired'
        || target.name === 'passwordResetEnabled'
        || target.name === 'smtpSecure'
      ) {
        redraw();
      } else if (systemSettingsForm.dataset.form === 'backup-settings') {
        redraw();
      } else if (isSmtpSystemSettingsField(target)) {
        redraw();
      }
    }

    const notificationForm = target.closest('[data-channel="telegram"], [data-channel="wecom"], [data-channel="feishu"]');
    if (notificationForm) {
      syncNotificationDraftFromForm(notificationForm);
    }
    if (target.dataset.action === 'toggle-message-select') {
      setMessageSelected(target.dataset.messageId || '', target.checked);
      redraw();
      return;
    }
    if (target.dataset.action === 'toggle-select-all-visible') {
      if (target.checked) {
        state.selectedMessageIds = state.messages.map((message) => message.id);
      } else {
        clearMessageSelection();
      }
      redraw();
      return;
    }
    if (target.dataset.action === 'toggle-mailbox-select') {
      setMailboxSelected(target.dataset.mailboxId || '', target.checked);
      redraw();
      return;
    }
    if (target.dataset.action === 'toggle-select-all-visible-mailboxes') {
      const currentPageIds = visibleMailboxPageIds();
      if (target.checked) {
        state.selectedMailboxIds = Array.from(new Set([...(state.selectedMailboxIds || []), ...currentPageIds]));
      } else {
        const visibleSet = new Set(currentPageIds);
        state.selectedMailboxIds = (state.selectedMailboxIds || []).filter((mailboxId) => !visibleSet.has(mailboxId));
      }
      redraw();
      return;
    }
    if (target.dataset.action === 'toggle-attachment-metadata-select') {
      setAttachmentMetadataSelected(target.dataset.selectionId || '', target.checked);
      redraw();
      return;
    }
    if (target.dataset.action === 'toggle-select-all-visible-attachments') {
      const currentPageIds = visibleAttachmentMetadataSelectionIds();
      if (target.checked) {
        state.attachmentMetadataSelectedIds = Array.from(new Set([...(state.attachmentMetadataSelectedIds || []), ...currentPageIds]));
      } else {
        const visibleSet = new Set(currentPageIds);
        state.attachmentMetadataSelectedIds = (state.attachmentMetadataSelectedIds || []).filter((selectionId) => !visibleSet.has(selectionId));
      }
      redraw();
      return;
    }
    if (target.dataset.action === 'toggle-mailbox-visible-field') {
      setMailboxVisibleField(target.dataset.field || '', target.checked);
      redraw();
      return;
    }
    if (target.dataset.action === 'mailbox-page-size') {
      state.mailboxPageSize = normalizePageSize(target.value, state.mailboxPageSize);
      state.mailboxPage = 1;
      clearMailboxSelection();
      redraw();
      return;
    }
    if (target.dataset.action === 'inbox-page-size') {
      state.inboxPageSize = normalizePageSize(target.value, state.inboxPageSize);
      state.inboxPage = 1;
      clearMessageSelection();
      closeMessageReader();
      await loadMessages();
      redraw();
      return;
    }
    if (target.dataset.action === 'attachment-page-size') {
      state.attachmentMetadataPageSize = normalizePageSize(target.value, state.attachmentMetadataPageSize);
      state.attachmentMetadataPage = 1;
      clearAttachmentMetadataSelection();
      await loadAttachmentMetadata();
      redraw();
      return;
    }
    if (target.dataset.action === 'provider-change') {
      const form = target.closest('form');
      const preset = providerPreset(target.value);
        if (form && preset) {
          state.mailboxNotice = null;
          state.mailboxPasswordVisible = false;
          const currentDraft = state.mailboxDraft || {};
          const nextDraft = createMailboxDraft(target.value);
          state.mailboxDraft = {
            ...nextDraft,
            mailboxId: currentDraft.mailboxId || '',
            ownerUserId: currentDraft.ownerUserId || state.user.id,
            name: currentDraft.name || '',
            email: currentDraft.email || '',
            username: currentDraft.username || '',
            syncAttachments:
              Object.prototype.hasOwnProperty.call(currentDraft, 'syncAttachments')
                ? Boolean(currentDraft.syncAttachments)
                : true,
            sortOrder: Number(currentDraft.sortOrder ?? nextDraft.sortOrder ?? 100),
            syncIntervalSeconds: Number(currentDraft.syncIntervalSeconds || nextDraft.syncIntervalSeconds || 5),
            isPinned: Boolean(currentDraft.isPinned),
            secure: Boolean(
              Object.prototype.hasOwnProperty.call(currentDraft, 'secure')
                ? currentDraft.secure
                : nextDraft.secure,
            ),
          };
          redraw();
        }
      return;
    }
    if (target.dataset.action === 'auth-type-change') {
      const form = target.closest('form');
      state.mailboxNotice = null;
      state.mailboxPasswordVisible = false;
      syncMailboxDraftFromForm(form);
      redraw();
      return;
    }
    if (target.dataset.action === 'outlook-entry-mode') {
      const form = target.closest('form');
      state.mailboxNotice = null;
      state.mailboxPasswordVisible = false;
      syncMailboxDraftFromForm(form);
      redraw();
      return;
    }
    if (target.dataset.action === 'owner-filter') {
      state.selectedOwnerUserId = target.value;
      state.mailboxPage = 1;
      state.inboxPage = 1;
      clearMailboxSelection();
      if (!state.editingMailboxId && state.mailboxDraft) {
        state.mailboxDraft.ownerUserId = target.value || state.user.id;
      }
      state.mailboxToolbarOwnerFilterOpen = false;
      state.mailboxToolbarOwnerSearch = '';
      shouldFocusMailboxToolbarOwnerSearch = false;
      state.inboxOwnerFilterOpen = false;
      shouldFocusInboxOwnerSearch = false;
      state.inboxMailboxFilterOpen = false;
      clearMessageSelection();
      closeMessageReader();
      await refreshWorkspace();
      redraw();
      return;
    }
    if (target.dataset.action === 'mailbox-filter') {
      state.selectedMailboxId = target.value;
      state.inboxMailboxFilterOpen = false;
      state.inboxPage = 1;
      state.selectedMessageId = null;
      state.selectedMessage = null;
      clearMessageSelection();
      closeMessageReader();
      await loadMessages();
      scheduleWorkspaceAutoRefresh();
      redraw();
      return;
    }

    const mailboxForm = target.closest('[data-form="mailbox"]');
    if (mailboxForm) {
      syncMailboxDraftFromForm(mailboxForm);
    }
  } catch (error) {
    setNotice(error.message, 'error');
  }
});

document.addEventListener('dblclick', (event) => {
  if (event.target.closest('a, button, input, textarea, select, label')) {
    return;
  }

  const trigger = event.target.closest('[data-attachment-preview-open]');
  if (!trigger) {
    return;
  }

  if (openAttachmentPreviewModalFromElement(trigger)) {
    redraw();
  }
});

document.addEventListener('mouseover', (event) => {
  const trigger = event.target.closest('[data-attachment-hover-preview="true"]');
  if (!trigger) {
    return;
  }

  if (activeAttachmentHoverTrigger === trigger) {
    positionAttachmentHoverPreview(event);
    return;
  }

  showAttachmentHoverPreview(trigger, event);
});

document.addEventListener('mousemove', (event) => {
  if (!activeAttachmentHoverTrigger) {
    return;
  }

  positionAttachmentHoverPreview(event);
});

document.addEventListener('mouseout', (event) => {
  if (!activeAttachmentHoverTrigger) {
    return;
  }

  const leavingTrigger = event.target.closest('[data-attachment-hover-preview="true"]');
  if (leavingTrigger !== activeAttachmentHoverTrigger) {
    return;
  }

  const nextTrigger = event.relatedTarget?.closest?.('[data-attachment-hover-preview="true"]');
  if (nextTrigger === activeAttachmentHoverTrigger) {
    return;
  }

  hideAttachmentHoverPreview();
});

document.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) {
    return;
  }

  const trigger = event.target.closest('.mailbox-row-main');
  if (
    !trigger ||
    event.target.closest('.mailbox-row-select, .mailbox-row-actions, a, input, select, textarea, label')
  ) {
    return;
  }

  const card = trigger.closest('.mailbox-row-card[data-mailbox-id]');
  if (!card) {
    return;
  }

  cancelMailboxDragHold();
  mailboxDragHoldState = {
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    trigger,
    timer: window.setTimeout(() => {
      beginMailboxDrag(trigger, event);
      mailboxDragHoldState = null;
    }, MAILBOX_DRAG_HOLD_MS),
  };
});

document.addEventListener('pointermove', (event) => {
  if (mailboxDragState) {
    updateMailboxDrag(event);
    return;
  }

  if (!mailboxDragHoldState || mailboxDragHoldState.pointerId !== event.pointerId) {
    return;
  }

  const movedEnough =
    Math.abs(event.clientX - mailboxDragHoldState.startX) > 6 ||
    Math.abs(event.clientY - mailboxDragHoldState.startY) > 6;
  if (movedEnough) {
    cancelMailboxDragHold();
  }
});

document.addEventListener('pointerup', async (event) => {
  if (mailboxDragState && mailboxDragState.pointerId === event.pointerId) {
    await completeMailboxDrag();
    return;
  }

  if (mailboxDragHoldState && mailboxDragHoldState.pointerId === event.pointerId) {
    cancelMailboxDragHold();
  }
});

document.addEventListener('pointercancel', (event) => {
  if (mailboxDragState && mailboxDragState.pointerId === event.pointerId) {
    suppressMailboxOpenUntil = Date.now() + 400;
    finishMailboxDragCleanup();
    return;
  }

  if (mailboxDragHoldState && mailboxDragHoldState.pointerId === event.pointerId) {
    cancelMailboxDragHold();
  }
});

function clearMessageSearchTimer() {
  if (!searchTimer) {
    return;
  }

  clearTimeout(searchTimer);
  searchTimer = null;
}

function scheduleMessageSearch(delayMs = 250) {
  clearMessageSearchTimer();
  searchTimer = setTimeout(async () => {
    searchTimer = null;
    try {
      state.inboxPage = 1;
      clearMessageSelection();
      closeMessageReader();
      await loadMessages();
      redraw();
    } catch (error) {
      setNotice(error.message, 'error');
    }
  }, delayMs);
}

document.addEventListener('compositionstart', (event) => {
  const target = event.target;
  const action = target?.dataset?.action || '';

  if (!isManagedSearchInputAction(action)) {
    return;
  }

  activeSearchCompositionAction = action;
});

document.addEventListener('compositionend', (event) => {
  const target = event.target;
  const action = target?.dataset?.action || '';

  if (!isManagedSearchInputAction(action)) {
    return;
  }

  clearSearchComposition(action);
  if (action === 'search') {
    state.search = target.value;
    shouldFocusMessageSearch = true;
    scheduleMessageSearch();
    return;
  }

  applySearchableDropdownInput(action, target.value);
});

document.addEventListener('input', (event) => {
  const target = event.target;
  if (target?.dataset?.action === 'registration-whitelist-input') {
    state.systemRegistrationWhitelistInput = String(target.value || '');
    return;
  }

  if (target?.name === 'smtpTestEmail') {
    state.systemSmtpTestEmail = String(target.value || '');
    return;
  }

  const mailboxForm = target.closest('[data-form="mailbox"]');
  if (mailboxForm) {
    state.mailboxNotice = null;
    syncMailboxDraftFromForm(mailboxForm);
  }

  const notificationForm = target.closest('[data-channel="telegram"], [data-channel="wecom"], [data-channel="feishu"]');
  if (notificationForm) {
    syncNotificationDraftFromForm(notificationForm);
  }

  const notificationTemplateOptionsForm = target.closest('[data-form="notification-template-options"]');
  if (notificationTemplateOptionsForm) {
    syncNotificationTemplateOptionsDraftFromForm(notificationTemplateOptionsForm);
    const coverCategory = notificationCoverCategoryFromFieldName(target.name || '');
    if (coverCategory) {
      syncNotificationCoverPreviewFromForm(notificationTemplateOptionsForm, coverCategory);
    }
  }

  const systemSettingsForm = findSystemSettingsForm(target);
  if (systemSettingsForm) {
    syncSystemSettingsDraftFromForm(systemSettingsForm);
    state.authMode = normalizeAuthMode(state.authMode, state.portalKind, state.systemSettingsDraft);
    if (isAuthSystemSettingsField(target)) {
      state.authCodeResult = null;
    }
    if (isSmtpSystemSettingsField(target)) {
      state.systemSmtpTestResult = null;
      state.systemSmtpConnectionResult = null;
    }
    if (isTranslationSystemSettingsField(target)) {
      state.systemTranslationTestResult = null;
    }
    if (isStorageSystemSettingsField(target)) {
      state.systemStorageTestResult = null;
    }
    if (
      target.name === 'outboundProxyMode'
      || target.name === 'outboundProxyUrl'
      || target.name === 'outboundProxyBypass'
    ) {
      state.systemProxyTestResult = null;
    }
  }

  const templateForm = target.closest('[data-form="notification-template"]');
  if (templateForm && target.matches('[data-template-input]')) {
    updateNotificationTemplatePreview(templateForm);
    return;
  }

  if (isSearchableDropdownAction(target.dataset.action || '')) {
    const isComposingSearch =
      Boolean(event.isComposing) || activeSearchCompositionAction === (target.dataset.action || '');
    applySearchableDropdownInput(target.dataset.action || '', target.value, {
      redraw: !isComposingSearch,
    });
    return;
  }

  if (target.dataset.action !== 'search') return;

  state.search = target.value;
  shouldFocusMessageSearch = true;
  if (Boolean(event.isComposing) || activeSearchCompositionAction === 'search') {
    clearMessageSearchTimer();
    return;
  }

  scheduleMessageSearch();
});

window.addEventListener('hashchange', () => {
  syncPortalStateFromLocation();
  stopWecomDiscoveryAutoRefresh();
  state.topbarAccountMenuOpen = false;
  clearMessageSearchTimer();
  clearSearchComposition();
  closeNotificationGuide();
  closeNotificationEmojiGuide();
  state.notificationToolModalKey = '';
  closeSystemGoogleGuide();
  closeSystemMicrosoftGuide();
  shouldFocusMailboxSearch = false;
  shouldFocusMailboxToolbarOwnerSearch = false;
  state.mailboxToolbarOwnerFilterOpen = false;
  state.mailboxOwnerFilterOpen = false;
  state.inboxOwnerFilterOpen = false;
  state.inboxMailboxFilterOpen = false;
  shouldFocusMailboxOwnerSearch = false;
  shouldFocusInboxOwnerSearch = false;
  shouldFocusInboxMailboxSearch = false;
  shouldFocusMessageSearch = false;
  const requestedView = window.location.hash.replace('#', '') || defaultViewForPortal(state.portalPath, state.user);
  state.view = menuItems(state).some((item) => item.id === requestedView)
    ? requestedView
    : defaultViewForPortal(state.portalPath, state.user);
  if (state.view !== 'mailboxes' && state.mailboxModalOpen) {
    closeMailboxModal();
  }
  if (state.view !== 'mailboxes' && state.mailboxImportModalOpen) {
    closeMailboxImportModal();
  }
  if (state.view !== 'users' && state.userModalOpen) {
    closeUserComposer();
  }
  if (state.view !== 'inbox' && state.messageReaderOpen) {
    closeMessageReader();
  }
  redraw();
  if (state.view === 'inbox' && state.user) {
    loadMessages()
      .then(() => redraw())
      .catch(() => {});
  }
  scheduleWorkspaceAutoRefresh(1200);
  if (state.view === 'notifications' && state.user) {
    startWecomDiscoveryAutoRefresh(2, 800);
  }
  if (state.view === 'backups' && state.user?.role === 'admin') {
    loadBackups()
      .then(() => redraw())
      .catch(() => {});
  }
});

document.addEventListener('visibilitychange', () => {
  if (!state.user) {
    return;
  }

  if (document.hidden) {
    stopWorkspaceAutoRefresh();
    return;
  }

  scheduleWorkspaceAutoRefresh(400);
});

document.addEventListener('keydown', (event) => {
  const target = event.target;
  if (
    target?.dataset?.action === 'registration-whitelist-input'
    && ['Enter', ',', '，', ';'].includes(event.key)
  ) {
    event.preventDefault();
    state.systemRegistrationWhitelistInput = String(target.value || '');
    if (addRegistrationWhitelistDomains(target.value)) {
      redraw();
    }
    return;
  }

  if (event.key !== 'Escape') {
    return;
  }

  if (state.confirmDialog) {
    resolveConfirmDialog(false);
    redraw();
    return;
  }

  if (state.mailboxToolbarOwnerFilterOpen) {
    state.mailboxToolbarOwnerFilterOpen = false;
    shouldFocusMailboxToolbarOwnerSearch = false;
    clearSearchComposition('mailbox-toolbar-owner-search');
    redraw();
    return;
  }

  if (state.mailboxOwnerFilterOpen) {
    state.mailboxOwnerFilterOpen = false;
    shouldFocusMailboxOwnerSearch = false;
    clearSearchComposition('mailbox-owner-search');
    redraw();
    return;
  }

  if (state.inboxOwnerFilterOpen) {
    state.inboxOwnerFilterOpen = false;
    shouldFocusInboxOwnerSearch = false;
    clearSearchComposition('inbox-owner-search');
    redraw();
    return;
  }

  if (state.inboxMailboxFilterOpen) {
    state.inboxMailboxFilterOpen = false;
    shouldFocusInboxMailboxSearch = false;
    clearSearchComposition('inbox-mailbox-search');
    redraw();
    return;
  }

  if (state.mailboxColumnMenuOpen) {
    state.mailboxColumnMenuOpen = false;
    redraw();
    return;
  }

  if (state.topbarAccountMenuOpen) {
    state.topbarAccountMenuOpen = false;
    redraw();
    return;
  }

  if (state.notificationGuideChannel) {
    closeNotificationGuide();
    redraw();
    return;
  }

  if (state.notificationEmojiGuideOpen) {
    closeNotificationEmojiGuide();
    redraw();
    return;
  }

  if (state.notificationToolModalKey) {
    state.notificationToolModalKey = '';
    redraw();
    return;
  }

  if (state.systemGoogleGuideOpen) {
    closeSystemGoogleGuide();
    redraw();
    return;
  }

  if (state.systemMicrosoftGuideOpen) {
    closeSystemMicrosoftGuide();
    redraw();
    return;
  }

  if (state.mailboxGuideOpen) {
    closeMailboxGuide();
    redraw();
    return;
  }

  if (state.mailboxImportModalOpen) {
    closeMailboxImportModal();
    redraw();
    return;
  }

  if (state.attachmentPreviewModal) {
    closeAttachmentPreviewModal();
    redraw();
    return;
  }

  if (state.messageReaderOpen) {
    closeMessageReader();
    redraw();
    return;
  }

  if (!state.mailboxModalOpen) {
    return;
  }

  closeMailboxModal();
  redraw();
});

async function boot() {
  applyTheme(state.theme, false);
  applyThemePreset(state.systemSettings.themePresetId);
  redraw();
  const bootResults = await Promise.allSettled([loadSystemSettings(), loadSession()]);
  if (bootResults[0]?.status !== 'fulfilled') {
    applySystemSettingsToDocument();
  }
  if (bootResults[1]?.status !== 'fulfilled') {
    state.user = null;
  }
  await loadAppVersion().catch(() => {});

  syncPortalStateFromLocation();
  state.ready = true;
  if (state.user) {
    const targetPortalPath = resolvePortalPathForUser(state.user);
    const shouldRedirectToRolePortal =
      state.portalPath === '/login'
      || (state.user.role === 'admin' && state.portalPath === '/user')
      || (state.user.role !== 'admin' && state.portalPath === '/gm');
    if (shouldRedirectToRolePortal) {
      replacePortalPath(targetPortalPath, window.location.hash || `#${defaultViewForPortal(targetPortalPath, state.user)}`);
    }

    if (!menuItems(state).some((item) => item.id === state.view)) {
      state.view = defaultViewForPortal(state.portalPath, state.user);
    }
    await refreshWorkspace();
    consumeOauthRedirectNotice();
    scheduleWorkspaceAutoRefresh(1200);
    checkAppVersion({ force: false }).then(() => redraw()).catch(() => {});
  } else {
    if (state.portalPath !== '/' && state.portalPath !== '/login') {
      replacePortalPath('/login');
    }
    state.view = defaultViewForPortal(state.portalPath, null);
    stopWorkspaceAutoRefresh();
  }
  redraw();
  hydrateMailboxPreset(state);
}

boot().catch((error) => {
  state.ready = true;
  state.notice = { text: error.message, tone: 'error' };
  redraw();
});


