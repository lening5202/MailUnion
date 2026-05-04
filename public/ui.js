export function escapeHtml(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function escapeHtmlAttribute(value) {
  return escapeHtml(value);
}

function normalizeMessageBodyText(value = '') {
  return String(value || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '')
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
    .replace(/\u00A0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
}

function isMessageSeparatorLine(line = '') {
  return /^[=\-_*~#·•▪■□○●◆◇]{3,}$/.test(String(line || '').trim());
}

function isMessageListLine(line = '') {
  return /^([*-•●▪■□○◦–—]|(?:\d+|[A-Za-z])[.)、])\s+/.test(String(line || '').trim());
}

function isMessageQuoteLine(line = '') {
  return /^(>+|＞+|❝|❞|「引用」|引用[:：])\s*/.test(String(line || '').trim());
}

function isMessageHeadingLine(line = '') {
  const trimmed = String(line || '').trim();
  if (!trimmed || trimmed.length > 42) {
    return false;
  }

  if (/^[一二三四五六七八九十]+[、.．]/.test(trimmed)) {
    return true;
  }

  if (/^(?:\d+|[A-Za-z])[.)、]\s*[^\s].{0,32}$/.test(trimmed) && !isMessageListLine(trimmed)) {
    return true;
  }

  return /[：:]$/.test(trimmed) || /^(主题|摘要|说明|提示|备注|结论|原文|翻译|链接|附件|发件人|收件人|时间|正文)$/.test(trimmed);
}

function compactMessageParagraph(text = '') {
  return String(text || '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+([，。！？、；：）》」』])/g, '$1')
    .replace(/([（《「『])\s+/g, '$1')
    .replace(/([\u3400-\u9fff])\s+([\u3400-\u9fff])/g, '$1$2')
    .trim();
}

function normalizeQuoteLineText(line = '') {
  return compactMessageParagraph(String(line || '').replace(/^(>+|＞+|❝|❞|「引用」|引用[:：])\s*/, ''));
}

function extractFormattedMessageBlocks(value = '') {
  const normalized = normalizeMessageBodyText(value);
  if (!normalized) {
    return [];
  }

  const lines = normalized
    .split('\n')
    .map((line) => String(line || '').trim())
    .reduce((result, line) => {
      if (!line || isMessageSeparatorLine(line)) {
        result.push('');
        return result;
      }

      result.push(line);
      return result;
    }, []);
  const blocks = [];
  let current = [];

  function flushCurrent() {
    if (!current.length) {
      return;
    }

    if (current.length === 1 && isMessageHeadingLine(current[0])) {
      blocks.push({
        kind: 'heading',
        text: String(current[0] || '').replace(/[：:]$/, '').trim(),
      });
    } else if (current.every((line) => isMessageQuoteLine(line))) {
      blocks.push({
        kind: 'quote',
        lines: current.map((line) => normalizeQuoteLineText(line)).filter(Boolean),
      });
    } else if (current.every((line) => isMessageListLine(line))) {
      blocks.push({
        kind: 'list',
        lines: current.slice(),
      });
    } else {
      blocks.push({
        kind: 'paragraph',
        text: compactMessageParagraph(current.join(' ')),
      });
    }

    current = [];
  }

  for (const line of lines) {
    if (!line) {
      flushCurrent();
      continue;
    }

    current.push(line);
  }

  flushCurrent();

  return blocks.filter((block) =>
    ['list', 'quote'].includes(block.kind)
      ? Array.isArray(block.lines) && block.lines.length
      : Boolean(block.text),
  );
}

function splitTrailingUrlPunctuation(url = '') {
  let cleanUrl = String(url || '');
  let trailing = '';

  while (/[),.;!?，。；：】）》」』]+$/.test(cleanUrl)) {
    trailing = cleanUrl.slice(-1) + trailing;
    cleanUrl = cleanUrl.slice(0, -1);
  }

  return {
    cleanUrl,
    trailing,
  };
}

function normalizePreviewableUrl(url = '') {
  const rawUrl = String(url || '').trim();
  if (!rawUrl) {
    return '';
  }

  const candidate = rawUrl.startsWith('www.') ? `https://${rawUrl}` : rawUrl;

  try {
    const parsed = new URL(candidate);
    if (!['http:', 'https:', 'mailto:', 'ftp:'].includes(parsed.protocol)) {
      return '';
    }

    return parsed.toString();
  } catch (_) {
    return '';
  }
}

function messageLinkLabel(url = '', index = 1) {
  const normalizedUrl = normalizePreviewableUrl(url);
  if (!normalizedUrl) {
    return `网址 ${index}`;
  }

  try {
    const parsed = new URL(normalizedUrl);
    if (parsed.protocol === 'mailto:') {
      return parsed.pathname || `邮箱链接 ${index}`;
    }

    const host = decodeURIComponent(parsed.hostname || '').replace(/^www\./i, '');
    const pathname = decodeURIComponent(parsed.pathname || '');
    const baseLabel = host || `网址 ${index}`;
    const shortPath =
      pathname && pathname !== '/'
        ? pathname.length > 18
          ? `${pathname.slice(0, 18)}...`
          : pathname
        : '';
    const suffix = parsed.search ? '...' : '';
    const label = `${baseLabel}${shortPath}${suffix}`;

    return label.length > 42 ? `${label.slice(0, 39)}...` : label;
  } catch (_) {
    return `网址 ${index}`;
  }
}

function renderLinkifiedMessageText(text = '') {
  const source = String(text || '');
  const urlPattern = /(https?:\/\/[^\s<>"']+|mailto:[^\s<>"']+|www\.[^\s<>"']+)/gi;
  const matches = Array.from(source.matchAll(urlPattern));

  if (!matches.length) {
    return escapeHtml(source);
  }

  let html = '';
  let lastIndex = 0;
  let linkIndex = 0;

  for (const match of matches) {
    const rawUrl = String(match[0] || '');
    const matchIndex = Number(match.index || 0);
    const { cleanUrl, trailing } = splitTrailingUrlPunctuation(rawUrl);
    const previewableUrl = normalizePreviewableUrl(cleanUrl);

    html += escapeHtml(source.slice(lastIndex, matchIndex));

    if (previewableUrl) {
      linkIndex += 1;
      html += `<a class="message-body-link" href="${escapeHtmlAttribute(previewableUrl)}" target="_blank" rel="noreferrer noopener" title="${escapeHtmlAttribute(previewableUrl)}">${escapeHtml(messageLinkLabel(cleanUrl, linkIndex))}</a>`;
    } else {
      html += escapeHtml(rawUrl);
    }

    if (trailing) {
      html += escapeHtml(trailing);
    }

    lastIndex = matchIndex + rawUrl.length;
  }

  html += escapeHtml(source.slice(lastIndex));
  return html;
}

function renderFormattedMessageBody(text = '', options = {}) {
  const blocks = extractFormattedMessageBlocks(text);
  const emptyText = options.emptyText || '暂无可显示的邮件正文。';

  if (!blocks.length) {
    return `<div class="notice info">${escapeHtml(emptyText)}</div>`;
  }

  return `
    <div class="message-rich-body">
      ${blocks
        .map((block) => {
          if (block.kind === 'heading') {
            return `<h4 class="message-body-heading">${renderLinkifiedMessageText(block.text)}</h4>`;
          }

          if (block.kind === 'quote') {
            return `
              <blockquote class="message-body-quote">
                ${block.lines
                  .map(
                    (line) => `
                      <p>${renderLinkifiedMessageText(line)}</p>
                    `,
                  )
                  .join('')}
              </blockquote>
            `;
          }

          if (block.kind === 'list') {
            return `
              <div class="message-body-list">
                ${block.lines
                  .map(
                    (line) => `
                      <div class="message-body-list-item">${renderLinkifiedMessageText(line)}</div>
                    `,
                  )
                  .join('')}
              </div>
            `;
          }

          return `<p class="message-body-paragraph">${renderLinkifiedMessageText(block.text)}</p>`;
        })
        .join('')}
    </div>
  `;
}

function renderOriginalMessageHtml(message = {}, options = {}) {
  const htmlBody = String(message.htmlBody || '').trim();
  const fallbackBody = String(message.textBody || message.preview || '').trim();

  if (!htmlBody) {
    return renderFormattedMessageBody(fallbackBody, options);
  }

  return `
    <div class="message-html-render">
      <div class="message-html-render-meta">
        <span class="tag">HTML 原始排版</span>
        <p>已尽量按原邮件样式展示；如果对方邮件依赖远程图片或特殊字体，视觉上可能和原邮箱有少量差异。</p>
      </div>
      <div class="message-html-frame-shell">
        <iframe
          class="message-html-frame"
          title="原始邮件 HTML 正文"
          data-message-html-frame="true"
          data-message-id="${escapeHtmlAttribute(message.id || '')}"
          sandbox="allow-same-origin"
          referrerpolicy="no-referrer"
        ></iframe>
      </div>
    </div>
  `;
}

export function formatDate(value) {
  if (!value) {
    return '未同步';
  }

  return new Intl.DateTimeFormat('zh-CN', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

export function formatFullDate(value) {
  if (!value) {
    return '未知时间';
  }

  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

function formatFileSize(value) {
  const size = Number(value || 0);
  if (!Number.isFinite(size) || size <= 0) {
    return '0 B';
  }

  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let index = 0;
  let resolved = size;
  while (resolved >= 1024 && index < units.length - 1) {
    resolved /= 1024;
    index += 1;
  }

  return `${resolved >= 10 || index === 0 ? resolved.toFixed(0) : resolved.toFixed(1)} ${units[index]}`;
}

function attachmentExtension(filename = '') {
  return String(filename || '')
    .trim()
    .toLowerCase()
    .split('.')
    .slice(1)
    .pop() || '';
}

function attachmentPreviewKind(attachment = {}) {
  const contentType = String(attachment?.contentType || '').trim().toLowerCase();
  const extension = attachmentExtension(attachment?.filename);

  if (
    contentType.startsWith('image/')
    || ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp'].includes(extension)
  ) {
    return 'image';
  }

  if (contentType === 'application/pdf' || extension === 'pdf') {
    return 'pdf';
  }

  if (contentType.startsWith('audio/') || ['mp3', 'wav', 'ogg', 'm4a'].includes(extension)) {
    return 'audio';
  }

  return 'file';
}

function attachmentPreviewIconKey(previewKind = 'file') {
  if (previewKind === 'image') {
    return 'image';
  }
  if (previewKind === 'pdf') {
    return 'notes';
  }
  if (previewKind === 'audio') {
    return 'audio';
  }
  return 'attachments';
}

function attachmentPreviewKindLabel(previewKind = 'file') {
  if (previewKind === 'image') {
    return '图片附件';
  }
  if (previewKind === 'pdf') {
    return 'PDF 附件';
  }
  if (previewKind === 'audio') {
    return '音频附件';
  }
  return '文件附件';
}

function renderAttachmentInteractionAttributes(payload = {}) {
  const pairs = [
    ['data-attachment-preview-open', 'true'],
    ['data-attachment-hover-preview', payload.previewUrl ? 'true' : 'false'],
    ['data-preview-kind', payload.previewKind || 'file'],
    ['data-preview-kind-label', payload.previewKindLabel || attachmentPreviewKindLabel(payload.previewKind || 'file')],
    ['data-preview-url', payload.previewUrl || ''],
    ['data-download-url', payload.downloadUrl || ''],
    ['data-preview-filename', payload.filename || '附件'],
    ['data-preview-content-type', payload.contentType || ''],
    ['data-preview-size', Number(payload.size || 0)],
    ['data-preview-subtitle', payload.subtitle || ''],
    ['data-preview-mailbox', payload.mailboxLabel || ''],
    ['data-preview-owner', payload.ownerLabel || ''],
    ['data-preview-received-at', payload.receivedAt || ''],
    ['data-preview-storage-path', payload.storagePath || ''],
    ['data-preview-status', payload.statusText || ''],
    ['data-preview-note', payload.note || ''],
  ];

  return pairs
    .map(([name, value]) => `${name}="${escapeHtmlAttribute(String(value ?? ''))}"`)
    .join(' ');
}

function renderAttachmentViewerSurface(previewKind = 'file', previewUrl = '', filename = '附件', className = '') {
  const classes = ['attachment-viewer-surface', className, `is-${previewKind}`].filter(Boolean).join(' ');
  const resolvedPreviewUrl = String(previewUrl || '').trim();
  if (!resolvedPreviewUrl) {
    return `
      <div class="${classes}">
        <div class="attachment-viewer-empty">
          <strong>当前没有可直接预览的附件实体</strong>
          <p>这条记录目前只保留了元数据，仍然可以通过下载动作尝试补拉或查看原始文件。</p>
        </div>
      </div>
    `;
  }

  if (previewKind === 'image') {
    return `
      <div class="${classes}">
        <img src="${escapeHtml(resolvedPreviewUrl)}" alt="${escapeHtml(filename)}" loading="eager" />
      </div>
    `;
  }

  if (previewKind === 'pdf') {
    return `
      <div class="${classes}">
        <iframe src="${escapeHtml(`${resolvedPreviewUrl}#toolbar=0&navpanes=0&scrollbar=1`)}" title="${escapeHtml(filename)}"></iframe>
      </div>
    `;
  }

  if (previewKind === 'audio') {
    return `
      <div class="${classes}">
        <audio controls preload="metadata" src="${escapeHtml(resolvedPreviewUrl)}"></audio>
      </div>
    `;
  }

  return `
    <div class="${classes}">
      <div class="attachment-viewer-empty">
        <strong>${escapeHtml(attachmentPreviewKindLabel(previewKind))}</strong>
        <p>该附件类型不适合直接内嵌预览，可以在右上角点击下载或新窗口打开。</p>
      </div>
    </div>
  `;
}

function renderMessageAttachmentsSection(message) {
  const attachments = Array.isArray(message?.attachments) ? message.attachments.filter(Boolean) : [];
  if (!attachments.length) {
    return '';
  }

  return `
    <section class="sub-panel message-attachments-panel">
      <div class="message-attachments-head">
        <h3>附件</h3>
        <span class="tag subtle">${escapeHtml(`${attachments.length} 个附件`)}</span>
      </div>
      <div class="message-attachments-list">
        ${attachments
          .map((attachment, index) => {
            const previewKind = attachmentPreviewKind(attachment);
            const filename = String(attachment?.filename || `附件 ${index + 1}`).trim() || `附件 ${index + 1}`;
            const contentType = String(attachment?.contentType || '').trim() || '未知类型';
            const openUrl = `/api/messages/${encodeURIComponent(message.id)}/attachments/${index}/open`;
            const downloadUrl = `/api/messages/${encodeURIComponent(message.id)}/attachments/${index}/download`;
            const previewUrl = Boolean(attachment?.stored) ? openUrl : '';
            const stored = Boolean(previewUrl);
            const previewAvailable = stored && ['image', 'pdf', 'audio'].includes(previewKind);
            const statusText = stored ? '已同步实体' : String(attachment?.note || '仅元数据').trim() || '仅元数据';
            const interactionAttrs = renderAttachmentInteractionAttributes({
              previewKind,
              previewUrl,
              downloadUrl,
              filename,
              contentType,
              size: attachment?.size || 0,
              subtitle: message.subject || '',
              mailboxLabel: `${message.mailboxName || ''}${message.mailboxName && message.mailboxEmail ? ' / ' : ''}${message.mailboxEmail || ''}`,
              ownerLabel: message.ownerName || message.ownerEmail || '',
              receivedAt: message.receivedAt || '',
              storagePath: String(attachment?.relativePath || attachment?.publicPath || '').trim(),
              statusText,
              note: String(attachment?.note || '').trim(),
            });
            const cardClassName = [
              'message-attachment-card',
              'attachment-interactive-card',
              `is-${previewKind}`,
              stored ? 'is-stored' : 'is-meta-only',
              previewAvailable ? 'has-hover-preview' : 'has-no-preview',
            ].join(' ');

            return `
              <article class="${cardClassName}" tabindex="0" title="${escapeHtmlAttribute(previewAvailable ? '悬停预览，双击弹窗查看' : '双击查看附件详情')}" ${interactionAttrs}>
                <div class="message-attachment-main">
                  <div class="message-attachment-mainline">
                    ${renderAutoIcon(attachmentPreviewIconKey(previewKind), filename, 'message-attachment-icon')}
                    <div class="message-attachment-copy">
                      <strong>${escapeHtml(filename)}</strong>
                      <p>${escapeHtml(statusText)}</p>
                      <div class="message-attachment-meta">
                        <span>${escapeHtml(formatFileSize(attachment?.size || 0))}</span>
                        <span>${escapeHtml(contentType)}</span>
                        <span>${escapeHtml(attachmentPreviewKindLabel(previewKind))}</span>
                      </div>
                    </div>
                  </div>
                  <div class="message-attachment-actions">
                    <button class="tiny-button" type="button" data-action="open-attachment-preview-modal" ${interactionAttrs}>查看</button>
                    <a class="tiny-button" href="${escapeHtml(downloadUrl)}">下载</a>
                  </div>
                </div>
                <div class="message-attachment-foot">
                  <span class="attachment-interaction-hint">${previewAvailable ? '悬停预览 · 双击卡片弹窗查看' : '双击卡片查看详情'}</span>
                  ${stored ? '<span class="tag subtle">支持预览与下载</span>' : `<span class="tag subtle">${escapeHtml(statusText)}</span>`}
                </div>
              </article>
            `;
          })
          .join('')}
      </div>
    </section>
  `;
}

export function menuItems(state) {
  return [
    { id: 'dashboard', label: '仪表盘' },
    { id: 'inbox', label: '统一收件箱' },
    { id: 'mailboxes', label: '邮箱管理' },
    { id: 'notifications', label: '通知设置' },
    ...(state.user?.role === 'admin' ? [{ id: 'users', label: '用户管理' }] : []),
    { id: 'profile', label: '个人中心' },
    ...(state.user?.role === 'admin' ? [{ id: 'backups', label: '系统备份', icon: 'backups' }] : []),
    ...(state.user?.role === 'admin' ? [{ id: 'system', label: '系统设置', icon: 'system' }] : []),
  ];
}

function getDisplayMenuItems(state) {
  return menuItems(state).map((item) =>
    item.id === 'inbox'
      ? {
          ...item,
          label: '收件箱',
        }
      : item,
  );
}

function ownerFilter(state, actionName = 'owner-filter') {
  if (state.user.role !== 'admin') {
    return '';
  }

  return `
    <label class="compact-field">
      <span>用户筛选</span>
      <select data-action="${escapeHtml(actionName)}">
        <option value="">全部用户</option>
        ${state.users
          .map(
            (user) => `
              <option value="${escapeHtml(user.id)}" ${user.id === state.selectedOwnerUserId ? 'selected' : ''}>
                ${escapeHtml(user.name)} · ${escapeHtml(formatUserHandle(user))}
              </option>
            `,
          )
          .join('')}
      </select>
    </label>
  `;
}

function ownerFilterCompact(state, actionName = 'owner-filter') {
  if (state.user.role !== 'admin') {
    return '';
  }

  const ownerSearchTokens = tokenizeSearchQuery(state.mailboxToolbarOwnerSearch);
  const selectedOwner = state.selectedOwnerUserId
    ? state.users.find((user) => user.id === state.selectedOwnerUserId) || null
    : null;
  const ownerMatches = state.users.filter((user) => {
    if (!ownerSearchTokens.length) {
      return true;
    }

    const haystack = [
      user.name,
      user.username,
      user.email,
      formatUserHandle(user),
      formatUserContact(user),
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();

    return ownerSearchTokens.every((token) => haystack.includes(token));
  });
  const ownerOptions = mergeSelectedSearchOption(ownerMatches, selectedOwner, ownerSearchTokens);
  const totalUserCount = state.users.length;
  const triggerTitle = selectedOwner?.name || '全部用户';
  const triggerMeta = selectedOwner
    ? formatUserHandle(selectedOwner)
    : totalUserCount
      ? `${totalUserCount} 个用户`
      : '暂无用户';

  return `
    <label class="mailbox-owner-shell" aria-label="用户筛选">
      <div class="inbox-mailbox-filter ${state.mailboxToolbarOwnerFilterOpen ? 'is-open' : ''}" data-mailbox-toolbar-owner-filter>
        <button
          class="inbox-mailbox-trigger"
          type="button"
          data-action="toggle-mailbox-toolbar-owner-filter"
          aria-expanded="${state.mailboxToolbarOwnerFilterOpen ? 'true' : 'false'}"
        >
          <span class="inbox-mailbox-trigger-main">
            ${
              selectedOwner
                ? renderAvatar(
                    selectedOwner.avatarUrl,
                    userInitials(selectedOwner),
                    'filter-user-avatar',
                    selectedOwner.name || selectedOwner.username || 'user',
                  )
                : renderAvatar('', '全', 'filter-user-avatar', 'all users')
            }
            <span class="inbox-mailbox-trigger-copy">
              <strong>${escapeHtml(triggerTitle)}</strong>
            </span>
          </span>
          <span class="inbox-mailbox-trigger-side">
            <span class="inbox-mailbox-trigger-meta">${escapeHtml(triggerMeta)}</span>
            <span class="inbox-mailbox-trigger-caret" aria-hidden="true"></span>
          </span>
        </button>
        ${
          state.mailboxToolbarOwnerFilterOpen
            ? `
                <div class="inbox-mailbox-panel">
                  <label class="inbox-mailbox-search-shell">
                    <span class="inbox-mailbox-search-icon" aria-hidden="true">&#8981;</span>
                    <input
                      data-action="mailbox-toolbar-owner-search"
                      value="${escapeHtml(state.mailboxToolbarOwnerSearch || '')}"
                      placeholder="${escapeHtml('搜索昵称、用户名、邮箱')}"
                      autocomplete="off"
                    />
                  </label>
                  <div class="inbox-mailbox-option-list">
                    <button
                      class="inbox-mailbox-option ${selectedOwner ? '' : 'is-active'}"
                      type="button"
                      data-action="${escapeHtml(actionName)}"
                      data-user-id=""
                    >
                      <span class="inbox-mailbox-option-main">
                        ${renderAvatar('', '全', 'filter-user-avatar', 'all users')}
                        <span class="inbox-mailbox-option-copy">
                          <strong>${escapeHtml('全部用户')}</strong>
                          <small>${escapeHtml('显示当前全部用户的邮箱')}</small>
                        </span>
                      </span>
                      <span class="inbox-mailbox-option-meta">${escapeHtml(`${totalUserCount} 个`)}</span>
                    </button>
                    ${
                      ownerOptions.length
                        ? ownerOptions
                            .map(
                              (user) => `
                                <button
                                  class="inbox-mailbox-option ${user.id === selectedOwner?.id ? 'is-active' : ''}"
                                  type="button"
                                  data-action="${escapeHtml(actionName)}"
                                  data-user-id="${escapeHtml(user.id)}"
                                >
                                  <span class="inbox-mailbox-option-main">
                                    ${renderAvatar(
                                      user.avatarUrl,
                                      userInitials(user),
                                      'filter-user-avatar',
                                      user.name || user.username || 'user',
                                    )}
                                    <span class="inbox-mailbox-option-copy">
                                      <strong>${escapeHtml(user.name || user.username || '未命名用户')}</strong>
                                      <small>${escapeHtml(formatUserHandle(user))}</small>
                                    </span>
                                  </span>
                                  <span class="inbox-mailbox-option-meta">${escapeHtml(
                                    user.role === 'admin' ? '管理员' : '用户',
                                  )}</span>
                                </button>
                              `,
                            )
                            .join('')
                        : `<div class="inbox-mailbox-empty">${escapeHtml('没有匹配的用户')}</div>`
                    }
                  </div>
                </div>
              `
            : ''
        }
      </div>
    </label>
  `;
}

const MAILBOX_PROVIDER_META = {
  all: { label: '全部邮箱', short: '总' },
  gmail: { label: 'Gmail', short: 'G' },
  outlook: { label: 'Outlook', short: 'O' },
  qq: { label: 'QQ邮箱', short: 'Q' },
  netease163: { label: '163邮箱', short: '163' },
  aliyun: { label: '阿里邮箱', short: 'A' },
  generic: { label: '通用IMAP', short: '@' },
};

function mailboxProviderMeta(providerId, providers = []) {
  const preset = providers.find((provider) => provider.id === providerId);
  const known = MAILBOX_PROVIDER_META[providerId] || {};

  return {
    id: providerId || 'generic',
    label: known.label || preset?.label || providerId || '其他邮箱',
    short: known.short || String(preset?.label || providerId || '?').trim().slice(0, 2).toUpperCase(),
  };
}

function renderMailboxProviderIcon(providerId, providers = [], extraClassName = '') {
  const meta = mailboxProviderMeta(providerId, providers);
  const className = ['provider-icon', `provider-icon-${escapeHtml(meta.id)}`, extraClassName].filter(Boolean).join(' ');

  return `
    <span class="${className}" aria-hidden="true">
      <span>${escapeHtml(meta.short)}</span>
    </span>
  `;
}

function tokenizeSearchQuery(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

function mergeSelectedSearchOption(matches, selectedItem, searchTokens = []) {
  if (!selectedItem || matches.some((item) => item.id === selectedItem.id)) {
    return matches;
  }

  return Array.isArray(searchTokens) && searchTokens.length ? matches : [selectedItem, ...matches];
}

function mailboxMatchesQuery(mailbox, query, providers = []) {
  const tokens = Array.isArray(query) ? query : tokenizeSearchQuery(query);
  if (!tokens.length) {
    return true;
  }

  const haystack = [
    mailbox.name,
    mailbox.email,
    mailbox.username,
    mailbox.ownerName,
    mailbox.ownerEmail,
    mailboxProviderMeta(mailbox.provider, providers).label,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  return tokens.every((token) => haystack.includes(token));
}

const PAGE_SIZE_OPTIONS = [10, 20, 50, 100, 500];
const MAILBOX_VISIBLE_FIELD_OPTIONS = [
  { id: 'email', label: '邮箱地址' },
  { id: 'sortOrder', label: '排序值' },
  { id: 'status', label: '状态' },
  { id: 'username', label: '登录用户名' },
  { id: 'imapHost', label: 'IMAP 主机' },
  { id: 'owner', label: '归属用户' },
  { id: 'syncInterval', label: '同步频率' },
];

function renderPaginationBar({
  type = 'inbox',
  page = 1,
  pageSize = 10,
  totalItems = 0,
  totalPages = 1,
  currentCount = 0,
  pageSizeAction = 'inbox-page-size',
  pageAction = 'go-inbox-page',
  jumpAction = 'jump-inbox-page',
} = {}) {
  const safePage = Math.max(Number(page) || 1, 1);
  const safePageSize = PAGE_SIZE_OPTIONS.includes(Number(pageSize)) ? Number(pageSize) : 10;
  const safeTotalItems = Math.max(Number(totalItems) || 0, 0);
  const safeTotalPages = Math.max(Number(totalPages) || 1, 1);
  const startIndex = safeTotalItems ? (safePage - 1) * safePageSize + 1 : 0;
  const endIndex = safeTotalItems ? Math.min(startIndex + Math.max(Number(currentCount) || 0, 0) - 1, safeTotalItems) : 0;

  return `
    <div class="pagination-bar">
      <div class="pagination-summary">
        <strong>${escapeHtml(`第 ${safePage} / ${safeTotalPages} 页`)}</strong>
        <span>${escapeHtml(safeTotalItems ? `当前显示 ${startIndex}-${endIndex} 项，共 ${safeTotalItems} 项` : '当前没有可显示的数据')}</span>
      </div>
      <div class="pagination-controls">
        <label class="pagination-page-size">
          <span>每页</span>
          <select data-action="${escapeHtml(pageSizeAction)}">
            ${PAGE_SIZE_OPTIONS.map(
              (option) => `<option value="${option}" ${option === safePageSize ? 'selected' : ''}>${option}</option>`,
            ).join('')}
          </select>
        </label>
        <div class="pagination-nav">
          <button class="tiny-button" type="button" data-action="${escapeHtml(pageAction)}" data-page="1" ${safePage <= 1 ? 'disabled' : ''}>首页</button>
          <button class="tiny-button" type="button" data-action="${escapeHtml(pageAction)}" data-page="${Math.max(safePage - 1, 1)}" ${safePage <= 1 ? 'disabled' : ''}>上一页</button>
          <button class="tiny-button" type="button" data-action="${escapeHtml(pageAction)}" data-page="${Math.min(safePage + 1, safeTotalPages)}" ${safePage >= safeTotalPages ? 'disabled' : ''}>下一页</button>
          <button class="tiny-button" type="button" data-action="${escapeHtml(pageAction)}" data-page="${safeTotalPages}" ${safePage >= safeTotalPages ? 'disabled' : ''}>末页</button>
        </div>
        <div class="pagination-jump">
          <input
            type="number"
            min="1"
            max="${escapeHtml(safeTotalPages)}"
            value="${escapeHtml(safePage)}"
            data-page-input="${escapeHtml(type)}"
          />
          <button class="tiny-button" type="button" data-action="${escapeHtml(jumpAction)}">跳转</button>
        </div>
      </div>
    </div>
  `;
}

function renderMailboxVisibleFieldChips(mailbox, visibleFieldIds = [], state) {
  const selected = new Set(Array.isArray(visibleFieldIds) ? visibleFieldIds : []);
  const items = [];

  if (selected.has('email') && mailbox.email) {
    items.push(`<span class="tag subtle mailbox-row-email-tag" title="${escapeHtml(mailbox.email)}">${escapeHtml(mailbox.email)}</span>`);
  }
  if (selected.has('sortOrder')) {
    items.push(`<span class="tag subtle">排序 ${escapeHtml(mailbox.sortOrder ?? 100)}</span>`);
  }
  if (selected.has('status')) {
    items.push(`<span class="status ${escapeHtml(mailbox.status)}">${escapeHtml(mailbox.status)}</span>`);
  }
  if (selected.has('username') && mailbox.username) {
    items.push(`<span>${escapeHtml(mailbox.username)}</span>`);
  }
  if (selected.has('imapHost') && mailbox.imapHost) {
    items.push(`<span>${escapeHtml(mailbox.imapHost)}:${escapeHtml(mailbox.imapPort)}</span>`);
  }
  if (selected.has('owner') && state.user.role === 'admin' && (mailbox.ownerName || mailbox.ownerEmail)) {
    items.push(`<span>${escapeHtml(mailbox.ownerName || mailbox.ownerEmail)}</span>`);
  }
  if (selected.has('syncInterval')) {
    items.push(`<span>${escapeHtml((mailbox.syncIntervalSeconds || 5) + ' 秒刷新')}</span>`);
  }

  if (!items.length) {
    return '';
  }

  return `<div class="mailbox-row-optional-fields">${items.join('')}</div>`;
}

function mailboxGuideData(providerId, providers = []) {
  const normalized = String(providerId || 'generic').trim().toLowerCase();
  const meta = mailboxProviderMeta(normalized, providers);
  const providerPreset = providers.find((provider) => provider.id === normalized) || {};
  const genericConfig = [
    { label: 'IMAP 主机', value: providerPreset.imapHost || '请按邮箱服务商文档填写' },
    { label: '端口', value: providerPreset.imapPort ? String(providerPreset.imapPort) : '一般为 993' },
    { label: '加密', value: providerPreset.secure === false ? '按服务商要求配置' : 'SSL/TLS' },
  ];
  const guides = {
    gmail: {
      title: 'Gmail 接入说明',
      badge: '默认应用专用密码',
      intro: 'Gmail 仍支持 IMAP 收件，当前默认展示应用专用密码 / IMAP 授权码方案；如果账号不支持应用专用密码，再切到 Google OAuth2。',
      config: [
        { label: 'IMAP 主机', value: 'imap.gmail.com' },
        { label: '端口', value: '993' },
        { label: '加密', value: 'SSL/TLS' },
        { label: '应用专用密码入口', value: 'https://myaccount.google.com/apppasswords' },
        { label: 'OAuth 回调', value: 'http://localhost:52080/api/oauth/google/callback' },
      ],
      steps: [
        '默认先走应用专用密码 / IMAP 方案：先去 Google 账号安全页开启两步验证，再进入 https://myaccount.google.com/apppasswords 生成 16 位应用专用密码。',
        '回到邮箱管理，保持应用专用密码模式，用户名填完整 Gmail 地址，密码填刚生成的应用专用密码。',
        '如果账号不支持应用专用密码，再切到“Google OAuth2”模式，并填写 Google Cloud 里的 Client ID / Client Secret。',
        '在 Google Cloud Console 的 OAuth 应用里把回调地址加入允许列表。',
        '点击“连接 Google”完成授权，成功后系统会自动回填授权邮箱。',
      ],
      notes: [
        '普通 Gmail 登录密码大多数情况下不能直接用于 IMAP 接入。',
        'Google 官方说明：个人 Gmail 从 2025 年 1 月开始默认始终开启 IMAP，不再需要手动去 Gmail 设置里启用。',
        '如果切到 OAuth2 并授权成功，系统会自动使用刷新令牌继续同步。',
      ],
    },
    outlook: {
      title: 'Outlook / Microsoft 365 接入说明',
      badge: '推荐 OAuth2',
      intro: 'Outlook 仍支持 IMAP，但越来越多账号需要 Modern Auth，推荐直接使用 Microsoft OAuth2。',
      config: [
        { label: 'IMAP 主机', value: 'outlook.office365.com' },
        { label: '端口', value: '993' },
        { label: '加密', value: 'SSL/TLS' },
        { label: 'OAuth 回调', value: 'http://localhost:52080/api/oauth/microsoft/callback' },
      ],
      steps: [
        '优先在“系统设置 -> Microsoft 应用配置 -> 配置教程”里完成系统级 Client ID / Client Secret / Tenant 配置。',
        '个人 Outlook 账号的 Tenant 一般填写 common，企业租户可填写实际 Tenant ID。',
        '在微软应用注册里配置 IMAP 相关权限，并把回调地址加入重定向 URI。',
        '点击“连接 Microsoft”完成授权；如坚持密码模式，请先确认网页端已允许 IMAP。',
      ],
      notes: [
        '部分 Outlook.com 或 Microsoft 365 账号会拒绝基础密码认证。',
        '如果测试连接失败，优先检查 Tenant、回调地址、权限授予和 IMAP 是否启用。',
      ],
    },
    qq: {
      title: 'QQ 邮箱接入说明',
      badge: '使用授权码',
      intro: 'QQ 邮箱接入前，通常需要先在网页邮箱里开启 IMAP，并生成独立授权码。',
      config: [
        { label: 'IMAP 主机', value: 'imap.qq.com' },
        { label: '端口', value: '993' },
        { label: '加密', value: 'SSL/TLS' },
      ],
      steps: [
        '先登录 QQ 邮箱网页端，进入设置并开启 IMAP 服务。',
        '按页面提示发送短信或完成验证，获取客户端授权码。',
        '在本系统新增邮箱时，邮箱地址填写 QQ 邮箱，密码位置填写授权码而不是 QQ 登录密码。',
        '保存前可先点击“测试连接”，确认 IMAP 已成功放行。',
      ],
      notes: [
        'QQ 邮箱的登录密码通常不能直接用于 IMAP 客户端接入。',
        '如网页端刚开启 IMAP，可能需要等待几分钟后再测试。',
      ],
    },
    netease163: {
      title: '163 邮箱接入说明',
      badge: '使用客户端授权码',
      intro: '163 邮箱需要先开启 IMAP，并使用客户端授权码进行第三方收件接入。',
      config: [
        { label: 'IMAP 主机', value: 'imap.163.com' },
        { label: '端口', value: '993' },
        { label: '加密', value: 'SSL/TLS' },
      ],
      steps: [
        '登录 163 邮箱网页端，在设置中开启 IMAP / SMTP 服务。',
        '根据网易提示生成客户端授权码。',
        '在本系统里填写邮箱地址和客户端授权码，用户名一般可直接填写邮箱地址。',
        '保存后系统会按同步频率自动拉取收件内容。',
      ],
      notes: [
        '请使用客户端授权码，不要直接填写网页登录密码。',
        '若账号开启了安全验证，建议先在网页端确认第三方客户端访问权限。',
      ],
    },
    aliyun: {
      title: '阿里邮箱接入说明',
      badge: '企业邮箱常见',
      intro: '阿里邮箱通常支持标准 IMAP，但企业版是否允许第三方接入，取决于管理员策略。',
      config: [
        { label: 'IMAP 主机', value: 'imap.qiye.aliyun.com' },
        { label: '端口', value: '993' },
        { label: '加密', value: 'SSL/TLS' },
      ],
      steps: [
        '先确认该邮箱账号已经开通 IMAP 收件权限。',
        '在本系统中填写邮箱地址、登录用户名和密码或授权码。',
        '如果贵司管理员单独配置了 IMAP 主机，请以企业邮件文档为准覆盖当前默认值。',
        '测试通过后再保存，避免后续同步失败。',
      ],
      notes: [
        '部分企业版阿里邮箱会限制外部客户端接入，需要管理员放行。',
        '如果域名邮箱接入失败，请同时核对主机名、用户名格式和安全策略。',
      ],
    },
    generic: {
      title: `${meta.label} 接入说明`,
      badge: '通用 IMAP',
      intro: '适合其他支持 IMAP 的邮箱。只要拿到正确的 IMAP 主机、端口和认证方式，就可以接入本系统统一收件。',
      config: genericConfig,
      steps: [
        '先在对应邮箱官网或帮助文档里确认是否支持 IMAP 收件。',
        '准备好 IMAP 主机、端口、是否启用 SSL/TLS、登录用户名以及密码或授权码。',
        '如果服务商要求使用授权码或 OAuth，请不要直接填写网页登录密码。',
        '新增后先测试连接，再保存接入。',
      ],
      notes: [
        '不同厂商对用户名格式要求不同，可能是完整邮箱，也可能是单独用户名。',
        '如果连接失败，优先检查 IMAP 是否启用、防火墙限制和账号安全策略。',
      ],
    },
  };

  return guides[normalized] || {
    ...guides.generic,
    title: `${meta.label} 接入说明`,
  };
}

function renderMailboxGuideModal(state, providerId) {
  const guide = mailboxGuideData(providerId, state.providers);

  return `
    <div class="modal-shell mailbox-guide-shell">
      <div class="modal-backdrop" data-mailbox-guide-overlay></div>
      <section class="modal-panel mailbox-guide-modal">
        <div class="mailbox-guide-header">
          <div class="mailbox-guide-title">
            ${renderMailboxProviderIcon(providerId, state.providers, 'provider-icon-guide')}
            <div class="mailbox-guide-title-copy">
              <div class="mailbox-guide-title-row">
                <h3>${escapeHtml(guide.title)}</h3>
                <span class="tag subtle">${escapeHtml(guide.badge)}</span>
              </div>
              <p>${escapeHtml(guide.intro)}</p>
            </div>
          </div>
          <button class="modal-close" type="button" data-action="close-mailbox-guide" aria-label="关闭说明">×</button>
        </div>
        <div class="mailbox-guide-body">
          <section class="mailbox-guide-section">
            <h4>基础配置</h4>
            <div class="mailbox-guide-grid">
              ${guide.config
                .map(
                  (item) => `
                    <div class="mailbox-guide-card">
                      <span>${escapeHtml(item.label)}</span>
                      <code>${escapeHtml(item.value)}</code>
                    </div>
                  `,
                )
                .join('')}
            </div>
          </section>
          <section class="mailbox-guide-section">
            <h4>添加步骤</h4>
            <ol class="mailbox-guide-list">
              ${guide.steps.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}
            </ol>
          </section>
          <section class="mailbox-guide-section">
            <h4>注意事项</h4>
            <ul class="mailbox-guide-list mailbox-guide-list-muted">
              ${guide.notes.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}
            </ul>
          </section>
        </div>
      </section>
    </div>
  `;
}

function notificationGuideData(channel) {
  const normalized = String(channel || '').trim().toLowerCase();
  const guides = {
    telegram: {
      title: 'Telegram 配置说明',
      badge: 'Bot API',
      iconKey: 'telegram',
      intro: '适合把新邮件推送到 Telegram 私聊或群聊，核心只需要 Bot Token（机器人令牌）和 Chat ID（会话 ID）两个参数。',
      config: [
        { label: 'Bot Token（机器人令牌）', value: '来自 @BotFather 创建机器人后返回的 token' },
        { label: 'Chat ID（会话 ID）', value: '目标私聊或群聊对应的 chat_id' },
        { label: '验证方式', value: '保存后可直接发送测试消息验证连通性' },
      ],
      steps: [
        '在 Telegram 里搜索 @BotFather，发送 /newbot 创建机器人，并复制返回的 Bot Token（机器人令牌）。',
        '先和机器人私聊一条消息，或者把机器人拉进目标群聊后发送一条消息。',
        '私聊或群聊产生消息后，通过 Telegram Bot API 的 getUpdates 获取对应的 Chat ID（会话 ID）。',
        '将 Bot Token（机器人令牌）和 Chat ID（会话 ID）填回本系统，保存后点击“发送测试消息”确认是否能正常收到。',
      ],
      notes: [
        '群聊 Chat ID（会话 ID）通常以 -100 开头。',
        '如果群里收不到消息，先确认机器人已经进群、没有被禁言，并且至少收到过一条群消息。',
        'Bot Token（机器人令牌）属于敏感凭据，建议妥善保存，不要随意外传。',
      ],
      links: [
        { label: 'Telegram Bots 官方说明', url: 'https://core.telegram.org/bots' },
        { label: 'Telegram Bot API getUpdates', url: 'https://core.telegram.org/bots/api#getupdates' },
      ],
    },
    'wecom-bot': {
      title: '企业微信机器人配置说明',
      badge: '机器人消息',
      iconKey: 'wecom',
      intro: '机器人模式适合把新邮件推送到企业微信单聊或群聊，核心参数是 Bot ID（机器人 ID）、Bot Secret（机器人密钥）和 Target ID（目标 ID）。',
      config: [
        { label: 'Bot ID（机器人 ID）', value: '企业微信智能机器人后台生成的机器人 ID' },
        { label: 'Bot Secret（机器人密钥）', value: '与 Bot ID 对应的密钥（Secret）' },
        { label: 'Target ID（目标 ID）', value: '单聊填 UserID（成员 ID），群聊填 ChatID（群聊 ID）' },
      ],
      steps: [
        '进入企业微信智能机器人后台创建机器人，复制 Bot ID（机器人 ID）和 Bot Secret（机器人密钥）。',
        '先让目标用户或目标群聊给这个机器人发一条消息，系统下方的“会话 ID 助手”才能捕获到目标。',
        '如果是单聊，Target ID（目标 ID）填写 UserID（成员 ID）；如果是群聊，填写 ChatID（群聊 ID）。',
        '将 Bot ID（机器人 ID）、Bot Secret（机器人密钥）和 Target ID（目标 ID）填回本系统，保存后点击“发送测试消息”确认能否正常收到。',
      ],
      notes: [
        '机器人模式适合群聊和单聊提醒，不适合做应用卡片跳转。',
        '如果你不确定目标 ID，可以先留空，等下方助手自动捕获后再一键回填。',
        '建议保存完成后立即发送测试消息，确认 Bot ID（机器人 ID）、Bot Secret（机器人密钥）和 Target ID（目标 ID）都正确。',
      ],
      links: [
        { label: '企业微信智能机器人官方文档', url: 'https://developer.work.weixin.qq.com/document/path/100719' },
      ],
    },
    'wecom-app': {
      title: '企业微信应用配置说明',
      badge: '应用卡片',
      iconKey: 'wecom',
      intro:
        '应用模式适合发送卡片消息并跳转查看原邮件 HTML 页面，核心参数包括 Corp ID（企业 ID）、Agent ID（应用 ID）、App Secret（应用密钥）、Receiver ID（接收对象 ID）和 Public Base URL（系统公网地址）。',
      config: [
        { label: 'Corp ID（企业 ID）', value: '企业微信管理后台里的企业 CorpID' },
        { label: 'Agent ID（应用 ID）', value: '自建应用详情页里的 AgentId（应用 ID）' },
        { label: 'App Secret（应用密钥）', value: '自建应用对应的 Secret' },
        { label: 'Receiver ID（接收对象 ID）', value: '成员、部门或标签的 ID，具体取决于 Receiver Type（接收对象类型）' },
        { label: 'Public Base URL（系统公网地址）', value: 'Mail Union 对外可访问的 HTTPS 地址，用于打开完整邮件页面' },
        {
          label: 'Callback URL（接收消息 URL） / Callback Token（回调令牌） / EncodingAESKey（消息加解密密钥）',
          value: '保存一次基础配置后，系统会自动生成这 3 个接收消息校验参数',
        },
      ],
      steps: [
        '在企业微信管理后台创建自建应用，复制 Corp ID（企业 ID）、Agent ID（应用 ID）和 App Secret（应用密钥）。',
        '在系统里选择 Receiver Type（接收对象类型），再填写对应的 Receiver ID（接收对象 ID），例如成员 UserID（成员 ID）、部门 PartyID（部门 ID）或标签 TagID（标签 ID）。',
        '填写 Public Base URL（系统公网地址），这个地址必须是企业微信客户端可以直接访问的 HTTPS 地址。',
        '先保存一次应用配置，系统会自动生成 Callback URL（接收消息 URL）、Callback Token（回调令牌）和 EncodingAESKey（消息加解密密钥）。',
        '如果你要开启企业微信应用的 API 接收消息，就把上面自动生成的三个参数原样填回企业微信后台，再发送测试消息确认卡片和跳转都正常。',
      ],
      notes: [
        '应用模式发送的是卡片消息，点开后会跳到 Mail Union 的完整邮件预览页。',
        'Public Base URL（系统公网地址）不能填写 localhost、127.0.0.1 或企业微信客户端无法访问的内网地址。',
        '如果保存后还没看到 Callback URL（接收消息 URL），先确认 Public Base URL（系统公网地址）已经正确填写。',
      ],
      links: [
        { label: '企业微信发送应用消息官方文档', url: 'https://developer.work.weixin.qq.com/document/path/90236' },
        { label: '企业微信文本卡片官方文档', url: 'https://developer.work.weixin.qq.com/document/path/90372' },
        { label: '企业微信 API 接收消息官方文档', url: 'https://developer.work.weixin.qq.com/document/10514' },
      ],
    },
    wecom: null,
    feishu: {
      title: '飞书配置说明',
      badge: '自定义机器人',
      iconKey: 'feishu',
      intro: '飞书通常只需要填写 Webhook URL（机器人地址）；如果机器人启用了签名校验，再额外填写 Sign Secret（签名密钥）。',
      config: [
        { label: 'Webhook URL（机器人地址）', value: '飞书群机器人配置页复制的 webhook 地址' },
        { label: 'Sign Secret（签名密钥）', value: '只有开启签名校验时才需要填写' },
        { label: '验证方式', value: '保存后可直接发送测试消息确认群里能收到' },
      ],
      steps: [
        '进入目标飞书群，添加一个自定义机器人。',
        '在机器人配置页复制 Webhook URL（机器人地址）。',
        '如果安全设置里启用了签名校验，再同时复制 Sign Secret（签名密钥）。',
        '把对应内容填回本系统，保存后点击“发送测试消息”确认消息是否能正常推送。',
      ],
      notes: [
        '如果机器人只开启了关键词或 IP 白名单，通常只需要填写 Webhook URL（机器人地址）。',
        'Sign Secret（签名密钥）只有在开启“签名校验”时才需要填写。',
        '如果测试失败，优先检查群机器人是否仍在群内，以及安全策略是否放行当前请求。',
      ],
      links: [{ label: '飞书自定义机器人官方文档', url: 'https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot' }],
    },
  };

  guides.wecom = guides['wecom-app'];
  return guides[normalized] || guides.telegram;
}

function renderNotificationGuideModal(channel) {
  const guide = notificationGuideData(channel);

  return `
    <div class="modal-shell notification-guide-shell">
      <div class="modal-backdrop" data-notification-guide-overlay></div>
      <section class="modal-panel mailbox-guide-modal notification-guide-modal">
        <div class="mailbox-guide-header">
          <div class="mailbox-guide-title">
            ${renderAutoIcon(guide.iconKey || channel, guide.title, 'provider-icon-guide notification-guide-icon')}
            <div class="mailbox-guide-title-copy">
              <div class="mailbox-guide-title-row">
                <h3>${escapeHtml(guide.title)}</h3>
                <span class="tag subtle">${escapeHtml(guide.badge)}</span>
              </div>
              <p>${escapeHtml(guide.intro)}</p>
            </div>
          </div>
          <button class="modal-close" type="button" data-action="close-notification-guide" aria-label="关闭说明">×</button>
        </div>
        <div class="mailbox-guide-body">
          <section class="mailbox-guide-section">
            <h4>需要填写什么</h4>
            <div class="mailbox-guide-grid">
              ${guide.config
                .map(
                  (item) => `
                    <div class="mailbox-guide-card">
                      <span>${escapeHtml(item.label)}</span>
                      <code>${escapeHtml(item.value)}</code>
                    </div>
                  `,
                )
                .join('')}
            </div>
          </section>
          <section class="mailbox-guide-section">
            <h4>配置步骤</h4>
            <ol class="mailbox-guide-list">
              ${guide.steps.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}
            </ol>
          </section>
          <section class="mailbox-guide-section">
            <h4>注意事项</h4>
            <ul class="mailbox-guide-list mailbox-guide-list-muted">
              ${guide.notes.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}
            </ul>
          </section>
          <section class="mailbox-guide-section">
            <h4>官方文档</h4>
            <div class="notification-guide-links">
              ${guide.links
                .map(
                  (item) => `
                    <a class="notification-guide-link" href="${escapeHtml(item.url)}" target="_blank" rel="noreferrer">
                      ${escapeHtml(item.label)}
                    </a>
                  `,
                )
                .join('')}
            </div>
          </section>
        </div>
      </section>
    </div>
  `;
}

function systemMicrosoftGuideDataLegacy(callbackUrl, alternateCallbackUrl = '') {
  const config = [
    { label: '客户端 ID（Client ID）', value: 'Microsoft Entra 管理中心 -> 应用注册（App registrations）-> 概览（Overview）-> 应用程序（客户端）ID（Application (client) ID）' },
    { label: '目录（租户）ID（Directory (tenant) ID）', value: '企业租户填写目录（租户）ID（Directory (tenant) ID）；个人 Outlook / Hotmail 一般填写通用租户（common）' },
    { label: '客户端密钥（Client Secret）', value: '证书和密码（Certificates & secrets）-> 新建客户端密钥（New client secret）-> 复制密钥值（Value）回填到系统' },
    { label: '当前回调地址（Redirect URI）', value: callbackUrl },
  ];

  if (alternateCallbackUrl) {
    config.push({
      label: '备用本地回调（Alternate Redirect URI）',
      value: alternateCallbackUrl,
    });
  }

  return {
    title: 'Microsoft 应用配置教程',
    badge: '步骤教程（Step by Step）',
    intro:
      '管理员只需要在这里配置一次 Microsoft 应用，后续 Outlook / Microsoft 365 邮箱就能直接点击“连接 Microsoft”完成授权。',
    config,
    steps: [
      '打开 Microsoft Entra 管理中心，进入“应用注册（App registrations）”，点击“新注册（New registration）”。应用名称可以自定义，例如 Mail Union。',
      '账户类型如果既要支持企业账号又要支持个人 Outlook / Hotmail，建议选择“任何组织目录中的帐户和个人 Microsoft 帐户”；如果只给单一企业租户使用，可以改为单租户（Single tenant）。',
      `在“重定向 URI（Redirect URI）”里选择 Web，并填写 ${callbackUrl}${alternateCallbackUrl ? `；如果你会在两个地址之间切换，建议把 ${alternateCallbackUrl} 也一并加入。` : '。'}`,
      '创建应用后，在“概览（Overview）”页面复制“应用程序（客户端）ID（Application (client) ID）”，填到本系统的“客户端 ID（Client ID）”。',
      '同一页面可以看到“目录（租户）ID（Directory (tenant) ID）”。个人 Outlook / Hotmail 账号一般可直接填写“通用租户（common）”；企业租户更建议填写真实的租户 ID。',
      '进入“证书和密码（Certificates & secrets）”，新建一个“客户端密钥（Client Secret）”，并把生成后的“密钥值（Value）”立即复制回来。这个值通常只显示一次，标准服务器部署更建议填写 Secret。',
      '进入“API 权限（API permissions）-> 添加权限（Add a permission）”。Graph API 至少添加“委托权限（Delegated permissions）”里的“离线访问（offline_access）”和“邮件读取（Mail.Read）”或“邮件读写（Mail.ReadWrite）”；如果需要 IMAP 同步，再给 Exchange Online 添加“IMAP.AccessAsUser.All”。',
      '如果租户要求管理员同意权限，请在“API 权限（API permissions）”页面完成“授予管理员同意（Grant admin consent）”。保存本系统设置后，再去“邮箱管理”里新增 Outlook 邮箱并点击“连接 Microsoft”。',
    ],
    notes: [
      '如果你当前是通过 http://127.0.0.1:52080/ 打开的后台，就优先把 127.0.0.1 这条回调地址加入微软后台；只配 localhost 会导致回调不匹配。',
      '部署到正式服务器后，需要把回调地址改成你的实际域名，例如 https://your-domain/api/oauth/microsoft/callback。',
      '客户端密钥（Client Secret）建议妥善保管；如果泄露，建议立即在微软后台吊销并重新生成。',
      'Graph API + IMAP 双协议模式的权限最完整，但也最容易因为回调地址、租户（Tenant）、API 权限或管理员同意缺失而失败。',
    ],
    links: [
      { label: 'Microsoft Graph：注册应用（Register your app）', url: 'https://learn.microsoft.com/en-us/graph/auth-register-app-v2' },
      { label: 'Microsoft Entra：添加凭据（Add credentials）', url: 'https://learn.microsoft.com/en-us/entra/identity-platform/how-to-add-credentials' },
      {
        label: 'Exchange Online：IMAP/POP/SMTP OAuth 说明',
        url: 'https://learn.microsoft.com/en-us/exchange/client-developer/legacy-protocols/how-to-authenticate-an-imap-pop-smtp-application-by-using-oauth',
      },
      { label: 'Microsoft Graph：权限参考（Permissions reference）', url: 'https://learn.microsoft.com/en-us/graph/permissions-reference' },
    ],
  };
}

function renderSystemMicrosoftGuideModalLegacy(callbackUrl, alternateCallbackUrl = '') {
  const guide = systemMicrosoftGuideDataLegacy(callbackUrl, alternateCallbackUrl);

  return `
    <div class="modal-shell notification-guide-shell">
      <div class="modal-backdrop" data-system-microsoft-guide-overlay></div>
      <section class="modal-panel mailbox-guide-modal notification-guide-modal">
        <div class="mailbox-guide-header">
          <div class="mailbox-guide-title">
            ${renderAutoIcon('system', guide.title, 'provider-icon-guide notification-guide-icon')}
            <div class="mailbox-guide-title-copy">
              <div class="mailbox-guide-title-row">
                <h3>${escapeHtml(guide.title)}</h3>
                <span class="tag subtle">${escapeHtml(guide.badge)}</span>
              </div>
              <p>${escapeHtml(guide.intro)}</p>
            </div>
          </div>
          <button class="modal-close" type="button" data-action="close-system-microsoft-guide" aria-label="关闭说明">×</button>
        </div>
        <div class="mailbox-guide-body">
          <section class="mailbox-guide-section">
            <h4>这些值分别去哪拿</h4>
            <div class="mailbox-guide-grid">
              ${guide.config
                .map(
                  (item) => `
                    <div class="mailbox-guide-card">
                      <span>${escapeHtml(item.label)}</span>
                      <code>${escapeHtml(item.value)}</code>
                    </div>
                  `,
                )
                .join('')}
            </div>
          </section>
          <section class="mailbox-guide-section">
            <h4>配置步骤</h4>
            <ol class="mailbox-guide-list">
              ${guide.steps.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}
            </ol>
          </section>
          <section class="mailbox-guide-section">
            <h4>注意事项</h4>
            <ul class="mailbox-guide-list mailbox-guide-list-muted">
              ${guide.notes.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}
            </ul>
          </section>
          <section class="mailbox-guide-section">
            <h4>官方文档</h4>
            <div class="notification-guide-links">
              ${guide.links
                .map(
                  (item) => `
                    <a class="notification-guide-link" href="${escapeHtml(item.url)}" target="_blank" rel="noreferrer">
                      ${escapeHtml(item.label)}
                    </a>
                  `,
                )
                .join('')}
            </div>
          </section>
        </div>
      </section>
    </div>
  `;
}

function systemMicrosoftGuideData(callbackUrl, alternateCallbackUrl = '') {
  const config = [
    {
      label: '客户端 ID（Client ID）',
      value:
        'Microsoft Entra 管理中心 -> 应用注册（App registrations）-> 概览（Overview）-> 应用程序(客户端) ID（Application (client) ID）',
    },
    {
      label: '目录（租户）ID（Directory (tenant) ID）',
      value:
        '企业 Microsoft 365 邮箱填写概览页的 Directory (tenant) ID；个人 Outlook / Hotmail / Live / MSN 邮箱优先填写 common，必要时可改 consumers',
    },
    {
      label: '客户端密钥（Client Secret）',
      value:
        '证书和密码（Certificates & secrets）-> 新建客户端密码（New client secret）-> 复制“值（Value）”回填到系统，不要填“机密 ID（Secret ID）”',
    },
    {
      label: '回调地址（Redirect URI）',
      value: callbackUrl,
    },
  ];

  if (alternateCallbackUrl) {
    config.push({
      label: '备用本地回调（Alternate Redirect URI）',
      value: alternateCallbackUrl,
    });
  }

  return {
    title: 'Microsoft 应用配置教程',
    badge: 'Step by Step',
    intro:
      '管理员只需要在这里配置一次 Microsoft 应用，后续 Outlook / Microsoft 365 邮箱就能直接点击“连接 Microsoft”完成授权。',
    config,
    quickFill: [
      {
        title: '个人 Outlook / Hotmail 邮箱',
        badge: '推荐写法',
        items: [
          'Client ID：填写概览页里的 Application (client) ID',
          'Tenant ID：优先填 common，纯个人号也可用 consumers',
          'Client Secret：填写 Certificates & secrets 里的 Value',
        ],
      },
      {
        title: '企业 Microsoft 365 邮箱',
        badge: '公司域名邮箱',
        items: [
          'Client ID：填写概览页里的 Application (client) ID',
          'Tenant ID：填写概览页里的 Directory (tenant) ID',
          'Client Secret：填写 Certificates & secrets 里的 Value',
        ],
      },
    ],
    steps: [
      '打开 Microsoft Entra 管理中心，进入“应用注册（App registrations）”，点击“新注册（New registration）”。应用名称可以自定义，例如 Mail Union。',
      '如果既要支持企业账号，也要支持个人 Outlook / Hotmail，建议在“受支持的帐户类型（Supported account types）”里选择“任何组织目录中的帐户和个人 Microsoft 帐户”。如果只给单一企业租户使用，也可以选单租户。',
      `在“身份验证（Authentication）”里添加平台，平台类型必须选择 Web，不要选 SPA。回调地址填写 ${callbackUrl}${alternateCallbackUrl ? `；如果你会在 127.0.0.1 和 localhost 之间切换，建议把 ${alternateCallbackUrl} 也一并加上。` : '。'}`,
      '创建应用后，回到“概览（Overview）”页面，把“应用程序(客户端) ID（Application (client) ID）”复制到系统里的“客户端 ID（Client ID）”。',
      '同一页面还能看到“目录（租户）ID（Directory (tenant) ID）”。企业 Microsoft 365 邮箱填写这里的 GUID；个人 Outlook / Hotmail / Live / MSN 邮箱优先填写 common。',
      '进入“证书和密码（Certificates & secrets）”，新建一个“客户端密码（Client Secret）”，然后立刻复制“值（Value）”。系统里填的是 Value，不是 Secret ID。',
      '进入“API 权限（API permissions）-> 添加权限（Add a permission）”。至少补齐 Delegated permissions 里的 offline_access、Mail.Read 或 Mail.ReadWrite；如果要启用 IMAP 同步，再补 Exchange Online 的 IMAP.AccessAsUser.All。',
      '如果租户要求管理员同意权限，请在“API 权限（API permissions）”页面点击“授予管理员同意（Grant admin consent）”。保存系统设置后，再去“邮箱管理”里新增 Outlook 邮箱并点击“连接 Microsoft”。',
    ],
    mistakes: [
      '不要把对象 ID（Object ID）填到系统里，系统只认 Client ID、Tenant ID、Client Secret。',
      '不要把机密 ID（Secret ID）当成 Client Secret。系统里要填的是“值（Value）”。',
      '回调平台必须是 Web，不是 SPA。很多授权失败就是因为平台类型选错。',
      '个人 Outlook / Hotmail 邮箱优先使用 common；企业 Microsoft 365 邮箱再填 Directory (tenant) ID 的 GUID。',
    ],
    notes: [
      '如果你当前是通过 http://127.0.0.1:52080/ 打开的后台，就优先把 127.0.0.1 这条回调地址加入微软后台；只配 localhost 会导致回调不匹配。',
      '部署到正式服务器后，需要把回调地址改成你的实际域名，例如 https://your-domain/api/oauth/microsoft/callback。',
      '客户端密钥（Client Secret）建议妥善保管；如果泄露，建议立即在微软后台吊销并重新生成。',
      'Graph API + IMAP 双协议模式权限最完整，但也最依赖 Tenant、回调地址、API 权限和管理员同意都配置正确。',
    ],
    links: [
      {
        label: 'Microsoft Graph：注册应用（Register your app）',
        url: 'https://learn.microsoft.com/en-us/graph/auth-register-app-v2',
      },
      {
        label: 'Microsoft Entra：添加凭据（Add credentials）',
        url: 'https://learn.microsoft.com/en-us/entra/identity-platform/how-to-add-credentials',
      },
      {
        label: 'Exchange Online：IMAP / POP / SMTP OAuth 说明',
        url: 'https://learn.microsoft.com/en-us/exchange/client-developer/legacy-protocols/how-to-authenticate-an-imap-pop-smtp-application-by-using-oauth',
      },
      {
        label: 'Microsoft Graph：权限参考（Permissions reference）',
        url: 'https://learn.microsoft.com/en-us/graph/permissions-reference',
      },
    ],
  };
}

function renderSystemMicrosoftGuideModal(callbackUrl, alternateCallbackUrl = '') {
  const guide = systemMicrosoftGuideData(callbackUrl, alternateCallbackUrl);

  return `
    <div class="modal-shell notification-guide-shell">
      <div class="modal-backdrop" data-system-microsoft-guide-overlay></div>
      <section class="modal-panel mailbox-guide-modal notification-guide-modal">
        <div class="mailbox-guide-header">
          <div class="mailbox-guide-title">
            ${renderAutoIcon('system', guide.title, 'provider-icon-guide notification-guide-icon')}
            <div class="mailbox-guide-title-copy">
              <div class="mailbox-guide-title-row">
                <h3>${escapeHtml(guide.title)}</h3>
                <span class="tag subtle">${escapeHtml(guide.badge)}</span>
              </div>
              <p>${escapeHtml(guide.intro)}</p>
            </div>
          </div>
          <button class="modal-close" type="button" data-action="close-system-microsoft-guide" aria-label="关闭说明">×</button>
        </div>
        <div class="mailbox-guide-body">
          <section class="mailbox-guide-section">
            <h4>这些值分别去哪里拿</h4>
            <div class="mailbox-guide-grid">
              ${guide.config
                .map(
                  (item) => `
                    <div class="mailbox-guide-card">
                      <span>${escapeHtml(item.label)}</span>
                      <code>${escapeHtml(item.value)}</code>
                    </div>
                  `,
                )
                .join('')}
            </div>
          </section>
          <section class="mailbox-guide-section">
            <h4>最常用填写方式</h4>
            <div class="mailbox-guide-grid">
              ${guide.quickFill
                .map(
                  (item) => `
                    <div class="mailbox-guide-card">
                      <span>${escapeHtml(item.badge)}</span>
                      <strong>${escapeHtml(item.title)}</strong>
                      <ul class="mailbox-guide-list mailbox-guide-list-muted">
                        ${item.items.map((entry) => `<li>${escapeHtml(entry)}</li>`).join('')}
                      </ul>
                    </div>
                  `,
                )
                .join('')}
            </div>
          </section>
          <section class="mailbox-guide-section">
            <h4>配置步骤</h4>
            <ol class="mailbox-guide-list">
              ${guide.steps.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}
            </ol>
          </section>
          <section class="mailbox-guide-section">
            <h4>最容易填错的地方</h4>
            <ul class="mailbox-guide-list">
              ${guide.mistakes.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}
            </ul>
          </section>
          <section class="mailbox-guide-section">
            <h4>注意事项</h4>
            <ul class="mailbox-guide-list mailbox-guide-list-muted">
              ${guide.notes.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}
            </ul>
          </section>
          <section class="mailbox-guide-section">
            <h4>官方文档</h4>
            <div class="notification-guide-links">
              ${guide.links
                .map(
                  (item) => `
                    <a class="notification-guide-link" href="${escapeHtml(item.url)}" target="_blank" rel="noreferrer">
                      ${escapeHtml(item.label)}
                    </a>
                  `,
                )
                .join('')}
            </div>
          </section>
        </div>
      </section>
    </div>
  `;
}

function notificationEmojiGuideData() {
  return [
    {
      title: '状态提醒',
      note: '适合做是否已读、是否异常、是否完成之类的第一眼提示。',
      items: ['📬 新邮件', '📥 收件', '✅ 已处理', '☑️ 已确认', '🆕 未读', '📌 置顶', '⭐ 星标', '📎 附件'],
    },
    {
      title: '告警与安全',
      note: '适合验证码、风控、安全通知、设备提醒等偏重要场景。',
      items: ['🚨 告警', '⚠️ 风险', '🔐 安全', '🛡️ 防护', '❗ 重要', '🔥 紧急', '⛔ 拦截', '🧪 测试'],
    },
    {
      title: '工作协作',
      note: '适合审批、项目、团队同步、业务流转这类偏协作的文案。',
      items: ['👤 用户', '👥 团队', '💼 业务', '🧾 账单', '📊 报表', '🗂️ 项目', '📝 摘要', '📣 通知'],
    },
    {
      title: '时间与节奏',
      note: '适合催办、截止时间、日程提醒和周期性汇总。',
      items: ['⏰ 定时', '🕒 时间', '📅 日程', '⌛ 等待', '🚀 立即', '🔄 同步', '📍 到达', '🌙 夜间'],
    },
    {
      title: '推荐组合',
      note: '下面这些写法直接复制到模板里就很好用，能比纯文字更有层次。',
      items: [
        '📬 新邮件到达',
        '🆕 未读邮件提醒',
        '🚨 重要邮件告警',
        '⭐ 星标邮件同步',
        '🧾 账单邮件摘要',
        '🔐 安全验证码通知',
        '📌 重点邮件速览',
        '👀 请尽快查看',
      ],
    },
  ];
}

function renderNotificationEmojiGuideModal() {
  const groups = notificationEmojiGuideData();

  return `
    <div class="modal-shell notification-guide-shell emoji-guide-shell">
      <div class="modal-backdrop" data-emoji-guide-overlay></div>
      <section class="modal-panel notification-guide-modal emoji-guide-modal">
        <div class="mailbox-guide-header">
          <div class="mailbox-guide-title">
            ${renderAutoIcon('notes', 'emoji', 'provider-icon-guide notification-guide-icon')}
            <div class="mailbox-guide-title-copy">
              <div class="mailbox-guide-title-row">
                <h3>通知表情文档</h3>
                <span class="tag subtle">Emoji Pack</span>
              </div>
              <p>给通知模板加一点情绪、层次和辨识度。直接把下面这些表情复制进 Telegram、企业微信、飞书模板里即可。</p>
            </div>
          </div>
          <button class="modal-close" type="button" data-action="close-notification-emoji-guide" aria-label="关闭表情文档">×</button>
        </div>
        <div class="mailbox-guide-body">
          <div class="emoji-guide-grid">
            ${groups
              .map(
                (group) => `
                  <section class="emoji-guide-card">
                    <div class="emoji-guide-card-head">
                      <h4>${escapeHtml(group.title)}</h4>
                      <p>${escapeHtml(group.note)}</p>
                    </div>
                    <div class="emoji-guide-chip-grid">
                      ${group.items
                        .map((item) => {
                          const [emoji, ...rest] = String(item || '').split(' ');
                          return `
                            <div class="emoji-guide-chip">
                              <span class="emoji-guide-glyph">${escapeHtml(emoji || '✨')}</span>
                              <span>${escapeHtml(rest.join(' ') || item)}</span>
                            </div>
                          `;
                        })
                        .join('')}
                    </div>
                  </section>
                `,
              )
              .join('')}
          </div>
          <section class="mailbox-guide-section">
            <h4>使用建议</h4>
            <ul class="mailbox-guide-list mailbox-guide-list-muted">
              <li>标题前面放 1 个主表情最稳妥，比如“📬 新邮件到达”或“🚨 重要邮件提醒”。</li>
              <li>每一行都堆很多表情会显得杂乱，建议一段里控制在 1 到 3 个重点表情。</li>
              <li>验证码、安全、告警类场景优先用清晰的提醒型表情，避免过度活泼影响判断。</li>
              <li>如果你想做“小卡片”感觉，可以把表情和分隔符、缩进、换行一起搭配使用。</li>
            </ul>
          </section>
        </div>
      </section>
    </div>
  `;
}

const SYSTEM_ICON_SVG = {
  dashboard:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5.5h7v6H4z"/><path d="M13 5.5h7v10h-7z"/><path d="M4 13.5h7v5H4z"/><path d="M13 17.5h7v1H13z"/></svg>',
  inbox:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7.5A2.5 2.5 0 0 1 6.5 5h11A2.5 2.5 0 0 1 20 7.5v9A2.5 2.5 0 0 1 17.5 19h-11A2.5 2.5 0 0 1 4 16.5z"/><path d="M4 13h4.2l1.8 2h4l1.8-2H20"/></svg>',
  mailboxes:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="6" width="16" height="5" rx="2"/><rect x="4" y="13" width="16" height="5" rx="2"/><path d="M8 8.5h.01"/><path d="M8 15.5h.01"/></svg>',
  notifications:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4.5a4 4 0 0 0-4 4v2.1c0 .7-.2 1.3-.6 1.8L6 14.5V16h12v-1.5l-1.4-2.1c-.4-.5-.6-1.1-.6-1.8V8.5a4 4 0 0 0-4-4Z"/><path d="M10 18a2 2 0 0 0 4 0"/></svg>',
  users:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M15.5 19a3.5 3.5 0 0 1 3.5-3.5A3.5 3.5 0 0 1 22.5 19"/><path d="M1.5 19a5.5 5.5 0 0 1 11 0"/><circle cx="7" cy="9" r="3"/><circle cx="18" cy="8" r="2.5"/></svg>',
  profile:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="3.5"/><path d="M5 19a7 7 0 0 1 14 0"/></svg>',
  backups:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v3H4Z"/><path d="M6 11v7a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2v-7"/><path d="M9 6V5a1.5 1.5 0 0 1 1.5-1.5h3A1.5 1.5 0 0 1 15 5v1"/><path d="M12 12.5v4"/><path d="M10.5 15h3"/></svg>',
  system:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3.2"/><path d="M19 12a7 7 0 0 0-.1-1.1l2-1.5-2-3.4-2.4 1a7.7 7.7 0 0 0-1.9-1.1l-.3-2.6h-4l-.3 2.6a7.7 7.7 0 0 0-1.9 1.1l-2.4-1-2 3.4 2 1.5A7 7 0 0 0 5 12c0 .4 0 .7.1 1.1l-2 1.5 2 3.4 2.4-1c.6.5 1.2.8 1.9 1.1l.3 2.6h4l.3-2.6c.7-.2 1.3-.6 1.9-1.1l2.4 1 2-3.4-2-1.5c.1-.4.1-.7.1-1.1Z"/></svg>',
  storage:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="6" rx="7" ry="3"/><path d="M5 6v6c0 1.7 3.1 3 7 3s7-1.3 7-3V6"/><path d="M5 12v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6"/></svg>',
  google:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 12a8 8 0 1 1-2.3-5.7"/><path d="M12 12h7"/><path d="M16.5 8.5v7"/></svg>',
  telegram:
    '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M20.6 5.2 4.8 11.3c-.9.4-.9 1.6 0 1.9l4 1.3 1.6 4.8c.3.9 1.5 1.1 2 .3l2.3-3.4 4.1 3.1c.7.5 1.8.1 1.9-.9l1.4-11.3c.1-1.2-1-2-2.1-1.6ZM10.6 13.8l7.4-6.5-5.7 7.9-.7 2.6-.5-4Z"/></svg>',
  wecom:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8 17.5c-3.3 0-6-2.4-6-5.5s2.7-5.5 6-5.5 6 2.4 6 5.5c0 .8-.2 1.6-.5 2.3L14 18l-3.2-1a6.7 6.7 0 0 1-2.8.5Z"/><path d="M15.5 16.5a5.3 5.3 0 0 0 2.5.5l3 .8-.8-2.6a4.9 4.9 0 0 0 1.8-3.7c0-2.8-2.4-5-5.5-5-.9 0-1.7.2-2.4.5"/></svg>',
  feishu:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 7.5 11.5 5 19 8.5l-6.5 2.5Z"/><path d="M5 7.5v8l6.5 3.5v-8Z"/><path d="M19 8.5v8L11.5 20"/></svg>',
  'theme-light':
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2.5v2.2M12 19.3v2.2M4.9 4.9l1.5 1.5M17.6 17.6l1.5 1.5M2.5 12h2.2M19.3 12h2.2M4.9 19.1l1.5-1.5M17.6 6.4l1.5-1.5"/></svg>',
  'theme-dark':
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M18 14.5A6.5 6.5 0 0 1 9.5 6a7.5 7.5 0 1 0 8.5 8.5Z"/></svg>',
  'menu-expand':
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5.5h7M4 10.5h7M4 15.5h7M4 19.5h7"/><path d="m15 8 4 4-4 4"/></svg>',
  'menu-collapse':
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M13 5.5h7M13 10.5h7M13 15.5h7M13 19.5h7"/><path d="m9 8-4 4 4 4"/></svg>',
  logout:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 5.5H6.5A2.5 2.5 0 0 0 4 8v8a2.5 2.5 0 0 0 2.5 2.5H9"/><path d="M14 8.5 18 12l-4 3.5"/><path d="M18 12H9"/></svg>',
  mail:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="6" width="17" height="12" rx="2.5"/><path d="m5 8 7 5 7-5"/></svg>',
  refresh:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 4v6h-6"/><path d="M4 20v-6h6"/><path d="M20 10a7.5 7.5 0 0 0-12.8-5.3L4 10"/><path d="M4 14a7.5 7.5 0 0 0 12.8 5.3L20 14"/></svg>',
  sync:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 7h-5"/><path d="m17 4 3 3-3 3"/><path d="M4 17h5"/><path d="m7 14-3 3 3 3"/><path d="M6.8 9.5A7 7 0 0 1 18 7"/><path d="M17.2 14.5A7 7 0 0 1 6 17"/></svg>',
  save:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 5.5h11l3 3V18a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 18Z"/><path d="M8 5.5v5h7v-5"/><path d="M9 16h6"/></svg>',
  delete:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 7.5h15"/><path d="M9.5 4.5h5"/><path d="M7 7.5 8 18a1.5 1.5 0 0 0 1.5 1.4h5A1.5 1.5 0 0 0 16 18l1-10.5"/><path d="M10 11v5.5M14 11v5.5"/></svg>',
  'trash-bin':
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M9 4.5h6"/><path d="M4.5 7h15"/><path d="M7.2 7 8.3 18a1.6 1.6 0 0 0 1.6 1.5h4.2a1.6 1.6 0 0 0 1.6-1.5L16.8 7"/><path d="M10 10.5v5.2M14 10.5v5.2"/><path d="M8 4.5h8l.8 2.5H7.2z"/></svg>',
  close:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.5"/><path d="m9 9 6 6M15 9l-6 6"/></svg>',
  add:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/><rect x="3.5" y="3.5" width="17" height="17" rx="4.5"/></svg>',
  edit:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m4 20 4.2-1 9.1-9.1a2.3 2.3 0 0 0-3.2-3.2L5 15.8 4 20Z"/><path d="M13.5 7.5 17 11"/></svg>',
  test:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 4.5h6"/><path d="M10 4.5v4l-3.8 6.4A3 3 0 0 0 8.8 19h6.4a3 3 0 0 0 2.6-4.1L14 8.5v-4"/><path d="M9.5 13h5"/></svg>',
  translate:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6.5h7"/><path d="M7.5 6.5c0 4.1-2 6.9-5 8.6"/><path d="M4.5 10.5h6"/><path d="M14 18l2.3-6 2.3 6"/><path d="M14.8 16h3"/><path d="M13.5 7.5H20"/></svg>',
  read:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8.5 12 14l8-5.5"/><path d="M4 8.5A2.5 2.5 0 0 1 6.5 6h11A2.5 2.5 0 0 1 20 8.5v7A2.5 2.5 0 0 1 17.5 18h-11A2.5 2.5 0 0 1 4 15.5z"/><path d="m9 12.5 2 2 4-4"/></svg>',
  unread:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20a8 8 0 1 0-8-8"/><path d="M7.5 7.5 12 12l3-3"/><circle cx="18.5" cy="6.5" r="2.5" fill="currentColor" stroke="none"/></svg>',
  star:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m12 4.8 2.2 4.5 5 .7-3.6 3.5.8 5-4.4-2.3-4.4 2.3.8-5-3.6-3.5 5-.7Z"/></svg>',
  pin:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m14 4 6 6-3 1.5-2.5 6.5-2-2L8 20l-1.5-1.5 4-4.5-2-2Z"/></svg>',
  warning:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m12 4 8 14H4z"/><path d="M12 9v4.5"/><path d="M12 17h.01"/></svg>',
  recent:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8"/><path d="M12 7.5V12l3 2"/></svg>',
  open:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 5.5h5v5"/><path d="M19 5.5 11 13.5"/><path d="M18 13v4A1.5 1.5 0 0 1 16.5 18h-10A1.5 1.5 0 0 1 5 16.5v-10A1.5 1.5 0 0 1 6.5 5H11"/></svg>',
  view:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z"/><circle cx="12" cy="12" r="2.8"/></svg>',
  hide:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 3.5 20.5 20.5"/><path d="M10.6 6.2a10.4 10.4 0 0 1 1.4-.2c6 0 9.5 6 9.5 6a16.4 16.4 0 0 1-3.3 3.8"/><path d="M6.1 8.1A16.5 16.5 0 0 0 2.5 12s3.5 6 9.5 6c.4 0 .8 0 1.2-.1"/><path d="M9.9 9.9A2.9 2.9 0 0 0 9.2 12c0 1.5 1.3 2.8 2.8 2.8.8 0 1.5-.3 2.1-.7"/></svg>',
  import:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v10"/><path d="m8.5 10.5 3.5 3.5 3.5-3.5"/><path d="M4 16.5A1.5 1.5 0 0 0 5.5 18h13a1.5 1.5 0 0 0 1.5-1.5V15"/></svg>',
  send:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m20 4-8.5 16-2.5-6.5L2.5 11z"/><path d="M20 4 9 13.5"/></svg>',
  search:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="10.5" cy="10.5" r="5.5"/><path d="m15 15 5 5"/></svg>',
  filter:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6.5h16"/><path d="M7 12h10"/><path d="M10 17.5h4"/></svg>',
  clear:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m6 14 5-7h7a2 2 0 0 1 1.6 3.2L15.5 17A2 2 0 0 1 14 17.8H7.5A2 2 0 0 1 6 14Z"/><path d="m10 11 5 5"/><path d="m15 11-5 5"/></svg>',
  tool:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m14 6 4 4"/><path d="m12 8 4 4"/><path d="M5 19l7.5-7.5"/><path d="M4 20l3.5-1 9-9A2.1 2.1 0 1 0 13.5 7l-9 9Z"/></svg>',
  notes:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M7 4.5h8l4 4V19a1.5 1.5 0 0 1-1.5 1.5h-10A1.5 1.5 0 0 1 6 19V6A1.5 1.5 0 0 1 7.5 4.5Z"/><path d="M15 4.5V9h4"/><path d="M9 12h6M9 16h6"/></svg>',
};

function normalizeIconKey(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[\s_:/]+/g, '-')
    .replace(/[^a-z0-9-]/g, '');
}

function resolveAutoIconKey(key, label = '') {
  const rawPrimary = String(key || '')
    .trim()
    .toLowerCase();
  const rawSecondary = String(label || '')
    .trim()
    .toLowerCase();
  const primary = normalizeIconKey(key);
  const secondary = normalizeIconKey(label);
  const haystack = [primary, secondary, rawPrimary, rawSecondary].filter(Boolean).join(' ');

  if (SYSTEM_ICON_SVG[primary]) {
    return primary;
  }

  if (!haystack) {
    return 'mail';
  }

  const keywordMap = [
    ['refresh', 'refresh'],
    ['all', 'inbox'],
    ['reload', 'refresh'],
    ['刷新', 'refresh'],
    ['sync', 'sync'],
    ['同步', 'sync'],
    ['save', 'save'],
    ['保存', 'save'],
    ['trash-bin', 'trash-bin'],
    ['delete', 'delete'],
    ['trash', 'trash-bin'],
    ['junk', 'trash-bin'],
    ['remove', 'delete'],
    ['删除', 'delete'],
    ['已删除', 'trash-bin'],
    ['垃圾', 'trash-bin'],
    ['垃圾箱', 'trash-bin'],
    ['垃圾邮件', 'trash-bin'],
    ['close', 'close'],
    ['cancel', 'close'],
    ['关闭', 'close'],
    ['取消', 'close'],
    ['add', 'add'],
    ['new', 'add'],
    ['create', 'add'],
    ['新增', 'add'],
    ['创建', 'add'],
    ['edit', 'edit'],
    ['update', 'edit'],
    ['修改', 'edit'],
    ['编辑', 'edit'],
    ['test', 'test'],
    ['测试', 'test'],
    ['translate', 'translate'],
    ['翻译', 'translate'],
    ['unread', 'unread'],
    ['未读', 'unread'],
    ['read', 'read'],
    ['已读', 'read'],
    ['star', 'star'],
    ['favorite', 'star'],
    ['星标', 'star'],
    ['pin', 'pin'],
    ['置顶', 'pin'],
    ['open', 'open'],
    ['view', 'open'],
    ['打开', 'open'],
    ['查看', 'open'],
    ['show', 'view'],
    ['visible', 'view'],
    ['显示', 'view'],
    ['hide', 'hide'],
    ['hidden', 'hide'],
    ['隐藏', 'hide'],
    ['import', 'import'],
    ['upload', 'import'],
    ['导入', 'import'],
    ['send', 'send'],
    ['发送', 'send'],
    ['search', 'search'],
    ['搜索', 'search'],
    ['filter', 'filter'],
    ['筛选', 'filter'],
    ['clear', 'clear'],
    ['reset', 'clear'],
    ['清空', 'clear'],
    ['register', 'users'],
    ['注册', 'users'],
    ['login', 'profile'],
    ['登录', 'profile'],
    ['进入', 'open'],
    ['guide', 'notes'],
    ['help', 'notes'],
    ['load', 'notes'],
    ['教程', 'notes'],
    ['说明', 'notes'],
    ['载入', 'notes'],
    ['dashboard', 'dashboard'],
    ['overview', 'dashboard'],
    ['summary', 'dashboard'],
    ['inbox', 'inbox'],
    ['message', 'mail'],
    ['mail', 'mail'],
    ['mailbox', 'mailboxes'],
    ['imap', 'mailboxes'],
    ['notification', 'notifications'],
    ['notify', 'notifications'],
    ['backup', 'backups'],
    ['archive', 'backups'],
    ['备份', 'backups'],
    ['storage', 'storage'],
    ['store', 'storage'],
    ['attachment', 'storage'],
    ['attachments', 'storage'],
    ['附件', 'storage'],
    ['云', 'storage'],
    ['存储', 'storage'],
    ['google', 'google'],
    ['gmail', 'google'],
    ['settings', 'tool'],
    ['config', 'tool'],
    ['telegram', 'telegram'],
    ['tg', 'telegram'],
    ['wecom', 'wecom'],
    ['wechat', 'wecom'],
    ['qywx', 'wecom'],
    ['feishu', 'feishu'],
    ['lark', 'feishu'],
    ['user', 'users'],
    ['admin', 'users'],
    ['profile', 'profile'],
    ['account', 'profile'],
    ['system', 'system'],
    ['theme-light', 'theme-light'],
    ['light', 'theme-light'],
    ['theme-dark', 'theme-dark'],
    ['dark', 'theme-dark'],
    ['logout', 'logout'],
    ['signout', 'logout'],
    ['expand', 'menu-expand'],
    ['collapse', 'menu-collapse'],
    ['star', 'star'],
    ['warning', 'warning'],
    ['error', 'warning'],
    ['status', 'warning'],
    ['recent', 'recent'],
    ['tool', 'tool'],
    ['note', 'notes'],
  ];

  for (const [keyword, iconKey] of keywordMap) {
    if (haystack.includes(keyword)) {
      return iconKey;
    }
  }

  return 'mail';
}

function fallbackIconText(label, key) {
  const normalized = String(label || key || '')
    .replace(/[^a-z0-9]/gi, '')
    .slice(0, 2)
    .toUpperCase();

  return normalized || '@';
}

export function renderAutoIcon(key, label, className = '') {
  const iconKey = resolveAutoIconKey(key, label);
  const iconSvg = SYSTEM_ICON_SVG[iconKey];
  const classes = ['app-icon', className, `app-icon-${iconKey}`].filter(Boolean).join(' ');

  if (iconSvg) {
    return `<span class="${classes}" aria-hidden="true">${iconSvg}</span>`;
  }

  return `
    <span class="${classes} app-icon-fallback" aria-hidden="true">
      <span>${escapeHtml(fallbackIconText(label, key))}</span>
    </span>
  `;
}

function renderSectionTitle(iconKey, content, extraClassName = '') {
  const className = ['section-title', extraClassName].filter(Boolean).join(' ');

  return `
    <div class="${className}">
      ${renderAutoIcon(iconKey, iconKey, 'section-title-icon')}
      <div class="section-title-copy">
        ${content}
      </div>
    </div>
  `;
}

function isInternalUserEmail(email) {
  return /@users\.mail-union\.local$/i.test(String(email || '').trim());
}

function formatUserHandle(user) {
  const username = String(user?.username || '').trim();
  return username ? `@${username}` : String(user?.email || '').trim();
}

function formatUserContact(user) {
  const email = String(user?.email || '').trim();
  return email && !isInternalUserEmail(email) ? email : '未设置联系邮箱';
}

function userInitials(user) {
  const source = String(user?.username || user?.name || user?.email || 'U')
    .trim()
    .slice(0, 2)
    .toUpperCase();

  return source || 'U';
}

function renderAvatar(url, fallbackText, className = '', alt = '') {
  const classes = ['avatar-badge', className].filter(Boolean).join(' ');
  const source = String(url || '').trim();

  if (source) {
    return `
      <span class="${classes} is-image">
        <img src="${escapeHtml(source)}" alt="${escapeHtml(alt || 'avatar')}" loading="lazy" />
      </span>
    `;
  }

  return `<span class="${classes}">${escapeHtml(fallbackText || 'U')}</span>`;
}

const DEFAULT_SYSTEM_SETTINGS = {
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

const TRANSLATION_PROVIDER_OPTIONS = [
  {
    id: 'google_free',
    label: 'Google 免费引擎',
    badge: 'Free',
    description: '无需 API Key，适合海外网络环境下快速翻译英文邮件，但属于公共免费通道。',
  },
  {
    id: 'mymemory_free',
    label: 'MyMemory 免费引擎',
    badge: 'Free',
    description: '无需 API Key，适合短文本和普通正文翻译，长邮件会自动分段处理。',
  },
  {
    id: 'libretranslate',
    label: 'LibreTranslate',
    badge: 'Self-host',
    description: '适合自建或使用公共 LibreTranslate 服务，可选填写 API Key。',
  },
  {
    id: 'azure_translator',
    label: '微软翻译（Azure Translator）',
    badge: 'F0',
    description: '可接入微软 Azure Translator 免费层（F0），需要填写资源密钥，适合稳定部署到服务器长期使用。',
  },
  {
    id: 'openai_compatible',
    label: 'OpenAI 兼容模型',
    badge: 'AI',
    description: '支持 OpenAI 格式接口，适合复杂邮件、专业术语和更自然的上下文翻译。',
  },
];

const SESSION_TIMEOUT_UNIT_OPTIONS = [
  { id: 'minute', label: '分钟' },
  { id: 'hour', label: '小时' },
  { id: 'day', label: '天' },
  { id: 'month', label: '月' },
  { id: 'year', label: '年' },
];

const SYSTEM_THEME_PRESETS = [
  {
    id: 'ocean-mist',
    name: '海雾青蓝',
    badge: 'Clean',
    description: '清爽青蓝系，适合长期管理后台，明亮但不轻浮。',
    swatches: ['#14b8a6', '#4f46e5', '#dff8f6'],
  },
  {
    id: 'aurora-glass',
    name: '极光雾玻',
    badge: 'Glass',
    description: '双层雾化玻璃配极光高光，按钮、面板和背景都会更通透。',
    swatches: ['#67e8f9', '#a855f7', '#dbeafe'],
  },
  {
    id: 'forest-ink',
    name: '森林墨绿',
    badge: 'Nature',
    description: '深绿配冷灰，观感沉稳，也更耐看。',
    swatches: ['#15803d', '#0f3d2e', '#d9f99d'],
  },
  {
    id: 'sunset-coral',
    name: '晚霞珊瑚',
    badge: 'Warm',
    description: '暖橘和珊瑚粉更有亲和力，适合偏运营后台。',
    swatches: ['#f97316', '#fb7185', '#ffedd5'],
  },
  {
    id: 'amber-paper',
    name: '琥珀纸感',
    badge: 'Editorial',
    description: '米白纸感配琥珀色，观感柔和，有一点杂志排版气质。',
    swatches: ['#d97706', '#fef3c7', '#78350f'],
  },
  {
    id: 'cobalt-night',
    name: '钴蓝夜幕',
    badge: 'Bold',
    description: '深蓝高对比风格，整体更利落，信息聚焦感更强。',
    swatches: ['#2563eb', '#1d4ed8', '#dbeafe'],
  },
];

const DEFAULT_THEME_PRESET_ID = 'ocean-mist';
const SYSTEM_THEME_PRESET_IDS = new Set(SYSTEM_THEME_PRESETS.map((preset) => preset.id));
const DEFAULT_SYSTEM_LOGO_URL = '/assets/brand/mail-union-default-logo.png?v=20260504-user-logo-transparent';
const SYSTEM_STORAGE_PROVIDER_OPTIONS = [
  { id: 'local', label: '本地附件目录', description: '文件保存在服务器本地目录，部署最简单。' },
  { id: 's3', label: 'S3 对象存储', description: '适合 AWS S3、Cloudflare R2、MinIO 等兼容服务。' },
  { id: 'webdav', label: 'WebDAV', description: '适合挂载网盘、NAS 或自建 WebDAV 服务。' },
  { id: 'ftp', label: 'FTP / FTPS', description: '适合传统主机环境或已有 FTP 文件服务器。' },
];
const SYSTEM_STORAGE_SYNC_POLICY_OPTIONS = [
  { id: 'all_local', label: '全部保存在本地', description: '所有文件仅保存在本地。' },
  { id: 'all_remote', label: '全部同步到远程', description: '所有文件都会同步到远程存储。' },
  {
    id: 'attachments_remote_only',
    label: '仅邮件附件同步远程',
    description: '邮件附件同步到远程，Logo 和其他资源保留在本地。',
  },
];
const SYSTEM_BACKUP_TARGET_OPTIONS = [
  { id: 'local', label: '仅备份到本地' },
  { id: 'remote', label: '仅备份到远程存储' },
  { id: 'both', label: '本地 + 远程同时备份' },
];
const SYSTEM_BACKUP_CONTENT_MODE_OPTIONS = [
  { id: 'database_only', label: '仅备份数据库' },
  { id: 'site_only', label: '仅备份网站数据' },
  { id: 'database_and_site', label: '备份数据库 + 网站数据' },
];
const SYSTEM_BACKUP_RESTORE_MODE_OPTIONS = [
  { id: 'full_site_data', label: '全部网站数据' },
  { id: 'database_only', label: '仅导入数据库' },
  { id: 'attachments_only', label: '仅导入网站附件' },
];
const SYSTEM_PROXY_MODE_OPTIONS = [
  {
    id: 'direct',
    label: '直连模式',
    badge: 'Direct',
    description: '所有外网请求直接访问，不使用系统代理，也不使用自定义代理。',
  },
  {
    id: 'system',
    label: '跟随系统',
    badge: 'Auto',
    description: '优先使用系统或环境变量里的代理配置，适合服务器统一走代理的部署方式。',
  },
  {
    id: 'custom',
    label: '自定义代理',
    badge: 'Proxy',
    description: '手动填写固定代理地址，Google、Microsoft、Telegram、飞书等外网请求统一走这里。',
  },
];

export function normalizeSystemThemePresetId(presetId) {
  const resolvedPresetId = String(presetId || '').trim();
  return SYSTEM_THEME_PRESET_IDS.has(resolvedPresetId) ? resolvedPresetId : DEFAULT_THEME_PRESET_ID;
}

function normalizeSystemStorageProvider(value) {
  const resolved = String(value || 'local').trim().toLowerCase();
  return SYSTEM_STORAGE_PROVIDER_OPTIONS.some((item) => item.id === resolved) ? resolved : 'local';
}

function systemStorageProviderMeta(providerId) {
  return (
    SYSTEM_STORAGE_PROVIDER_OPTIONS.find((item) => item.id === normalizeSystemStorageProvider(providerId)) ||
    SYSTEM_STORAGE_PROVIDER_OPTIONS[0]
  );
}

function normalizeSystemBackupTarget(value) {
  const resolved = String(value || 'local').trim().toLowerCase();
  return SYSTEM_BACKUP_TARGET_OPTIONS.some((item) => item.id === resolved) ? resolved : 'local';
}

function systemBackupTargetMeta(targetId) {
  return (
    SYSTEM_BACKUP_TARGET_OPTIONS.find((item) => item.id === normalizeSystemBackupTarget(targetId)) ||
    SYSTEM_BACKUP_TARGET_OPTIONS[0]
  );
}

function normalizeSystemBackupContentMode(value) {
  const resolved = String(value || 'database_and_site').trim().toLowerCase();
  return SYSTEM_BACKUP_CONTENT_MODE_OPTIONS.some((item) => item.id === resolved) ? resolved : 'database_and_site';
}

function systemBackupContentModeMeta(contentModeId) {
  return (
    SYSTEM_BACKUP_CONTENT_MODE_OPTIONS.find((item) => item.id === normalizeSystemBackupContentMode(contentModeId)) ||
    SYSTEM_BACKUP_CONTENT_MODE_OPTIONS[2]
  );
}

function normalizeSystemBackupRestoreMode(value) {
  const resolved = String(value || 'full_site_data').trim().toLowerCase();
  return SYSTEM_BACKUP_RESTORE_MODE_OPTIONS.some((item) => item.id === resolved) ? resolved : 'full_site_data';
}

function systemBackupRestoreModeMeta(restoreModeId) {
  return (
    SYSTEM_BACKUP_RESTORE_MODE_OPTIONS.find((item) => item.id === normalizeSystemBackupRestoreMode(restoreModeId)) ||
    SYSTEM_BACKUP_RESTORE_MODE_OPTIONS[0]
  );
}

function normalizeSystemProxyMode(value) {
  const resolved = String(value || 'system').trim().toLowerCase();
  return SYSTEM_PROXY_MODE_OPTIONS.some((item) => item.id === resolved) ? resolved : 'system';
}

function systemProxyModeMeta(mode) {
  return (
    SYSTEM_PROXY_MODE_OPTIONS.find((item) => item.id === normalizeSystemProxyMode(mode)) ||
    SYSTEM_PROXY_MODE_OPTIONS[1]
  );
}

function backupStatusLabel(status) {
  const resolved = String(status || 'pending').trim().toLowerCase();
  if (resolved === 'completed' || resolved === 'success') {
    return '已完成';
  }
  if (resolved === 'failed' || resolved === 'error') {
    return '失败';
  }
  if (resolved === 'running') {
    return '执行中';
  }
  return '等待中';
}

function backupStorageReadyLabel(backup = {}) {
  if (backup.remoteReady && backup.localReady) {
    return '本地 + 远程已就绪';
  }
  if (backup.remoteReady) {
    return '远程已就绪';
  }
  if (backup.localReady) {
    return '本地已就绪';
  }
  if (['failed', 'error'].includes(String(backup.status || '').trim())) {
    return '执行失败';
  }
  if (String(backup.status || '').trim() === 'running') {
    return '执行中';
  }
  return '等待完成';
}

function renderBackupRecordRow(backup = {}, deletingBackupId = '') {
  const backupId = String(backup.id || '').trim();
  const isDeleting = backupId && backupId === String(deletingBackupId || '').trim();
  const isRunning = String(backup.status || '').trim() === 'running';
  const isFailed = ['failed', 'error'].includes(String(backup.status || '').trim());
  const statusLabel = backupStatusLabel(backup.status);
  const destinationLabel = systemBackupTargetMeta(backup.destination).label;
  const storageStatus = backupStorageReadyLabel(backup);
  const triggerSourceLabel = backup.triggerSource === 'scheduled'
    ? '定时任务'
    : backup.triggerSource === 'pre_restore'
      ? '恢复前保护'
      : '手动执行';
  const inlineNotice = backup.error
    ? `<div class="notice error backup-record-inline-notice">${escapeHtml(backup.error)}</div>`
    : backup.remotePath
      ? `<div class="backup-record-path">远程路径：<code>${escapeHtml(backup.remotePath)}</code></div>`
      : '';

  return `
    <article class="backup-record-row ${isFailed ? 'is-failed' : ''}">
      <div class="backup-record-main">
        <div class="backup-record-title">
          <strong>${escapeHtml(backup.filename || '未命名备份')}</strong>
          <p>创建于 ${escapeHtml(formatFullDate(backup.createdAt))}</p>
        </div>
        <div class="backup-record-badges">
          <span class="tag ${isFailed ? 'subtle' : ''}">${escapeHtml(statusLabel)}</span>
          <span class="tag subtle">${escapeHtml(destinationLabel)}</span>
        </div>
      </div>
      <div class="backup-record-footer">
        <div class="backup-record-meta">
          <div class="backup-record-meta-item">
            <span>大小</span>
            <strong>${escapeHtml(formatFileSize(backup.sizeBytes))}</strong>
          </div>
          <div class="backup-record-meta-item">
            <span>触发方式</span>
            <strong>${escapeHtml(triggerSourceLabel)}</strong>
          </div>
          <div class="backup-record-meta-item">
            <span>存储状态</span>
            <strong>${escapeHtml(storageStatus)}</strong>
          </div>
        </div>
        <div class="backup-record-actions">
          <button
            class="tiny-button"
            type="button"
            data-action="download-backup"
            data-url="${escapeHtml(backup.downloadUrl || '')}"
            ${backup.downloadUrl && !isDeleting ? '' : 'disabled'}
          >
            下载
          </button>
          <button
            class="tiny-button danger"
            type="button"
            data-action="delete-backup"
            data-backup-id="${escapeHtml(backupId)}"
            ${backupId && !isDeleting && !isRunning ? '' : 'disabled'}
          >
            ${isDeleting ? '删除中...' : '删除'}
          </button>
        </div>
      </div>
      ${inlineNotice}
    </article>
  `;
}

function normalizeSystemSettings(settings = {}) {
  const mergedSettings = {
    ...DEFAULT_SYSTEM_SETTINGS,
    ...(settings || {}),
  };
  const logoMode = String(mergedSettings.logoMode || 'auto').trim().toLowerCase();
  const translationProvider =
    TRANSLATION_PROVIDER_OPTIONS.find((item) => item.id === String(mergedSettings.translationProvider || '').trim())
      ?.id || 'google_free';

  return {
    ...mergedSettings,
    siteName: String(mergedSettings.siteName || 'Mail Union').trim() || 'Mail Union',
    logoMode: ['auto', 'url', 'upload'].includes(logoMode) ? logoMode : 'auto',
    logoUrl: String(mergedSettings.logoUrl || '').trim(),
    logoAssetUrl: String(mergedSettings.logoAssetUrl || '').trim(),
    logoAssetLocalPath: String(mergedSettings.logoAssetLocalPath || '').trim(),
    logoUploadDataUrl: String(mergedSettings.logoUploadDataUrl || '').trim(),
    logoUploadFilename: String(mergedSettings.logoUploadFilename || '').trim(),
    translationProvider,
    translationTargetLanguage: String(mergedSettings.translationTargetLanguage || 'zh-CN').trim() || 'zh-CN',
    translationBaseUrl: String(mergedSettings.translationBaseUrl || '').trim(),
    translationRegion: String(mergedSettings.translationRegion || '').trim(),
    translationModel: String(mergedSettings.translationModel || '').trim(),
    translationApiKey: String(mergedSettings.translationApiKey || ''),
    googleClientId: String(mergedSettings.googleClientId || '').trim(),
    googleClientSecret: String(mergedSettings.googleClientSecret || ''),
    registrationEnabled: Boolean(mergedSettings.registrationEnabled),
    registrationEmailVerificationRequired: Boolean(mergedSettings.registrationEmailVerificationRequired),
    registrationEmailDomainWhitelist: Array.isArray(mergedSettings.registrationEmailDomainWhitelist)
      ? mergedSettings.registrationEmailDomainWhitelist
      : String(mergedSettings.registrationEmailDomainWhitelist || '')
          .split(/[\r\n,;|\s]+/g)
          .map((item) => item.trim())
          .filter(Boolean),
    passwordResetEnabled: Boolean(mergedSettings.passwordResetEnabled),
    sessionTimeoutValue: Math.max(Math.round(Number(mergedSettings.sessionTimeoutValue || 7) || 7), 1),
    sessionTimeoutUnit: SESSION_TIMEOUT_UNIT_OPTIONS.some(
      (item) => item.id === String(mergedSettings.sessionTimeoutUnit || '').trim(),
    )
      ? String(mergedSettings.sessionTimeoutUnit || '').trim()
      : 'day',
    smtpHost: String(mergedSettings.smtpHost || '').trim(),
    smtpPort: Number(mergedSettings.smtpPort || 587) || 587,
    smtpSecure: Boolean(mergedSettings.smtpSecure),
    smtpUsername: String(mergedSettings.smtpUsername || '').trim(),
    smtpPassword: String(mergedSettings.smtpPassword || ''),
    clearSmtpPassword: Boolean(mergedSettings.clearSmtpPassword),
    smtpFromName: String(mergedSettings.smtpFromName || 'Mail Union').trim() || 'Mail Union',
    smtpFromEmail: String(mergedSettings.smtpFromEmail || '').trim(),
    storageProvider: normalizeSystemStorageProvider(mergedSettings.storageProvider),
    storageSyncPolicy: SYSTEM_STORAGE_SYNC_POLICY_OPTIONS.some(
      (item) => item.id === String(mergedSettings.storageSyncPolicy || '').trim(),
    )
      ? String(mergedSettings.storageSyncPolicy || '').trim()
      : 'all_local',
    storageRemotePathPrefix: String(mergedSettings.storageRemotePathPrefix || 'mail-union').trim() || 'mail-union',
    storageS3Bucket: String(mergedSettings.storageS3Bucket || '').trim(),
    storageS3Region: String(mergedSettings.storageS3Region || '').trim(),
    storageS3Endpoint: String(mergedSettings.storageS3Endpoint || '').trim(),
    storageS3AccessKey: String(mergedSettings.storageS3AccessKey || '').trim(),
    storageS3Secret: String(mergedSettings.storageS3Secret || ''),
    storageWebdavUrl: String(mergedSettings.storageWebdavUrl || '').trim(),
    storageWebdavUsername: String(mergedSettings.storageWebdavUsername || '').trim(),
    storageWebdavPassword: String(mergedSettings.storageWebdavPassword || ''),
    storageFtpHost: String(mergedSettings.storageFtpHost || '').trim(),
    storageFtpPort: Number(mergedSettings.storageFtpPort || 21) || 21,
    storageFtpSecure: Boolean(mergedSettings.storageFtpSecure),
    storageFtpUsername: String(mergedSettings.storageFtpUsername || '').trim(),
    storageFtpPassword: String(mergedSettings.storageFtpPassword || ''),
    backupEnabled: Boolean(mergedSettings.backupEnabled),
    backupIntervalHours: Number(mergedSettings.backupIntervalHours || 24) || 24,
    backupTarget: normalizeSystemBackupTarget(mergedSettings.backupTarget),
    backupRetentionCount: Number(mergedSettings.backupRetentionCount || 10) || 10,
    backupContentMode: normalizeSystemBackupContentMode(
      mergedSettings.backupContentMode
      || (mergedSettings.backupIncludeRuntimeFiles ? 'database_and_site' : 'database_only'),
    ),
    backupIncludeRuntimeFiles:
      normalizeSystemBackupContentMode(
        mergedSettings.backupContentMode
        || (mergedSettings.backupIncludeRuntimeFiles ? 'database_and_site' : 'database_only'),
      ) !== 'database_only',
    outboundProxyMode: normalizeSystemProxyMode(mergedSettings.outboundProxyMode),
    outboundProxyUrl: String(mergedSettings.outboundProxyUrl || '').trim(),
    outboundProxyBypass: String(mergedSettings.outboundProxyBypass || '').trim(),
    themePresetId: normalizeSystemThemePresetId(mergedSettings.themePresetId),
  };
}

function siteBrandInitials(siteName = 'Mail Union') {
  const compact = String(siteName || 'Mail Union').replace(/\s+/g, '').trim();
  return (compact.slice(0, 2) || 'MU').toUpperCase();
}

function systemThemePresetMeta(presetId) {
  const resolvedPresetId = normalizeSystemThemePresetId(presetId);
  return SYSTEM_THEME_PRESETS.find((preset) => preset.id === resolvedPresetId) || SYSTEM_THEME_PRESETS[0];
}

function buildGeneratedBrandLogoSvg(siteName = 'Mail Union') {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" role="img" aria-label="Mail Union"><defs><linearGradient id="mail-union-ring-a" x1="18%" y1="22%" x2="86%" y2="78%"><stop offset="0%" stop-color="#8ee8ff"/><stop offset="48%" stop-color="#198cff"/><stop offset="100%" stop-color="#0839d6"/></linearGradient><linearGradient id="mail-union-ring-b" x1="10%" y1="76%" x2="92%" y2="24%"><stop offset="0%" stop-color="#62dcff"/><stop offset="48%" stop-color="#1168ff"/><stop offset="100%" stop-color="#082ac2"/></linearGradient><linearGradient id="mail-union-envelope" x1="22%" y1="18%" x2="82%" y2="92%"><stop offset="0%" stop-color="#ffffff"/><stop offset="62%" stop-color="#eaf6ff"/><stop offset="100%" stop-color="#b7dcff"/></linearGradient><linearGradient id="mail-union-check" x1="18%" y1="22%" x2="86%" y2="78%"><stop offset="0%" stop-color="#53d8ff"/><stop offset="48%" stop-color="#116cff"/><stop offset="100%" stop-color="#052cce"/></linearGradient><linearGradient id="mail-union-text" x1="28%" y1="0%" x2="78%" y2="100%"><stop offset="0%" stop-color="#0b43e6"/><stop offset="100%" stop-color="#23ccff"/></linearGradient><filter id="mail-union-soft-shadow" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="22" stdDeviation="20" flood-color="#0b4fd8" flood-opacity="0.22"/></filter><filter id="mail-union-glow" x="-30%" y="-30%" width="160%" height="160%"><feDropShadow dx="0" dy="8" stdDeviation="8" flood-color="#11a8ff" flood-opacity="0.38"/></filter></defs><g filter="url(#mail-union-soft-shadow)"><path d="M310 219C430 132 604 126 745 199" fill="none" stroke="url(#mail-union-ring-a)" stroke-width="34" stroke-linecap="square"/><path d="M338 247C450 170 594 164 713 224" fill="none" stroke="#9decff" stroke-width="13" stroke-linecap="square" opacity="0.68"/><path d="M801 248C873 320 910 418 892 520" fill="none" stroke="url(#mail-union-ring-a)" stroke-width="40" stroke-linecap="square"/><circle cx="786" cy="244" r="30" fill="url(#mail-union-check)" stroke="#82e5ff" stroke-width="4"/><path d="M214 506C196 571 200 629 231 684" fill="none" stroke="url(#mail-union-ring-a)" stroke-width="42" stroke-linecap="square"/><path d="M236 674C331 760 473 800 640 775" fill="none" stroke="url(#mail-union-ring-b)" stroke-width="42" stroke-linecap="square"/><path d="M767 724C833 675 878 604 893 520" fill="none" stroke="#49cdf8" stroke-width="30" stroke-linecap="square"/><path d="M185 666C355 559 600 477 844 421" fill="none" stroke="#0636d5" stroke-width="28" stroke-linecap="round"/><path d="M176 674C354 586 585 512 814 466" fill="none" stroke="#67e3ff" stroke-width="11" stroke-linecap="round" opacity="0.78"/><path d="M220 680L261 635L247 718Z" fill="#0734d8"/><rect x="286" y="320" width="452" height="310" rx="56" fill="url(#mail-union-envelope)" stroke="#dff4ff" stroke-width="6"/><path d="M300 600L461 462C492 436 533 436 563 462L724 600" fill="none" stroke="#4d8de8" stroke-width="10" opacity="0.72"/><path d="M310 356L512 522L714 356" fill="none" stroke="#6aa8ff" stroke-width="18" stroke-linecap="round" stroke-linejoin="round" opacity="0.58"/><path d="M315 344L508 512C521 524 541 523 553 510L710 346" fill="none" stroke="url(#mail-union-check)" stroke-width="48" stroke-linecap="round" stroke-linejoin="round" filter="url(#mail-union-glow)"/><path d="M315 344L508 512C521 524 541 523 553 510L710 346" fill="none" stroke="#55dfff" stroke-width="12" stroke-linecap="round" stroke-linejoin="round" opacity="0.52"/><rect x="206" y="348" width="34" height="34" rx="3" fill="#13baf2" opacity="0.86"/><rect x="250" y="316" width="24" height="24" rx="3" fill="#32d0ff" opacity="0.78"/><rect x="248" y="377" width="28" height="28" rx="3" fill="#148cff" opacity="0.82"/><rect x="282" y="348" width="20" height="20" rx="3" fill="#19c5ff" opacity="0.72"/><rect x="244" y="418" width="17" height="17" rx="3" fill="#096dff" opacity="0.72"/><path d="M615 626V687L575 728" fill="none" stroke="#1d83ff" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/><path d="M650 626V700L610 740" fill="none" stroke="#116cff" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/><circle cx="615" cy="626" r="10" fill="#4ad6ff" stroke="#1d83ff" stroke-width="4"/><circle cx="650" cy="626" r="10" fill="#4ad6ff" stroke="#116cff" stroke-width="4"/><circle cx="575" cy="728" r="10" fill="#3abfff" stroke="#116cff" stroke-width="4"/><circle cx="610" cy="740" r="10" fill="#3abfff" stroke="#0a4bdb" stroke-width="4"/></g><g><text x="512" y="892" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-size="66" font-weight="700" letter-spacing="20" fill="url(#mail-union-text)">Mail Union</text><path d="M142 864H226" stroke="url(#mail-union-text)" stroke-width="6" stroke-linecap="round"/><path d="M798 864H882" stroke="url(#mail-union-text)" stroke-width="6" stroke-linecap="round"/><path d="M176 880H226" stroke="#7ce7ff" stroke-width="4" stroke-linecap="round" opacity="0.72"/><path d="M798 880H848" stroke="#7ce7ff" stroke-width="4" stroke-linecap="round" opacity="0.72"/></g></svg>`;
}

function buildGeneratedBrandLogoSource(siteName = 'Mail Union') {
  return DEFAULT_SYSTEM_LOGO_URL;
}

function systemBrandLogoSource(settings = {}, options = {}) {
  const resolved = normalizeSystemSettings(settings);
  const mode = String(resolved.logoMode || 'auto').trim().toLowerCase();
  const preferDraftUrl = Boolean(options.preferDraftUrl);

  if (mode === 'upload') {
    if (preferDraftUrl && resolved.logoUploadDataUrl) {
      return resolved.logoUploadDataUrl;
    }
    if (resolved.logoAssetUrl) {
      return resolved.logoAssetUrl;
    }
  }

  if (mode !== 'auto' && resolved.logoAssetUrl && !preferDraftUrl) {
    return resolved.logoAssetUrl;
  }

  if (mode === 'url') {
    if (preferDraftUrl && resolved.logoUrl) {
      return resolved.logoUrl;
    }
    if (resolved.logoAssetUrl) {
      return resolved.logoAssetUrl;
    }
    if (resolved.logoUrl) {
      return resolved.logoUrl;
    }
  }

  return buildGeneratedBrandLogoSource(resolved.siteName);
}

function renderBrandAvatar(settings = {}, className = 'brand-avatar', alt = 'site logo', options = {}) {
  const resolved = normalizeSystemSettings(settings);
  const source = systemBrandLogoSource(resolved, options);
  const classes = className;
  const avatarKey = `brand:${className}:${source || siteBrandInitials(resolved.siteName)}`;

  if (source) {
    return `
      <span class="${escapeHtml(classes)} is-image" data-brand-avatar-key="${escapeHtmlAttribute(avatarKey)}">
        <img
          src="${escapeHtml(source)}"
          alt="${escapeHtml(alt)}"
          loading="eager"
          decoding="async"
          fetchpriority="high"
          draggable="false"
        />
      </span>
    `;
  }

  return `<span class="${escapeHtml(classes)}" data-brand-avatar-key="${escapeHtmlAttribute(avatarKey)}">${escapeHtml(siteBrandInitials(resolved.siteName))}</span>`;
}

function systemLogoModeLabel(mode) {
  const normalized = String(mode || 'auto').trim().toLowerCase();
  if (normalized === 'upload') {
    return '本地 Logo';
  }
  if (normalized === 'url') {
    return '图片 Logo';
  }
  return '系统默认 Logo';
}

function systemLogoPathPreview(settings = {}) {
  const resolved = normalizeSystemSettings(settings);
  if (resolved.logoAssetLocalPath) {
    return resolved.logoAssetLocalPath;
  }
  if (resolved.logoUploadFilename) {
    return `已选择：${resolved.logoUploadFilename}（保存后显示系统路径）`;
  }
  return '';
}

function systemLogoPathHint(settings = {}) {
  const resolved = normalizeSystemSettings(settings);
  if (resolved.logoAssetLocalPath) {
    return '这里显示的是系统已经保存好的实际本地路径，后续备份或排查都能直接用。';
  }
  if (resolved.logoUploadFilename) {
    return '新 Logo 已选中，点击“保存站点品牌”后会写入系统目录，并在这里显示最终路径。';
  }
  return '上传并保存后，这里会显示 Logo 在系统中的本地保存路径。';
}

function translationProviderMeta(providerId) {
  return (
    TRANSLATION_PROVIDER_OPTIONS.find((item) => item.id === String(providerId || '').trim()) ||
    TRANSLATION_PROVIDER_OPTIONS.find((item) => item.id === 'mymemory_free') ||
    TRANSLATION_PROVIDER_OPTIONS[0]
  );
}

function translationProviderUsesApiKey(providerId) {
  return ['libretranslate', 'azure_translator', 'openai_compatible'].includes(
    String(providerId || '').trim(),
  );
}

function translationProviderRequiresBaseUrl(providerId) {
  return ['libretranslate', 'azure_translator', 'openai_compatible'].includes(
    String(providerId || '').trim(),
  );
}

function translationProviderRequiresRegion(providerId) {
  return String(providerId || '').trim() === 'azure_translator';
}

function translationApiKeyPlaceholder(providerId, apiKeyConfigured) {
  const normalized = String(providerId || '').trim();
  if (normalized === 'openai_compatible') {
    return apiKeyConfigured
      ? '已保存 API Key，留空则继续沿用当前密钥'
      : '例如 sk-...';
  }
  if (normalized === 'azure_translator') {
    return apiKeyConfigured
      ? '已保存 Azure Translator 密钥，留空则继续沿用当前密钥'
      : '填写 Azure Translator 资源密钥（支持 F0 免费层）';
  }
  if (normalized === 'libretranslate') {
    return apiKeyConfigured
      ? '已保存 API Key，留空则继续沿用当前密钥'
      : '如果你的 LibreTranslate 服务要求鉴权，可在这里填写';
  }
  return '当前引擎无需 API Key，可保持留空';
}

function translationBaseUrlPlaceholder(providerId) {
  const normalized = String(providerId || '').trim();
  if (normalized === 'openai_compatible') {
    return 'https://api.openai.com/v1';
  }
  if (normalized === 'azure_translator') {
    return 'https://api.cognitive.microsofttranslator.com';
  }
  if (normalized === 'libretranslate') {
    return 'https://libretranslate.example.com';
  }
  return '';
}

function translationProviderTips(providerId) {
  const normalized = String(providerId || '').trim();
  if (normalized === 'google_free') {
    return [
      '开箱即用，无需额外配置，更适合海外网络环境下快速查看英文邮件。',
      '属于公共免费接口，偶尔可能出现限流、超时或网络不可达的情况。',
    ];
  }
  if (normalized === 'mymemory_free') {
    return [
      '开箱即用，无需额外配置，长邮件会自动拆分后逐段翻译。',
      '更适合短文本或普通正文；如果你更在意语气和上下文，建议切换到 AI 或微软翻译。',
    ];
  }
  if (normalized === 'libretranslate') {
    return [
      '推荐填写你自己的 LibreTranslate 接口地址，公共实例可用性取决于服务方。',
      '如果服务端要求鉴权，可填写 API Key；不要求时可以留空。',
    ];
  }
  if (normalized === 'azure_translator') {
    return [
      '支持微软 Azure Translator 免费层（F0），适合部署到服务器长期稳定使用。',
      '接口地址默认可留空使用官方全局地址；区域（Region）在多服务资源或区域资源下建议填写。',
    ];
  }
  return [
    '适合复杂邮件、多段上下文和专业术语翻译。',
    '建议同时填写 Base URL、模型名称和 API Key，邮件翻译质量会更稳定。',
  ];
}

function renderSystemThemePresetCards(selectedPresetId) {
  const resolvedPresetId = normalizeSystemThemePresetId(selectedPresetId);

  return SYSTEM_THEME_PRESETS.map(
    (preset) => `
      <label class="system-theme-card">
        <input
            class="system-theme-card-input"
            type="radio"
            name="themePresetId"
            value="${escapeHtml(preset.id)}"
            ${preset.id === resolvedPresetId ? 'checked' : ''}
          />
          <span class="system-theme-card-body">
            <span class="system-theme-card-topline">
              <span class="tag subtle">${escapeHtml(preset.badge)}</span>
              <span>${preset.id === resolvedPresetId ? '当前已启用' : '点击后保存'}</span>
            </span>
            <strong>${escapeHtml(preset.name)}</strong>
            <p>${escapeHtml(preset.description)}</p>
          <span class="system-theme-swatches">
            ${preset.swatches
              .map(
                (swatch) => `
                  <span class="system-theme-swatch" style="--theme-swatch:${escapeHtml(swatch)};"></span>
                `,
              )
              .join('')}
          </span>
        </span>
      </label>
    `,
  ).join('');
}

function renderSystemSettingsLegacy(state) {
  const settings = normalizeSystemSettings(state.systemSettings);
  const activeTheme = systemThemePresetMeta(settings.themePresetId);
  const microsoftCallbackUrl =
    typeof window !== 'undefined'
      ? `${window.location.origin}/api/oauth/microsoft/callback`
      : 'http://localhost:52080/api/oauth/microsoft/callback';
  const microsoftAlternateCallbackUrl = microsoftCallbackUrl.includes('127.0.0.1')
    ? microsoftCallbackUrl.replace('127.0.0.1', 'localhost')
    : microsoftCallbackUrl.includes('localhost')
      ? microsoftCallbackUrl.replace('localhost', '127.0.0.1')
      : '';
  const microsoftConfigured = Boolean(settings.microsoftAppConfigured);
  const microsoftSecretConfigured = Boolean(settings.microsoftClientSecretConfigured);
  const microsoftGuideMarkup = state.systemMicrosoftGuideOpen
    ? renderSystemMicrosoftGuideModal(microsoftCallbackUrl, microsoftAlternateCallbackUrl)
    : '';

  return `
    <section class="view-grid view-grid-system">
      <form data-form="system-settings" class="system-settings-form">
        <article class="panel system-panel">
          <div class="panel-header">
            <div>
              <h3>站点品牌</h3>
              <p>可以设置后台名称、网站 Logo 直链或 SVG。留空时会使用系统内置的默认 Logo。</p>
            </div>
            <span class="tag">${escapeHtml(systemLogoModeLabel(settings.logoMode))}</span>
          </div>
          <div class="system-brand-preview-card">
            ${renderBrandAvatar(settings, 'system-brand-preview-avatar', `${settings.siteName} logo`)}
            <div class="system-brand-preview-copy">
              <strong>${escapeHtml(settings.siteName)}</strong>
              <p>${escapeHtml(systemLogoModeLabel(settings.logoMode))}</p>
            </div>
          </div>
          <div class="stack">
            <label>
              <span>站点名称</span>
              <input name="siteName" value="${escapeHtml(settings.siteName)}" placeholder="例如：Mail Union" required />
            </label>
            <div class="system-choice-grid">
              <label class="system-choice-card">
                <input type="radio" name="logoMode" value="auto" ${settings.logoMode === 'auto' ? 'checked' : ''} />
                <span>
                  <strong>系统默认 Logo</strong>
                  <small>使用系统内置 Mail Union 默认 Logo，最省心。</small>
                </span>
              </label>
              <label class="system-choice-card">
                <input type="radio" name="logoMode" value="url" ${settings.logoMode === 'url' ? 'checked' : ''} />
                <span>
                  <strong>直链图片</strong>
                  <small>支持 png、jpg、webp、svg 等公开可访问直链。</small>
                </span>
              </label>
              <label class="system-choice-card">
                <input type="radio" name="logoMode" value="svg" ${settings.logoMode === 'svg' ? 'checked' : ''} />
                <span>
                  <strong>SVG 代码</strong>
                  <small>适合矢量图标、品牌图形和简洁线稿 Logo。</small>
                </span>
              </label>
            </div>
            <label>
              <span>Logo 直链</span>
              <input name="logoUrl" type="url" value="${escapeHtml(settings.logoUrl || '')}" placeholder="https://example.com/logo.svg" />
            </label>
            <label>
              <span>Logo SVG</span>
              <textarea name="logoSvg" rows="8" spellcheck="false" placeholder="<svg viewBox='0 0 64 64'>...</svg>">${escapeHtml(settings.logoSvg || '')}</textarea>
            </label>
          </div>
          <div class="notice info">当前只会按所选模式启用对应 Logo；如果所选内容留空，会自动回退到系统生成的默认 Logo。</div>
          <div class="form-actions system-panel-actions">
            <button class="button" type="button" data-action="save-brand-system-settings">保存站点品牌</button>
          </div>
        </article>

        <article class="panel system-panel">
          <div class="panel-header">
            <div>
              <h3>Microsoft 应用配置</h3>
              <p>Outlook / Microsoft 365 邮箱统一从这里读取系统级 OAuth2 应用配置。配置好后，普通用户只需要点“连接 Microsoft”。</p>
            </div>
            <div class="tool-panel-actions">
              <button class="button ghost" type="button" data-action="open-system-microsoft-guide">配置教程</button>
              <span class="tag ${microsoftConfigured ? '' : 'subtle'}">${microsoftConfigured ? '已配置' : '未配置'}</span>
            </div>
          </div>
          <div class="system-brand-preview-card">
            ${renderAutoIcon('mailboxes', 'Microsoft App', 'system-brand-preview-avatar')}
            <div class="system-brand-preview-copy">
              <strong>${microsoftConfigured ? '系统级 Microsoft OAuth2 已就绪' : '尚未完成 Microsoft OAuth2 配置'}</strong>
              <p>${escapeHtml(
                microsoftConfigured
                  ? `租户（Tenant）：${settings.microsoftTenantId || 'common'}${microsoftSecretConfigured ? '，客户端密钥（Client Secret）已保存' : '，当前按公共客户端模式（Public Client）工作'}`
                  : '先在这里配置客户端 ID（Client ID）和租户（Tenant），之后 Outlook 邮箱就能统一走系统授权。',
              )}</p>
            </div>
          </div>
          <div class="stack">
            <div class="inline-grid">
              <label>
                <span>客户端 ID（Client ID）</span>
                <input
                  name="microsoftClientId"
                  value="${escapeHtml(settings.microsoftClientId || '')}"
                  placeholder="来自 Microsoft Entra / Azure 应用注册中的应用程序（客户端）ID"
                />
              </label>
              <label>
                <span>目录（租户）ID（Directory (tenant) ID）</span>
                <input
                  name="microsoftTenantId"
                  value="${escapeHtml(settings.microsoftTenantId || 'common')}"
                  placeholder="个人账号常用通用租户（common），企业租户可填真实的目录（租户）ID"
                />
              </label>
            </div>
            <label>
              <span>客户端密钥（Client Secret）</span>
              <input
                name="microsoftClientSecret"
                type="password"
                value=""
                placeholder="${microsoftSecretConfigured ? '已保存，留空则继续沿用当前客户端密钥（Client Secret）' : '如果应用是公共客户端（Public Client），这里可以先留空'}"
              />
            </label>
          </div>
          <div class="notice info">
            回调地址（Redirect URI）：<code>${escapeHtml(microsoftCallbackUrl)}</code><br />
            建议权限（Recommended permissions）：<code>offline_access</code>、<code>Mail.Read</code> / <code>Mail.ReadWrite</code>、<code>IMAP.AccessAsUser.All</code>。保存后，Outlook 邮箱添加页会自动复用这套配置。${microsoftAlternateCallbackUrl ? `<br />如果你会在 <code>127.0.0.1</code> 和 <code>localhost</code> 之间切换，建议把 <code>${escapeHtml(microsoftAlternateCallbackUrl)}</code> 也加入重定向 URI（Redirect URI）。` : ''}
          </div>
        </article>

        <article class="panel">
          <div class="panel-header">
            <div>
              <h3>主题模板</h3>
              <p>这里预置了 6 套不同气质的后台主题，其中“极光雾玻”是带雾化玻璃效果的模板。</p>
            </div>
            <span class="tag">${escapeHtml(activeTheme.name)}</span>
          </div>
          <div class="system-theme-grid">
            ${renderSystemThemePresetCards(activeTheme.id)}
          </div>
          <div class="system-theme-current">
            <strong>当前模板：${escapeHtml(activeTheme.name)}</strong>
            <p>${escapeHtml(activeTheme.description)}</p>
          </div>
        </article>

        <div class="form-actions system-settings-actions">
          <button class="button" type="submit">保存系统设置</button>
        </div>
      </form>
      ${microsoftGuideMarkup}
    </section>
  `;
}

function buildSystemMicrosoftGuideDataV2(callbackUrl, alternateCallbackUrl = '') {
  const callbacks = [callbackUrl];
  if (alternateCallbackUrl) {
    callbacks.push(alternateCallbackUrl);
  }

  return {
    title: 'Microsoft 应用配置教程',
    badge: '按这个填就行',
    intro:
      '下面这套流程适用于本系统的 Microsoft OAuth2 双协议收件方案（Graph API + IMAP）。真正最容易填错的，只有 3 个地方：Tenant 怎么填、Client Secret 要填哪个值、Redirect URI 的平台类型必须选什么。',
    cards: [
      {
        label: '客户端 ID（Client ID）',
        value: '应用注册 -> 概览（Overview）-> 应用程序(客户端) ID（Application (client) ID）',
        note: '系统里“客户端 ID（Client ID）”填这里，不要填对象 ID（Object ID）。',
      },
      {
        label: '目录（租户）ID（Directory (tenant) ID）',
        value: '应用注册 -> 概览（Overview）-> 目录(租户) ID（Directory (tenant) ID）',
        note: '个人 Outlook / Hotmail / Live / MSN 邮箱：系统里优先填 common；企业 Microsoft 365 邮箱：填写真实的 Directory (tenant) ID。',
      },
      {
        label: '客户端密钥（Client Secret）',
        value: '证书和密码（Certificates & secrets）-> 新建客户端密码（New client secret）-> 复制“值（Value）”',
        note: '系统里要填 Value，不是 Secret ID，更不是机密 ID / 对象 ID。',
      },
      {
        label: '支持的账户类型（Supported account types）',
        value: '建议选择“任何组织目录中的帐户和个人 Microsoft 帐户”',
        note: '这样个人 Outlook 和企业 Microsoft 365 都更容易兼容，后面做 OAuth2 登录时更省事。',
      },
      {
        label: '回调地址（Redirect URI）',
        valueLines: callbacks,
        note: 'Authentication 里平台必须选 Web，不要选 SPA。本地开发建议把 localhost 和 127.0.0.1 两条都加上。',
        wide: true,
      },
    ],
    systemFill: [
      '客户端 ID（Client ID）：填 Application (client) ID',
      '目录（租户）ID（Tenant ID）：个人邮箱填 common；企业邮箱填 Directory (tenant) ID',
      '客户端密钥（Client Secret）：填 Value；留空表示继续沿用系统当前已保存的密钥',
      '回调地址（Redirect URI）：微软后台必须至少加入你当前正在访问后台的那一条地址',
      '支持的账户类型（Supported account types）：优先选择“任何组织目录中的帐户和个人 Microsoft 帐户”',
      '权限要求：Graph 的 Mail.ReadWrite + offline_access，以及 Exchange Online 的 IMAP.AccessAsUser.All 都要配齐',
    ],
    permissionGroups: [
      {
        title: 'Microsoft Graph -> Delegated permissions',
        note: '这是 Graph API 侧的 OAuth2 邮件权限，缺了这里会导致 Graph 令牌拿到了也读不了邮件。',
        items: ['openid', 'profile', 'email', 'offline_access', 'Mail.ReadWrite'],
      },
      {
        title: 'Office 365 Exchange Online -> Delegated permissions',
        note: '这是 Outlook IMAP OAuth2 登录权限，缺了这里会导致 IMAP.AccessAsUser.All 不生效。',
        items: ['IMAP.AccessAsUser.All'],
      },
    ],
    steps: [
      '进入 Microsoft Entra 管理中心 -> 应用注册（App registrations），打开你已经创建好的应用。',
      '在“概览（Overview）”页先记下 Application (client) ID；如果是企业邮箱，再把 Directory (tenant) ID 一起记下来。',
      '进入“身份验证（Authentication）”，新增平台时一定选择 Web，并把上面的回调地址逐条加入 Redirect URI；不要选 SPA。',
      '进入 API permissions，先添加 Microsoft Graph -> Delegated permissions，勾选 openid、profile、email、offline_access、Mail.ReadWrite。',
      '继续在 API permissions 里点 Add a permission -> APIs my organization uses，搜索 Office 365 Exchange Online，再进入 Delegated permissions，勾选 IMAP.AccessAsUser.All。',
      '如果是企业租户，能点就点一次 Grant admin consent / 代表默认目录授予管理员同意，避免后面用户单独授权失败。',
      '进入 Certificates & secrets，新建客户端密钥（New client secret）后，立刻复制 Value；离开页面后这个值不会再完整显示。',
      '回到本系统保存 Microsoft 配置，然后重新到邮箱管理里点击“连接 Microsoft”，让新权限重新走一遍 OAuth2 授权。',
      '如果你刚改过权限、租户或回调地址，旧 token 不会自动继承新权限，必须重新点击一次“连接 Microsoft”。',
    ],
    checks: [
      '不要填 Object ID / 对象 ID。',
      '不要填 Secret ID / 机密 ID，Client Secret 要填 Value。',
      '个人 Outlook / Hotmail / Live / MSN 邮箱优先填 common，不要一上来就填企业租户 GUID。',
      '如果你当前后台是用 127.0.0.1 打开的，但微软后台只填了 localhost 回调地址，就一定会回调失败；反过来也一样。',
      'Graph 权限和 Office 365 Exchange Online 的 IMAP 权限要同时配，缺任何一边都可能导致 OAuth2 登录后仍然无法收件。',
      '权限刚改完以后，要重新点一次“连接 Microsoft”，旧 token 不会自动继承新权限。',
      '只做收件的话，不需要 SMTP.Send。',
    ],
    completionSteps: [
      '先在“系统设置 -> Microsoft 应用配置”里保存 Client ID、Tenant ID、Client Secret。',
      '再去“邮箱管理”新增或编辑 Outlook / Microsoft 365 邮箱，把登录方式切到 Microsoft OAuth2。',
      '点击“连接 Microsoft”，按微软页面正常登录对应邮箱账号，并同意邮件读取权限。',
      '授权成功回跳后，系统会自动保存 OAuth2 令牌；这时再点“测试连接”或“立即同步”检查是否能正常收件。',
      '如果你后面又改了微软后台的权限、回调地址或 Tenant，记得重新点一次“连接 Microsoft”。',
    ],
    successChecks: [
      '系统设置里显示 Microsoft 应用配置已保存。',
      '邮箱管理里 Outlook 邮箱能正常完成“连接 Microsoft”。',
      '测试连接成功，不再提示缺少 Mail.ReadWrite 或 IMAP.AccessAsUser.All。',
      '立即同步后，收件箱里能看到 Outlook / Microsoft 365 邮件。',
    ],
    links: [
      {
        label: 'Microsoft Graph 权限参考',
        url: 'https://learn.microsoft.com/en-us/graph/permissions-reference',
      },
      {
        label: 'IMAP / POP / SMTP OAuth 官方说明',
        url: 'https://learn.microsoft.com/en-us/exchange/client-developer/legacy-protocols/how-to-authenticate-an-imap-pop-smtp-application-by-using-oauth',
      },
      {
        label: '应用注册与回调配置',
        url: 'https://learn.microsoft.com/en-us/entra/identity-platform/scenario-web-app-sign-user-app-registration',
      },
      {
        label: 'Grant admin consent 官方说明',
        url: 'https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/grant-admin-consent',
      },
    ],
  };
}

function renderSystemMicrosoftGuideModalV2(callbackUrl, alternateCallbackUrl = '') {
  const guide = buildSystemMicrosoftGuideDataV2(callbackUrl, alternateCallbackUrl);

  return `
    <div class="modal-shell notification-guide-shell">
      <div class="modal-backdrop" data-system-microsoft-guide-overlay></div>
      <section class="modal-panel mailbox-guide-modal notification-guide-modal">
        <div class="mailbox-guide-header">
          <div class="mailbox-guide-title">
            ${renderAutoIcon('system', guide.title, 'provider-icon-guide notification-guide-icon')}
            <div class="mailbox-guide-title-copy">
              <div class="mailbox-guide-title-row">
                <h3>${escapeHtml(guide.title)}</h3>
                <span class="tag subtle">${escapeHtml(guide.badge)}</span>
              </div>
              <p>${escapeHtml(guide.intro)}</p>
            </div>
          </div>
          <button class="modal-close" type="button" data-action="close-system-microsoft-guide" aria-label="关闭说明">×</button>
        </div>
        <div class="mailbox-guide-body">
          <section class="mailbox-guide-section">
            <h4>先准备这几项</h4>
            <div class="mailbox-guide-grid">
              ${guide.cards
                .map(
                  (item) => `
                    <div class="mailbox-guide-card ${item.wide ? 'mailbox-guide-card-wide' : ''}">
                      <span>${escapeHtml(item.label)}</span>
                      ${
                        Array.isArray(item.valueLines) && item.valueLines.length
                          ? `
                              <div class="mailbox-guide-code-list">
                                ${item.valueLines
                                  .map((value) => `<code class="mailbox-guide-code-item">${escapeHtml(value)}</code>`)
                                  .join('')}
                              </div>
                            `
                          : `<strong>${escapeHtml(item.value)}</strong>`
                      }
                      <p class="system-guide-card-note">${escapeHtml(item.note)}</p>
                    </div>
                  `,
                )
                .join('')}
            </div>
          </section>
          <section class="mailbox-guide-section">
            <h4>系统里这样填</h4>
            <ul class="mailbox-guide-list">
              ${guide.systemFill.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}
            </ul>
          </section>
          <section class="mailbox-guide-section">
            <h4>权限勾选清单</h4>
            <div class="mailbox-guide-permission-grid">
              ${guide.permissionGroups
                .map(
                  (group) => `
                    <article class="mailbox-guide-permission-card">
                      <h5>${escapeHtml(group.title)}</h5>
                      <p>${escapeHtml(group.note)}</p>
                      <div class="mailbox-guide-permission-chip-list">
                        ${group.items
                          .map((item) => `<span class="mailbox-guide-permission-chip">${escapeHtml(item)}</span>`)
                          .join('')}
                      </div>
                    </article>
                  `,
                )
                .join('')}
            </div>
          </section>
          <section class="mailbox-guide-section">
            <h4>微软后台按这个顺序操作</h4>
            <ol class="mailbox-guide-list">
              ${guide.steps.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}
            </ol>
          </section>
          <section class="mailbox-guide-section">
            <h4>系统里接下来怎么做</h4>
            <ol class="mailbox-guide-list">
              ${guide.completionSteps.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}
            </ol>
          </section>
          <section class="mailbox-guide-section">
            <h4>最容易出错的地方</h4>
            <ul class="mailbox-guide-list mailbox-guide-list-muted">
              ${guide.checks.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}
            </ul>
          </section>
          <section class="mailbox-guide-section">
            <h4>看到这些就算配置成功</h4>
            <ul class="mailbox-guide-list">
              ${guide.successChecks.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}
            </ul>
          </section>
          <section class="mailbox-guide-section">
            <h4>官方文档</h4>
            <div class="notification-guide-links">
              ${guide.links
                .map(
                  (item) => `
                    <a class="notification-guide-link" href="${escapeHtml(item.url)}" target="_blank" rel="noreferrer">
                      ${escapeHtml(item.label)}
                    </a>
                  `,
                )
                .join('')}
            </div>
          </section>
        </div>
      </section>
    </div>
  `;
}

function buildSystemGoogleGuideData(callbackUrl, alternateCallbackUrl = '') {
  const callbacks = [callbackUrl];
  if (alternateCallbackUrl) {
    callbacks.push(alternateCallbackUrl);
  }

  return {
    title: 'Google 应用配置教程',
    badge: 'Gmail / Google Workspace',
    intro:
      '这套流程同时覆盖 Gmail 的两种接入方式：默认推荐先走 IMAP + 应用专用密码（App Password），如果当前账号拿不到应用专用密码，再切到 Google OAuth2。最容易填错的地方主要有 3 个：应用专用密码和网页登录密码混用、回调地址（Redirect URI）没加对、授权范围（Scope）没有按系统需要放通。',
    cards: [
      {
        label: '客户端 ID（Client ID）',
        value: 'Google Cloud Console -> API 和服务（APIs & Services）-> 凭据（Credentials）-> OAuth 2.0 客户端 ID',
        note: '系统里“客户端 ID（Client ID）”就填这里显示的 Client ID。',
      },
      {
        label: '客户端密钥（Client Secret）',
        value: '同一个 OAuth 2.0 Client 详情页里的 Client Secret',
        note: '系统里“客户端密钥（Client Secret）”填这个值；留空表示继续沿用系统当前已保存的密钥。',
      },
      {
        label: '回调地址（Redirect URI）',
        valueLines: callbacks,
        note: 'OAuth 客户端类型要选 Web application。本地开发建议把 localhost 和 127.0.0.1 两条都加入授权回调。',
        wide: true,
      },
      {
        label: '授权范围（Scope）',
        value: 'openid / email / profile / https://mail.google.com/',
        note: '本系统 Gmail 收件会使用 https://mail.google.com/ 范围来换取 IMAP OAuth2 令牌。',
      },
    ],
    imapCards: [
      {
        label: 'IMAP 主机 / 端口',
        value: 'imap.gmail.com / 993 / SSL/TLS',
        note: '邮箱管理里如果选择密码模式，主机填 imap.gmail.com，端口填 993，并开启 TLS / SSL。',
      },
      {
        label: '应用专用密码入口',
        value: 'https://myaccount.google.com/apppasswords',
        note: '这是 Google 账号里生成应用专用密码（App Password）的直接地址；前提是账号已经开启两步验证。',
        wide: true,
      },
      {
        label: 'Google 安全页',
        value: 'https://myaccount.google.com/security',
        note: '如果你还没开两步验证，先到这个页面开启 2-Step Verification，再回来生成应用专用密码。',
        wide: true,
      },
      {
        label: 'IMAP 状态',
        value: '个人 Gmail 从 2025 年 1 月起默认始终开启',
        note: 'Google 官方已经把个人 Gmail 的 IMAP 改成默认开启；Workspace / 受管账号仍建议优先走 OAuth，并受管理员策略影响。',
        wide: true,
      },
    ],
    steps: [
        '如果你确定要走 Google OAuth2，再进入 Google Cloud Console，先新建项目或选择一个现有项目。',
      '进入“API 和服务（APIs & Services）-> OAuth 同意屏幕（OAuth consent screen）”，把应用名称、支持邮箱、开发者邮箱等必填项先保存。',
      '如果你的 Google Cloud 新版界面要求配置 Audience / 受众，个人测试环境通常可选 External，并把自己加入测试用户（Test users）。',
      '进入“凭据（Credentials）”，新建 OAuth client ID，应用类型选择 Web application。',
      '把本系统展示的回调地址逐条填到 Authorized redirect URIs。你现在是用哪个域名打开后台，就至少把那一条加进去。',
      '创建完成后，复制 Client ID 和 Client Secret，回到本系统“系统设置 -> Google 应用配置”保存。',
      '保存后去“邮箱管理”新增或编辑 Gmail 邮箱，把登录方式切到 Google OAuth2，再点击“连接 Google”完成授权。',
      '如果你刚改了回调地址、同意屏幕或测试用户列表，需要重新点一次“连接 Google”，旧 token 不会自动继承新配置。',
    ],
    imapSteps: [
      '打开 https://myaccount.google.com/security，确认当前 Gmail 账号已经开启“两步验证（2-Step Verification）”。',
      '开启两步验证后，进入 https://myaccount.google.com/apppasswords 。',
      '在“应用专用密码（App passwords）”页面里创建一个新密码；应用名称可自定义填写为 Mail Union 或 Gmail IMAP。',
      'Google 会生成一组 16 位应用专用密码。这个密码只显示一次，先复制好，后续丢失就需要重新生成。',
      '回到本系统“邮箱管理”，新增或编辑 Gmail 邮箱，把登录方式切到 IMAP / 密码模式。',
      '用户名填写完整 Gmail 地址，密码填写刚生成的应用专用密码，主机填 imap.gmail.com，端口填 993，并开启 TLS / SSL。',
      '保存后先点“测试连接”，通过后再保存接入。',
    ],
    checks: [
      'OAuth 客户端类型必须选 Web application，不要选桌面应用（Desktop app）。',
      '回调地址必须和你实际访问后台时的域名完全一致，localhost 和 127.0.0.1 不能混用。',
      '测试阶段如果应用还没发布（Publishing status 不是 In production），记得把将要登录的 Gmail 账号加入测试用户（Test users）。',
      'Google OAuth2 收件依赖 https://mail.google.com/ 范围；只给 openid / email / profile 还不够。',
      '保存系统配置后，再去邮箱管理里重新点一次“连接 Google”，授权成功后系统才会回填刷新令牌（refresh token）。',
    ],
    imapChecks: [
      'Gmail 普通网页登录密码通常不能直接用于 IMAP，密码模式要填应用专用密码（App Password）。',
      '如果账号没开两步验证，你在 Google 账号里通常看不到 App passwords 入口。',
      '部分 Google Workspace / 学校 / 公司账号可能被管理员禁用了应用专用密码；这类账号优先走 OAuth2，不建议走 IMAP 密码模式。',
      '如果你开启了 Advanced Protection（高级保护）或组织策略限制，App Password 入口也可能不可用。',
      '应用专用密码只显示一次；如果找不到旧密码，直接删除旧项并重新生成一组新的即可。',
    ],
    links: [
      {
        label: 'Google OAuth 2.0 Web 应用文档',
        url: 'https://developers.google.com/identity/protocols/oauth2/web-server',
      },
      {
        label: 'Google Cloud OAuth 同意屏幕说明',
        url: 'https://support.google.com/cloud/answer/10311615',
      },
      {
        label: 'Google 应用专用密码官方帮助',
        url: 'https://support.google.com/accounts/answer/185833',
      },
      {
        label: 'Google 账号安全页',
        url: 'https://myaccount.google.com/security',
      },
      {
        label: 'Google 应用专用密码直达地址',
        url: 'https://myaccount.google.com/apppasswords',
      },
      {
        label: 'Gmail IMAP 官方说明',
        url: 'https://support.google.com/mail/answer/7126229',
      },
    ],
  };
}

function renderSystemGoogleGuideModal(callbackUrl, alternateCallbackUrl = '') {
  const guide = buildSystemGoogleGuideData(callbackUrl, alternateCallbackUrl);

  return `
    <div class="modal-shell notification-guide-shell">
      <div class="modal-backdrop" data-system-google-guide-overlay></div>
      <section class="modal-panel mailbox-guide-modal notification-guide-modal">
        <div class="mailbox-guide-header">
          <div class="mailbox-guide-title">
            ${renderAutoIcon('google', guide.title, 'provider-icon-guide notification-guide-icon')}
            <div class="mailbox-guide-title-copy">
              <div class="mailbox-guide-title-row">
                <h3>${escapeHtml(guide.title)}</h3>
                <span class="tag subtle">${escapeHtml(guide.badge)}</span>
              </div>
              <p>${escapeHtml(guide.intro)}</p>
            </div>
          </div>
          <button class="modal-close" type="button" data-action="close-system-google-guide" aria-label="关闭说明">×</button>
        </div>
        <div class="mailbox-guide-body">
          <section class="mailbox-guide-section">
            <h4>先准备这几项</h4>
            <div class="mailbox-guide-grid">
              ${guide.cards
                .map(
                  (item) => `
                    <div class="mailbox-guide-card ${item.wide ? 'mailbox-guide-card-wide' : ''}">
                      <span>${escapeHtml(item.label)}</span>
                      ${
                        Array.isArray(item.valueLines) && item.valueLines.length
                          ? `
                              <div class="mailbox-guide-code-list">
                                ${item.valueLines
                                  .map((value) => `<code class="mailbox-guide-code-item">${escapeHtml(value)}</code>`)
                                  .join('')}
                              </div>
                            `
                          : `<strong>${escapeHtml(item.value)}</strong>`
                      }
                      <p class="system-guide-card-note">${escapeHtml(item.note)}</p>
                    </div>
                  `,
                )
                .join('')}
            </div>
          </section>
          <section class="mailbox-guide-section">
            <h4>Google Cloud 按这个顺序操作</h4>
            <ol class="mailbox-guide-list">
              ${guide.steps.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}
            </ol>
          </section>
          <section class="mailbox-guide-section">
            <h4>如果改走 IMAP / 应用专用密码</h4>
            <div class="mailbox-guide-grid">
              ${guide.imapCards
                .map(
                  (item) => `
                    <div class="mailbox-guide-card ${item.wide ? 'mailbox-guide-card-wide' : ''}">
                      <span>${escapeHtml(item.label)}</span>
                      <strong>${escapeHtml(item.value)}</strong>
                      <p class="system-guide-card-note">${escapeHtml(item.note)}</p>
                    </div>
                  `,
                )
                .join('')}
            </div>
            <ol class="mailbox-guide-list">
              ${guide.imapSteps.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}
            </ol>
          </section>
          <section class="mailbox-guide-section">
            <h4>最容易出错的地方</h4>
            <ul class="mailbox-guide-list mailbox-guide-list-muted">
              ${guide.checks.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}
            </ul>
            <div class="notice info">IMAP 密码模式更适合作为个人 Gmail 的备用接入方案；如果你是 Google Workspace / 企业账号，优先还是走 OAuth2。</div>
            <ul class="mailbox-guide-list mailbox-guide-list-muted">
              ${guide.imapChecks.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}
            </ul>
          </section>
          <section class="mailbox-guide-section">
            <h4>官方文档</h4>
            <div class="notification-guide-links">
              ${guide.links
                .map(
                  (item) => `
                    <a class="notification-guide-link" href="${escapeHtml(item.url)}" target="_blank" rel="noreferrer">
                      ${escapeHtml(item.label)}
                    </a>
                  `,
                )
                .join('')}
            </div>
          </section>
        </div>
      </section>
    </div>
  `;
}

function renderSystemGoogleConfigPanel(state, settings, callbackUrl, alternateCallbackUrl) {
  const googleConfigured = Boolean(settings.googleAppConfigured);
  const googleSecretConfigured = Boolean(settings.googleClientSecretConfigured);
  const googleSecretVisible = Boolean(state.systemGoogleSecretVisible);
  const googleSecretLoading = Boolean(state.systemGoogleSecretLoading);
  const googleSecretButtonLabel = googleSecretLoading ? '加载中' : googleSecretVisible ? '隐藏' : '显示';
  const appOrigin = typeof window !== 'undefined' ? window.location.origin : 'http://localhost:52080';
  const googlePrivacyUrl = `${appOrigin}/legal/privacy`;
  const googleTermsUrl = `${appOrigin}/legal/terms`;

  return `
    <article class="panel system-panel" data-icon="google">
      <div class="panel-header">
        <div>
          <h3>Google 应用配置</h3>
          <p>Gmail / Google Workspace 邮箱统一从这里读取系统级 Google OAuth2 配置。管理员配置一次，后续新增 Gmail 时就能直接复用。</p>
        </div>
        <div class="tool-panel-actions">
          <button class="button ghost" type="button" data-action="open-system-google-guide">配置教程</button>
          <span class="tag ${googleConfigured ? '' : 'subtle'}">${googleConfigured ? '已配置' : '未配置'}</span>
        </div>
      </div>
      <div class="system-brand-preview-card">
        ${renderAutoIcon('google', 'Google App', 'system-brand-preview-avatar')}
        <div class="system-brand-preview-copy">
          <strong>${googleConfigured ? '系统级 Google OAuth2 已就绪' : '尚未完成 Google OAuth2 配置'}</strong>
          <p>${escapeHtml(
            googleConfigured
              ? `${googleSecretConfigured ? '客户端密钥（Client Secret）已保存' : '当前未保存客户端密钥（Client Secret）'}，Gmail 邮箱可直接在邮箱管理里点击“连接 Google”。`
              : '先在这里保存 Google Client ID 和 Client Secret，之后 Gmail 邮箱就能统一走系统授权。',
          )}</p>
        </div>
      </div>
      <div class="stack">
        <div class="inline-grid">
          <label>
            <span>客户端 ID（Client ID）</span>
            <input
              name="googleClientId"
              value="${escapeHtml(settings.googleClientId || '')}"
              placeholder="来自 Google Cloud OAuth Client 的 Client ID"
              spellcheck="false"
              autocomplete="off"
            />
            <small>支持直接粘贴整行“客户端 ID ...”，系统会自动提取真实的 Client ID。</small>
          </label>
          <label>
            <span>客户端密钥（Client Secret）</span>
            <div class="password-field">
              <input
                name="googleClientSecret"
                type="${googleSecretVisible ? 'text' : 'password'}"
                value="${escapeHtml(settings.googleClientSecret || '')}"
                placeholder="${googleSecretConfigured ? '已保存，留空则继续沿用当前客户端密钥（Client Secret）' : '首次接入时需要填写'}"
                spellcheck="false"
                autocomplete="off"
              />
              <button
                class="password-toggle-button ${googleSecretVisible ? 'is-active' : ''}"
                type="button"
                data-action="toggle-system-google-secret-visibility"
              >
                ${escapeHtml(googleSecretButtonLabel)}
              </button>
            </div>
          </label>
        </div>
        <div class="tool-summary">
          <div class="tool-stat">
            <span>回调地址（Redirect URI）</span>
            <strong>${escapeHtml(callbackUrl)}</strong>
          </div>
          ${
            alternateCallbackUrl
              ? `
                  <div class="tool-stat">
                    <span>备用回调地址</span>
                    <strong>${escapeHtml(alternateCallbackUrl)}</strong>
                  </div>
                `
              : ''
          }
          <div class="tool-stat">
            <span>授权范围（Scope）</span>
            <strong>openid / email / profile / https://mail.google.com/</strong>
          </div>
          <div class="tool-stat">
            <span>隐私政策链接</span>
            <strong><a href="${escapeHtml(googlePrivacyUrl)}" target="_blank" rel="noreferrer">${escapeHtml(googlePrivacyUrl)}</a></strong>
          </div>
          <div class="tool-stat">
            <span>服务条款链接</span>
            <strong><a href="${escapeHtml(googleTermsUrl)}" target="_blank" rel="noreferrer">${escapeHtml(googleTermsUrl)}</a></strong>
          </div>
        </div>
        <div class="notice info">
          保存好 Google 应用配置后，到“邮箱管理”新增或编辑 Gmail 邮箱，登录方式切到 <code>Google OAuth2</code>，然后点击“连接 Google”完成授权即可。Google 后台的应用首页可填当前站点主页，隐私政策和服务条款可直接使用上面这两个公开链接；正式对外时建议换成你的公网 HTTPS 域名。
        </div>
        <div class="form-actions system-panel-actions">
          <button class="button" type="button" data-action="save-google-system-settings">保存 Google 应用</button>
        </div>
      </div>
    </article>
  `;
}

function renderSystemMicrosoftConfigPanel(state, settings, callbackUrl, alternateCallbackUrl) {
  const microsoftConfigured = Boolean(settings.microsoftAppConfigured);
  const microsoftSecretConfigured = Boolean(settings.microsoftClientSecretConfigured);
  const microsoftSecretVisible = Boolean(state.systemMicrosoftSecretVisible);
  const microsoftSecretLoading = Boolean(state.systemMicrosoftSecretLoading);
  const microsoftSecretValue = String(settings.microsoftClientSecret || '');
  const microsoftSecretPlaceholder = microsoftSecretConfigured
    ? '已保存，留空则继续沿用当前客户端密钥（Client Secret）'
    : '如果你的应用使用公共客户端模式（Public Client），这里可以先留空';
  const microsoftSecretButtonLabel = microsoftSecretLoading
    ? '加载中'
    : microsoftSecretVisible
      ? '隐藏'
      : '显示';

  return `
    <article class="panel system-panel" data-icon="mailboxes">
      <div class="panel-header">
        <div>
          <h3>Microsoft 应用配置</h3>
          <p>Outlook / Microsoft 365 邮箱统一从这里读取系统级 OAuth2 应用配置。普通用户后续只需要点击“连接 Microsoft”。</p>
        </div>
        <div class="tool-panel-actions">
          <button class="button ghost" type="button" data-action="open-system-microsoft-guide">配置教程</button>
          <span class="tag ${microsoftConfigured ? '' : 'subtle'}">${microsoftConfigured ? '已配置' : '未配置'}</span>
        </div>
      </div>
      <div class="system-brand-preview-card">
        ${renderAutoIcon('mailboxes', 'Microsoft App', 'system-brand-preview-avatar')}
        <div class="system-brand-preview-copy">
          <strong>${microsoftConfigured ? '系统级 Microsoft OAuth2 已就绪' : '尚未完成 Microsoft OAuth2 配置'}</strong>
          <p>${escapeHtml(
            microsoftConfigured
              ? `租户（Tenant）：${settings.microsoftTenantId || 'common'}，${microsoftSecretConfigured ? '客户端密钥（Client Secret）已保存' : '当前未保存客户端密钥（Client Secret）'}`
              : '先在这里保存 Client ID、Tenant ID 和 Client Secret，之后 Outlook 邮箱就能直接复用这套系统配置。',
          )}</p>
        </div>
      </div>
      <div class="stack">
        <div class="inline-grid">
          <label>
            <span>客户端 ID（Client ID）</span>
            <input
              name="microsoftClientId"
              value="${escapeHtml(settings.microsoftClientId || '')}"
              placeholder="来自概览页的 Application (client) ID"
              spellcheck="false"
              autocomplete="off"
            />
          </label>
          <label>
            <span>目录（租户）ID（Directory (tenant) ID）</span>
            <input
              name="microsoftTenantId"
              value="${escapeHtml(settings.microsoftTenantId || 'common')}"
              placeholder="个人邮箱建议填 common，企业邮箱填真实租户 ID"
              spellcheck="false"
              autocomplete="off"
            />
          </label>
        </div>
        <label class="notification-config-field">
          <span>客户端密钥（Client Secret）</span>
          <div class="password-field">
            <input
              name="microsoftClientSecret"
              type="${microsoftSecretVisible ? 'text' : 'password'}"
              value="${escapeHtml(microsoftSecretValue)}"
              placeholder="${escapeHtml(microsoftSecretPlaceholder)}"
              spellcheck="false"
              autocomplete="off"
            />
            <button
              class="password-toggle-button ${microsoftSecretVisible ? 'is-active' : ''}"
              type="button"
              data-action="toggle-system-microsoft-secret-visibility"
              ${microsoftSecretLoading ? 'disabled' : ''}
            >
              ${escapeHtml(microsoftSecretButtonLabel)}
            </button>
          </div>
        </label>
        <div class="system-microsoft-actions">
          <button class="button" type="button" data-action="save-microsoft-system-settings">保存 Microsoft 配置</button>
        </div>
      </div>
      <div class="notice info system-microsoft-note">
        回调地址（Redirect URI）：<code>${escapeHtml(callbackUrl)}</code>${alternateCallbackUrl ? `<br />备用回调：<code>${escapeHtml(alternateCallbackUrl)}</code>` : ''}<br />
        推荐权限（Delegated permissions）：<code>openid</code>、<code>profile</code>、<code>email</code>、<code>offline_access</code>、<code>Mail.ReadWrite</code>、<code>IMAP.AccessAsUser.All</code>。<br />
        提醒：个人 Outlook 邮箱优先填 <code>common</code>，企业 Microsoft 365 邮箱再填真实的 <code>Directory (tenant) ID</code>。
      </div>
    </article>
  `;
}

function renderSystemSettingSwitchRow(name, title, descriptionHtml, checked = false) {
  return `
    <label class="settings-switch-row">
      <span class="settings-switch-copy">
        <strong>${escapeHtml(title)}</strong>
        <small>${descriptionHtml}</small>
      </span>
      <span class="settings-switch-control">
        <input name="${escapeHtml(name)}" type="checkbox" ${checked ? 'checked' : ''} />
        <span class="settings-switch-slider" aria-hidden="true"></span>
      </span>
    </label>
  `;
}

function renderRegistrationWhitelistChip(domain) {
  const normalized = String(domain || '').trim();
  const label = normalized.startsWith('@') ? normalized : `@${normalized}`;

  return `
    <button
      class="settings-tag-chip"
      type="button"
      data-action="remove-registration-domain"
      data-domain="${escapeHtml(normalized)}"
      title="移除 ${escapeHtml(label)}"
    >
      <span>${escapeHtml(label)}</span>
      <span class="settings-tag-chip-remove" aria-hidden="true">&times;</span>
    </button>
  `;
}

function renderSystemAuthConfigPanel(state, settings) {
  const registrationEnabled = Boolean(settings.registrationEnabled);
  const verificationRequired = Boolean(settings.registrationEmailVerificationRequired);
  const passwordResetEnabled = Boolean(settings.passwordResetEnabled);
  const domainWhitelist = Array.isArray(settings.registrationEmailDomainWhitelist)
    ? settings.registrationEmailDomainWhitelist.filter(Boolean)
    : [];
  const whitelistDraftInput = String(state.systemRegistrationWhitelistInput || '').trim();

  return `
    <article class="panel system-panel system-settings-card" data-icon="users">
      <div class="panel-header system-section-header">
        <div>
          <h3>通用认证设置</h3>
          <p>控制用户注册、邮箱验证和找回密码入口</p>
        </div>
      </div>
      <div class="settings-switch-list">
        ${renderSystemSettingSwitchRow(
          'registrationEnabled',
          '开放注册',
          '允许新用户注册',
          registrationEnabled,
        )}
        ${renderSystemSettingSwitchRow(
          'registrationEmailVerificationRequired',
          '邮箱验证',
          '新用户注册时需要验证邮箱',
          verificationRequired,
        )}
        ${renderSystemSettingSwitchRow(
          'passwordResetEnabled',
          '找回密码',
          '在 <code>/user</code> 页面开放邮箱找回密码入口',
          passwordResetEnabled,
        )}
      </div>
      <div class="settings-form-block">
        <div class="settings-field-copy">
          <strong>邮箱域名白名单</strong>
          <p>仅允许使用指定域名的邮箱注册账号（例如 @qq.com、@gmail.com）</p>
        </div>
        <input
          name="registrationEmailDomainWhitelist"
          type="hidden"
          value="${escapeHtml(domainWhitelist.join('\n'))}"
        />
        <div class="settings-tag-editor">
          ${
            domainWhitelist.length
              ? domainWhitelist.map((domain) => renderRegistrationWhitelistChip(domain)).join('')
              : ''
          }
          <input
            type="text"
            data-action="registration-whitelist-input"
            value="${escapeHtml(whitelistDraftInput)}"
            placeholder="@ example.com"
            spellcheck="false"
            autocomplete="off"
          />
        </div>
        <small class="settings-field-footnote">留空则不限制，输入后按 Enter、Tab、逗号或失焦即可加入名单。</small>
      </div>
      <div class="notice info">
        ${
          verificationRequired
            ? '如果你开启了邮箱验证，请同时把下面的 SMTP 发信配置保存好，否则用户无法收到验证码。'
            : '如果你只想由管理员统一创建账号，可以关闭开放注册；普通用户仍然可以用管理员分配好的账号登录。'
        }
      </div>
      <div class="form-actions system-panel-actions">
        <button class="button" type="button" data-action="save-auth-system-settings">保存注册设置</button>
      </div>
    </article>
  `;
}

function renderSystemSessionTimeoutPanel(settings) {
  const sessionTimeoutValue = Math.max(Math.round(Number(settings.sessionTimeoutValue || 7) || 7), 1);
  const sessionTimeoutUnit = SESSION_TIMEOUT_UNIT_OPTIONS.some(
    (item) => item.id === String(settings.sessionTimeoutUnit || '').trim(),
  )
    ? String(settings.sessionTimeoutUnit || '').trim()
    : 'day';

  return `
    <article class="panel system-panel system-settings-card" data-icon="system">
      <div class="panel-header system-section-header">
        <div>
          <h3>后台登录时长</h3>
          <p>设置后台登录保持多久后自动掉线</p>
        </div>
      </div>
      <div class="settings-form-block">
        <div class="settings-field-copy">
          <strong>登录会话有效期</strong>
          <p>新的后台登录会话会按这里的时长自动过期，支持分钟、小时、天、月、年。</p>
        </div>
        <div class="system-session-timeout-row">
          <label>
            <span>时长数值</span>
            <input
              name="sessionTimeoutValue"
              type="number"
              min="1"
              step="1"
              value="${escapeHtml(String(sessionTimeoutValue))}"
              placeholder="例如：7"
            />
          </label>
          <label>
            <span>时长单位</span>
            <select name="sessionTimeoutUnit">
              ${SESSION_TIMEOUT_UNIT_OPTIONS.map(
                (option) => `
                  <option value="${escapeHtml(option.id)}" ${option.id === sessionTimeoutUnit ? 'selected' : ''}>
                    ${escapeHtml(option.label)}
                  </option>
                `,
              ).join('')}
            </select>
          </label>
        </div>
        <small class="settings-field-footnote">已登录中的旧会话不会立即变更；重新登录后的新会话会按新配置生效。</small>
      </div>
      <div class="notice info">推荐把后台登录时长设为你日常管理习惯对应的范围，例如 30 分钟、12 小时或 7 天。</div>
      <div class="form-actions system-panel-actions">
        <button class="button" type="button" data-action="save-auth-system-settings">保存登录时长</button>
      </div>
    </article>
  `;
}

function renderSystemSmtpConfigPanel(state, settings) {
  const smtpConfigured = Boolean(settings.smtpHost && settings.smtpFromEmail);
  const smtpPasswordConfigured = Boolean(settings.smtpPasswordConfigured);
  const smtpPasswordVisible = Boolean(state.systemSmtpPasswordVisible);
  const smtpPasswordLoading = Boolean(state.systemSmtpPasswordLoading);
  const smtpConnectionLoading = Boolean(state.systemSmtpConnectionLoading);
  const smtpConnectionResult = state.systemSmtpConnectionResult || null;
  const smtpTestLoading = Boolean(state.systemSmtpTestLoading);
  const smtpTestResult = state.systemSmtpTestResult || null;
  const smtpPasswordButtonLabel = smtpPasswordLoading
    ? '加载中'
    : smtpPasswordVisible
      ? '隐藏'
      : '显示';
  const smtpTestEmail = String(state.systemSmtpTestEmail || '').trim();

  return `
    <div class="system-smtp-stack">
      <article class="panel system-panel system-settings-card" data-icon="mail">
        <div class="panel-header system-section-header">
          <div>
            <h3>SMTP 设置</h3>
            <p>配置用于发送验证码的邮件服务</p>
          </div>
          <div class="tool-panel-actions">
            <button class="button ghost" type="button" data-action="test-smtp-connection">
              ${escapeHtml(smtpConnectionLoading ? '测试中...' : '测试连接')}
            </button>
          </div>
        </div>
        <div class="settings-form-grid">
          <label>
            <span>SMTP 主机</span>
            <input
              name="smtpHost"
              value="${escapeHtml(settings.smtpHost || '')}"
              placeholder="smtp.163.com"
              spellcheck="false"
              autocomplete="off"
            />
          </label>
          <label>
            <span>SMTP 端口</span>
            <input
              name="smtpPort"
              type="number"
              min="1"
              max="65535"
              value="${escapeHtml(String(settings.smtpPort || 587))}"
              placeholder="587"
              autocomplete="off"
            />
          </label>
          <label>
            <span>SMTP 用户名</span>
            <input
              name="smtpUsername"
              value="${escapeHtml(settings.smtpUsername || '')}"
              placeholder="applecode_admin@163.com"
              spellcheck="false"
              autocomplete="off"
            />
          </label>
          <label>
            <span>SMTP 密码</span>
            <div class="password-field">
              <input
                name="smtpPassword"
                type="${smtpPasswordVisible ? 'text' : 'password'}"
                value="${escapeHtml(settings.smtpPassword || '')}"
                placeholder="${smtpPasswordConfigured ? '已保存，留空以保留当前值。' : '请输入 SMTP 密码或授权码'}"
                spellcheck="false"
                autocomplete="off"
              />
              <button
                class="password-toggle-button ${smtpPasswordVisible ? 'is-active' : ''}"
                type="button"
                data-action="toggle-system-smtp-password-visibility"
                ${smtpPasswordLoading ? 'disabled' : ''}
              >
                ${escapeHtml(smtpPasswordButtonLabel)}
              </button>
            </div>
            <small>${smtpPasswordConfigured ? '密码已配置，留空以保留当前值。' : '建议填写邮箱服务商提供的授权码。'}</small>
          </label>
          <label>
            <span>发件人邮箱</span>
            <input
              name="smtpFromEmail"
              type="email"
              value="${escapeHtml(settings.smtpFromEmail || '')}"
              placeholder="applecode_admin@163.com"
              spellcheck="false"
              autocomplete="off"
            />
          </label>
          <label>
            <span>发件人名称</span>
            <input
              name="smtpFromName"
              value="${escapeHtml(settings.smtpFromName || 'Mail Union')}"
              placeholder="AppleCode"
              autocomplete="off"
            />
          </label>
        </div>
        <div class="settings-inline-actions">
          <span class="settings-inline-hint">${escapeHtml(
            smtpConfigured ? '当前已具备基础发信配置。' : '先把主机、账号和发件人信息填完整。',
          )}</span>
        </div>
        <div class="settings-card-divider"></div>
        <div class="settings-switch-list settings-switch-list-single">
          ${renderSystemSettingSwitchRow(
            'smtpSecure',
            '使用 TLS',
            '为 SMTP 连接启用 TLS 加密',
            Boolean(settings.smtpSecure),
          )}
        </div>
        ${
          smtpConnectionResult
            ? `<div class="notice ${escapeHtml(smtpConnectionResult.tone === 'error' ? 'error' : 'success')} system-smtp-test-result">${escapeHtml(smtpConnectionResult.text || '')}</div>`
            : ''
        }
        <div class="notice info">
          常见建议：QQ、163 和网易企业邮箱通常要填写客户端授权码，不建议直接使用网页登录密码；如果服务商要求 465 端口，请同时开启 TLS / SSL。
        </div>
        <div class="form-actions system-panel-actions">
          <button class="button" type="button" data-action="save-smtp-system-settings">保存 SMTP 配置</button>
        </div>
      </article>

      <article class="panel system-panel system-settings-card" data-icon="mail">
        <div class="panel-header system-section-header">
          <div>
            <h3>发送测试邮件</h3>
            <p>发送测试邮件以验证 SMTP 配置</p>
          </div>
          <span class="tag ${smtpConfigured ? '' : 'subtle'}">${smtpConfigured ? '可测试' : '待配置'}</span>
        </div>
        <div class="settings-test-mail-row">
          <label class="settings-test-mail-field">
            <span>收件人邮箱</span>
            <input
              name="smtpTestEmail"
              type="email"
              value="${escapeHtml(smtpTestEmail)}"
              placeholder="test@example.com"
              spellcheck="false"
              autocomplete="off"
            />
          </label>
          <button class="button ghost settings-test-mail-button" type="button" data-action="send-smtp-test-email">
            ${escapeHtml(smtpTestLoading ? '发送中...' : '发送测试邮件')}
          </button>
        </div>
        ${
          smtpTestResult
            ? `<div class="notice ${escapeHtml(smtpTestResult.tone === 'error' ? 'error' : 'success')} system-smtp-test-result">${escapeHtml(smtpTestResult.text || '')}</div>`
            : ''
        }
      </article>
    </div>
  `;
}

function renderSystemProxyConfigPanel(state, settings) {
  const proxyMode = systemProxyModeMeta(settings.outboundProxyMode);
  const proxyTestLoading = Boolean(state.systemProxyTestLoading);
  const proxyTest = state.systemProxyTestResult || null;
  const bypassPreview = String(settings.outboundProxyBypass || '')
    .split(/\r?\n+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 4);

  return `
    <article class="panel system-panel" data-icon="notifications">
      <div class="panel-header">
        <div>
          <h3>外网代理</h3>
          <p>Google、Microsoft、Telegram、飞书、翻译接口、远程存储等需要访问外网的请求，统一从这里走代理。</p>
        </div>
        <div class="tool-panel-actions">
          <span class="tag">${escapeHtml(proxyMode.badge)}</span>
          <span class="tag subtle">${escapeHtml(proxyMode.label)}</span>
        </div>
      </div>
      <div class="system-brand-preview-card">
        ${renderAutoIcon('notifications', 'Outbound Proxy', 'system-brand-preview-avatar')}
        <div class="system-brand-preview-copy">
          <strong>${escapeHtml(proxyMode.label)}</strong>
          <p>${escapeHtml(proxyMode.description)}</p>
        </div>
      </div>
      <div class="stack">
        <div class="system-proxy-config-block">
          <div class="system-proxy-config-head">
            <span class="system-proxy-config-title">代理地址（Proxy URL）</span>
            <label class="system-proxy-mode-inline">
              <span>代理模式</span>
              <select name="outboundProxyMode">
                ${SYSTEM_PROXY_MODE_OPTIONS.map(
                  (item) => `
                    <option value="${escapeHtml(item.id)}" ${item.id === proxyMode.id ? 'selected' : ''}>
                      ${escapeHtml(item.label)}
                    </option>
                  `,
                ).join('')}
              </select>
            </label>
          </div>
          ${
            proxyMode.id === 'custom'
              ? `
                  <input
                    name="outboundProxyUrl"
                    value="${escapeHtml(settings.outboundProxyUrl || '')}"
                    placeholder="例如：http://127.0.0.1:7890"
                    spellcheck="false"
                    autocomplete="off"
                  />
                `
              : `
                  <div class="tool-stat system-inline-stat system-proxy-route-stat">
                    <span>当前路由</span>
                    <strong>${escapeHtml(proxyMode.id === 'direct' ? '所有外网请求直接访问' : '按系统代理或环境变量自动决定')}</strong>
                  </div>
                  <input type="hidden" name="outboundProxyUrl" value="${escapeHtml(settings.outboundProxyUrl || '')}" />
                `
          }
        </div>
        <label>
          <span>绕过域名（Bypass Domains）</span>
          <textarea
            name="outboundProxyBypass"
            rows="3"
            placeholder="一行一个，或用逗号分隔，例如：localhost,127.0.0.1,.corp.local"
          >${escapeHtml(settings.outboundProxyBypass || '')}</textarea>
          <small>支持域名后缀匹配；例如 <code>.corp.local</code> 会绕过整个内部域名。</small>
        </label>
        <div class="notice info">
          推荐填写常见 HTTP 代理地址，例如 Clash / V2RayN 的 <code>http://127.0.0.1:7890</code>。保存后，Gmail OAuth、Microsoft OAuth、Graph 同步、Telegram、飞书、翻译接口等会优先复用这套配置。
        </div>
        ${
          bypassPreview.length
            ? `
                <div class="tool-summary">
                  <div class="tool-stat">
                    <span>绕过规则</span>
                    <strong>${escapeHtml(String(bypassPreview.length))} 条预览</strong>
                  </div>
                  <div class="tool-stat">
                    <span>示例</span>
                    <strong>${escapeHtml(bypassPreview.join(' / '))}</strong>
                  </div>
                </div>
              `
            : ''
        }
        <div class="form-actions system-panel-actions">
          <button class="button ghost" type="button" data-action="test-proxy-system-settings">
            ${proxyTestLoading ? '测试中...' : '测试外网连通'}
          </button>
          <button class="button" type="button" data-action="save-proxy-system-settings">保存代理配置</button>
        </div>
        ${
          proxyTest
            ? `
                <div class="notice ${proxyTest.tone === 'error' ? 'error' : 'success'}">
                  ${escapeHtml(proxyTest.text || '')}
                </div>
                <div class="mini-list">
                  ${(proxyTest.targets || [])
                    .map(
                      (item) => `
                        <article class="mini-item static system-proxy-test-item">
                          <div class="panel-header">
                            <div>
                              <strong>${escapeHtml(item.label || item.id || '外网测试')}</strong>
                              <p>${escapeHtml(item.url || '')}</p>
                            </div>
                            <div class="tool-panel-actions">
                              <span class="tag ${item.reachable ? '' : 'subtle'}">${escapeHtml(item.reachable ? '可达' : '失败')}</span>
                              ${item.status ? `<span class="tag subtle">HTTP ${escapeHtml(String(item.status))}</span>` : ''}
                            </div>
                          </div>
                          ${
                            item.proxyUsed
                              ? `<div class="notice info">使用代理：<code>${escapeHtml(item.proxyUsed)}</code></div>`
                              : `<div class="notice info">当前测试路径：直连</div>`
                          }
                          ${item.error ? `<div class="notice error">${escapeHtml(item.error)}</div>` : ''}
                        </article>
                      `,
                    )
                    .join('')}
                </div>
              `
            : ''
        }
      </div>
    </article>
  `;
}

function renderSystemTranslationConfigPanel(state, settings) {
  const provider = translationProviderMeta(settings.translationProvider);
  const apiKeyVisible = Boolean(state.systemTranslationApiKeyVisible);
  const apiKeyLoading = Boolean(state.systemTranslationApiKeyLoading);
  const translationTestLoading = Boolean(state.systemTranslationTestLoading);
  const translationTest = state.systemTranslationTestResult || null;
  const translationTestTone =
    translationTest?.tone === 'error'
      ? 'error'
      : translationTest?.tone === 'success'
        ? 'success'
        : 'info';
  const apiKeyConfigured = Boolean(settings.translationApiKeyConfigured);
  const apiKeyValue = String(settings.translationApiKey || '');
  const usesApiKey = translationProviderUsesApiKey(provider.id);
  const apiKeyStatusLabel = usesApiKey
    ? apiKeyConfigured
      ? 'API Key 已保存'
      : 'API Key 未保存'
    : '当前渠道无需 API Key';
  const requiresBaseUrl = translationProviderRequiresBaseUrl(provider.id);
  const requiresModel = provider.id === 'openai_compatible';
  const requiresRegion = translationProviderRequiresRegion(provider.id);
  const apiKeyPlaceholder =
    provider.id === 'openai_compatible'
      ? apiKeyConfigured
        ? '已保存 API Key，留空则继续沿用当前密钥'
        : '例如 sk-...'
      : provider.id === 'libretranslate'
        ? apiKeyConfigured
          ? '已保存 API Key，留空则继续沿用当前密钥'
          : '如你的 LibreTranslate 服务要求鉴权，可在这里填写'
        : '当前引擎无需 API Key，可保持留空';
  const apiKeyButtonLabel = apiKeyLoading ? '加载中' : apiKeyVisible ? '隐藏' : '显示';
  const testButtonLabel = translationTestLoading ? '测试中...' : '测试翻译配置';
  const baseUrlPlaceholder =
    provider.id === 'openai_compatible'
      ? 'https://api.openai.com/v1'
      : provider.id === 'libretranslate'
        ? 'https://libretranslate.example.com'
        : '';
  const providerTips =
    provider.id === 'google_free'
      ? [
          '开箱即用，无需额外配置，更适合海外网络环境下快速查看英文邮件。',
          '属于公共免费接口，偶尔可能出现限流、超时或网络不可达的情况。',
        ]
      : provider.id === 'mymemory_free'
        ? [
            '开箱即用，无需额外配置，长邮件会自动拆分后逐段翻译。',
            '更适合短文本或普通正文；如果你更在意语气和上下文，建议切到 AI 引擎。',
          ]
        : provider.id === 'libretranslate'
          ? [
              '推荐填写你自己的 LibreTranslate 接口地址，公共实例可用性取决于服务方。',
              '如果服务端要求鉴权，可填写 API Key；不要求时可以留空。',
            ]
          : [
              '适合复杂邮件、多段上下文和专业术语翻译。',
              '建议同时填写 Base URL、模型名称和 API Key，邮件翻译质量会更稳定。',
            ];

  const apiKeyPlaceholderResolved = translationApiKeyPlaceholder(provider.id, apiKeyConfigured);
  const baseUrlPlaceholderResolved = translationBaseUrlPlaceholder(provider.id);
  const providerTipsResolved = translationProviderTips(provider.id);

  return `
    <article class="panel system-panel" data-icon="mail">
      <div class="panel-header">
        <div>
          <h3>翻译引擎</h3>
          <p>给邮件详情加入一键翻译能力。可以直接用内置免费引擎，也可以切换到 OpenAI 兼容 AI 模型。</p>
        </div>
        <div class="tool-panel-actions">
          <span class="tag">${escapeHtml(provider.badge)}</span>
          <span class="tag subtle">${escapeHtml(provider.label)}</span>
          <span class="tag subtle">${escapeHtml(apiKeyStatusLabel)}</span>
        </div>
      </div>
      <div class="system-brand-preview-card">
        ${renderAutoIcon('mail', 'Translation Engine', 'system-brand-preview-avatar')}
        <div class="system-brand-preview-copy">
          <strong>${escapeHtml(provider.label)}</strong>
          <p>目标语言：${escapeHtml(settings.translationTargetLanguage || 'zh-CN')} / 配置保存后，收件箱详情里即可直接点击“一键翻译”</p>
        </div>
      </div>
      <div class="stack">
        <div class="inline-grid">
          <label>
            <span>翻译渠道</span>
            <select name="translationProvider">
              ${TRANSLATION_PROVIDER_OPTIONS.map(
                (item) => `
                  <option value="${escapeHtml(item.id)}" ${item.id === provider.id ? 'selected' : ''}>
                    ${escapeHtml(item.label)}
                  </option>
                `,
              ).join('')}
            </select>
          </label>
          <label>
            <span>目标语言</span>
            <input
              name="translationTargetLanguage"
              value="${escapeHtml(settings.translationTargetLanguage || 'zh-CN')}"
              placeholder="zh-CN"
              spellcheck="false"
              autocomplete="off"
            />
          </label>
        </div>
        ${
          requiresBaseUrl
            ? `
              <label>
                <span>接口地址（Base URL）</span>
                <input
                  name="translationBaseUrl"
                  type="url"
                  value="${escapeHtml(settings.translationBaseUrl || '')}"
                  placeholder="${escapeHtml(baseUrlPlaceholderResolved)}"
                  spellcheck="false"
                  autocomplete="off"
                />
              </label>
            `
            : ''
        }
        ${
          requiresRegion
            ? `
              <label>
                <span>区域（Region）</span>
                <input
                  name="translationRegion"
                  value="${escapeHtml(settings.translationRegion || '')}"
                  placeholder="例如 eastasia，可留空使用默认全局端点"
                  spellcheck="false"
                  autocomplete="off"
                />
              </label>
            `
            : `<input type="hidden" name="translationRegion" value="${escapeHtml(settings.translationRegion || '')}" />`
        }
        ${
          requiresModel
            ? `
              <label>
                <span>模型名称（Model）</span>
                <input
                  name="translationModel"
                  value="${escapeHtml(settings.translationModel || '')}"
                  placeholder="gpt-4o-mini / gpt-5-mini"
                  spellcheck="false"
                  autocomplete="off"
                />
              </label>
            `
            : ''
        }
        ${
          usesApiKey
            ? `
              <label class="notification-config-field">
                <span>API Key</span>
                <div class="password-field">
                  <input
                    name="translationApiKey"
                    type="${apiKeyVisible ? 'text' : 'password'}"
                    value="${escapeHtml(apiKeyValue)}"
                    placeholder="${escapeHtml(apiKeyPlaceholderResolved)}"
                    spellcheck="false"
                    autocomplete="off"
                  />
                  <button
                    class="password-toggle-button ${apiKeyVisible ? 'is-active' : ''}"
                    type="button"
                    data-action="toggle-system-translation-api-key-visibility"
                    ${apiKeyLoading ? 'disabled' : ''}
                  >
                    ${escapeHtml(apiKeyButtonLabel)}
                  </button>
                </div>
              </label>
            `
            : `
              <input type="hidden" name="translationApiKey" value="${escapeHtml(apiKeyValue)}" />
            `
        }
        <div class="system-translation-actions">
          ${usesApiKey ? '<span class="tag subtle">留空则继续沿用当前已保存的 API Key</span>' : '<span class="tag subtle">内置免费引擎无需 API Key</span>'}
          <div class="system-translation-action-buttons">
            <button
              class="button ghost"
              type="button"
              data-action="test-translation-system-settings"
              ${translationTestLoading ? 'disabled' : ''}
            >
              ${escapeHtml(testButtonLabel)}
            </button>
            <button class="button" type="button" data-action="save-translation-system-settings">保存翻译配置</button>
          </div>
        </div>
        ${
          translationTestLoading
            ? '<div class="notice info">正在测试当前翻译配置，请稍候...</div>'
            : translationTest
              ? `
                <div class="notice ${translationTestTone}">${escapeHtml(translationTest.text || '')}</div>
                ${
                  translationTest.fallbackNotice
                    ? `<div class="notice info">${escapeHtml(translationTest.fallbackNotice)}</div>`
                    : ''
                }
                ${
                  translationTest.translatedPreview
                    ? `
                      <div class="system-translation-test-preview">
                        <div class="system-translation-test-head">
                          <strong>测试翻译预览</strong>
                          <span>${escapeHtml(
                            [translationTest.providerLabel, translationTest.targetLanguage].filter(Boolean).join(' / '),
                          )}</span>
                        </div>
                        <pre>${escapeHtml(translationTest.translatedPreview)}</pre>
                      </div>
                    `
                    : ''
                }
              `
              : ''
        }
      </div>
      <div class="notice info system-microsoft-note">
        当前渠道说明：${escapeHtml(provider.description)}
      </div>
      <ul class="system-translation-note-list">
        ${providerTipsResolved.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}
      </ul>
    </article>
  `;
}

function renderSystemStorageConfigPanel(state, settings) {
  const provider = systemStorageProviderMeta(settings.storageProvider);
  const syncPolicy =
    SYSTEM_STORAGE_SYNC_POLICY_OPTIONS.find((item) => item.id === settings.storageSyncPolicy)
    || SYSTEM_STORAGE_SYNC_POLICY_OPTIONS[0];
  const storageTestLoading = Boolean(state.systemStorageTestLoading);
  const storageTest = state.systemStorageTestResult || null;
  const s3SecretVisible = Boolean(state.systemStorageSecretVisibility?.storageS3Secret);
  const webdavPasswordVisible = Boolean(state.systemStorageSecretVisibility?.storageWebdavPassword);
  const ftpPasswordVisible = Boolean(state.systemStorageSecretVisibility?.storageFtpPassword);
  const s3SecretLoading = Boolean(state.systemStorageSecretLoading?.storageS3Secret);
  const webdavPasswordLoading = Boolean(state.systemStorageSecretLoading?.storageWebdavPassword);
  const ftpPasswordLoading = Boolean(state.systemStorageSecretLoading?.storageFtpPassword);
  const s3ButtonLabel = s3SecretLoading ? '加载中' : s3SecretVisible ? '隐藏' : '显示';
  const webdavButtonLabel = webdavPasswordLoading ? '加载中' : webdavPasswordVisible ? '隐藏' : '显示';
  const ftpButtonLabel = ftpPasswordLoading ? '加载中' : ftpPasswordVisible ? '隐藏' : '显示';
  const testButtonLabel = storageTestLoading ? '测试中...' : '测试存储连接';
  const storageTestTone =
    storageTest?.tone === 'error'
      ? 'error'
      : storageTest?.tone === 'success'
        ? 'success'
        : 'info';

  const providerFields =
    provider.id === 's3'
      ? `
          <div class="inline-grid">
            <label>
              <span>Bucket / 存储桶</span>
              <input name="storageS3Bucket" value="${escapeHtml(settings.storageS3Bucket || '')}" placeholder="例如：mail-union-assets" />
            </label>
            <label>
              <span>Region / 区域</span>
              <input name="storageS3Region" value="${escapeHtml(settings.storageS3Region || '')}" placeholder="例如：ap-east-1" />
            </label>
          </div>
          <div class="inline-grid">
            <label>
              <span>Endpoint / 接口地址</span>
              <input name="storageS3Endpoint" value="${escapeHtml(settings.storageS3Endpoint || '')}" placeholder="可选，例如：https://s3.ap-east-1.amazonaws.com" />
            </label>
            <label>
              <span>Access Key / 访问密钥</span>
              <input name="storageS3AccessKey" value="${escapeHtml(settings.storageS3AccessKey || '')}" placeholder="填写对象存储 Access Key" />
            </label>
          </div>
          <label>
            <span>Secret Key / 密钥</span>
            <div class="password-field">
              <input
                name="storageS3Secret"
                type="${s3SecretVisible ? 'text' : 'password'}"
                value="${escapeHtml(settings.storageS3Secret || '')}"
                placeholder="${settings.storageS3SecretConfigured ? '已保存，留空则继续沿用当前密钥' : '首次接入时填写 Secret Key'}"
                spellcheck="false"
                autocomplete="off"
              />
              <button
                class="password-toggle-button ${s3SecretVisible ? 'is-active' : ''}"
                type="button"
                data-action="toggle-system-storage-secret-visibility"
                data-field="storageS3Secret"
                ${s3SecretLoading ? 'disabled' : ''}
              >
                ${escapeHtml(s3ButtonLabel)}
              </button>
            </div>
          </label>
          <div class="system-storage-inline-options">
            <label class="check-field">
              <input name="storageS3ForcePathStyle" type="checkbox" ${settings.storageS3ForcePathStyle ? 'checked' : ''} />
              <span>强制 Path Style</span>
            </label>
          </div>
        `
      : provider.id === 'webdav'
        ? `
            <label>
              <span>WebDAV 地址</span>
              <input name="storageWebdavUrl" value="${escapeHtml(settings.storageWebdavUrl || '')}" placeholder="例如：https://dav.example.com/remote.php/webdav" />
            </label>
            <div class="inline-grid">
              <label>
                <span>用户名</span>
                <input name="storageWebdavUsername" value="${escapeHtml(settings.storageWebdavUsername || '')}" placeholder="填写 WebDAV 用户名" />
              </label>
              <label>
                <span>密码</span>
                <div class="password-field">
                  <input
                    name="storageWebdavPassword"
                    type="${webdavPasswordVisible ? 'text' : 'password'}"
                    value="${escapeHtml(settings.storageWebdavPassword || '')}"
                    placeholder="${settings.storageWebdavPasswordConfigured ? '已保存，留空则继续沿用当前密码' : '首次接入时填写 WebDAV 密码'}"
                    spellcheck="false"
                    autocomplete="off"
                  />
                  <button
                    class="password-toggle-button ${webdavPasswordVisible ? 'is-active' : ''}"
                    type="button"
                    data-action="toggle-system-storage-secret-visibility"
                    data-field="storageWebdavPassword"
                    ${webdavPasswordLoading ? 'disabled' : ''}
                  >
                    ${escapeHtml(webdavButtonLabel)}
                  </button>
                </div>
              </label>
            </div>
          `
        : provider.id === 'ftp'
          ? `
              <div class="inline-grid">
                <label>
                  <span>主机地址</span>
                  <input name="storageFtpHost" value="${escapeHtml(settings.storageFtpHost || '')}" placeholder="例如：ftp.example.com" />
                </label>
                <label>
                  <span>端口</span>
                  <input name="storageFtpPort" type="number" min="1" max="65535" value="${escapeHtml(settings.storageFtpPort || 21)}" />
                </label>
              </div>
              <div class="inline-grid">
                <label>
                  <span>用户名</span>
                  <input name="storageFtpUsername" value="${escapeHtml(settings.storageFtpUsername || '')}" placeholder="填写 FTP 用户名" />
                </label>
                <label>
                  <span>密码</span>
                  <div class="password-field">
                    <input
                      name="storageFtpPassword"
                      type="${ftpPasswordVisible ? 'text' : 'password'}"
                      value="${escapeHtml(settings.storageFtpPassword || '')}"
                      placeholder="${settings.storageFtpPasswordConfigured ? '已保存，留空则继续沿用当前密码' : '首次接入时填写 FTP 密码'}"
                      spellcheck="false"
                      autocomplete="off"
                    />
                    <button
                      class="password-toggle-button ${ftpPasswordVisible ? 'is-active' : ''}"
                      type="button"
                      data-action="toggle-system-storage-secret-visibility"
                      data-field="storageFtpPassword"
                      ${ftpPasswordLoading ? 'disabled' : ''}
                    >
                      ${escapeHtml(ftpButtonLabel)}
                    </button>
                  </div>
                </label>
              </div>
              <div class="system-storage-inline-options">
                <label class="check-field">
                  <input name="storageFtpSecure" type="checkbox" ${settings.storageFtpSecure ? 'checked' : ''} />
                  <span>启用 FTPS / TLS</span>
                </label>
              </div>
            `
          : `
              <div class="notice info">
                当前使用本地附件目录模式。网站 Logo、邮件附件和本地备份文件会保存在服务器本地目录；如果后续切到远程存储，新的附件和备份就会按当前配置同步到远程。
              </div>
            `;

  return `
    <article class="panel system-panel" data-icon="storage">
      <div class="panel-header">
        <div>
          <h3>附件与远程存储</h3>
          <p>统一管理网站 Logo、邮件附件、备份压缩包等文件的存放方式。默认本地，支持切换到 S3、WebDAV、FTP。</p>
        </div>
        <div class="tool-panel-actions">
          <span class="tag">${escapeHtml(provider.label)}</span>
        </div>
      </div>
      <div class="system-brand-preview-card">
        ${renderAutoIcon('storage', provider.label, 'system-brand-preview-avatar')}
        <div class="system-brand-preview-copy">
          <strong>${escapeHtml(provider.label)}</strong>
          <p>${escapeHtml(provider.description)} 当前远程目录前缀：${escapeHtml(settings.storageRemotePathPrefix || 'mail-union')}</p>
        </div>
      </div>
      <div class="stack">
        <div class="inline-grid">
          <label>
            <span>存储方式</span>
            <select name="storageProvider">
              ${SYSTEM_STORAGE_PROVIDER_OPTIONS.map(
                (item) => `
                  <option value="${escapeHtml(item.id)}" ${item.id === provider.id ? 'selected' : ''}>
                    ${escapeHtml(item.label)}
                  </option>
                `,
              ).join('')}
            </select>
          </label>
          <label>
            <span>数据存放策略</span>
            <select name="storageSyncPolicy">
              ${SYSTEM_STORAGE_SYNC_POLICY_OPTIONS.map(
                (item) => `
                  <option value="${escapeHtml(item.id)}" ${item.id === syncPolicy.id ? 'selected' : ''}>
                    ${escapeHtml(item.label)}
                  </option>
                `,
              ).join('')}
            </select>
            <small>${escapeHtml(syncPolicy.description)}</small>
          </label>
          <label>
            <span>远程目录前缀</span>
            <input name="storageRemotePathPrefix" value="${escapeHtml(settings.storageRemotePathPrefix || 'mail-union')}" placeholder="例如：mail-union" />
          </label>
        </div>
        ${providerFields}
        ${
          storageTest
            ? `
                <div class="system-storage-test-preview">
                  <div class="system-storage-test-head">
                    <strong>${escapeHtml(storageTest.text || '远程存储测试完成')}</strong>
                    <span>${escapeHtml(
                      storageTest.provider
                        ? `${String(storageTest.provider).toUpperCase()} / ${storageTest.deleted ? '测试文件已自动清理' : '未执行清理'}`
                        : provider.label,
                    )}</span>
                  </div>
                  <div class="notice ${storageTestTone}">
                    ${escapeHtml(
                      storageTest.writable
                        ? storageTest.provider === 'local'
                          ? '已完成本地目录写入与删除验证，这说明当前本地附件目录可以正常使用。'
                          : '已完成写入与删除验证，这说明当前远程存储配置具备实际可用性。'
                        : storageTest.provider === 'local'
                          ? '当前测试没有完成本地目录写入验证，请检查目录权限后再试。'
                          : '当前测试没有完成写入验证，请根据上面的报错调整配置后再试。',
                    )}
                  </div>
                  <div class="tool-summary">
                    <div class="tool-stat">
                      <span>测试方式</span>
                      <strong>${escapeHtml(
                        storageTest.provider === 'local'
                          ? '写入 1 个本地探针文件并立即删除'
                          : '上传 1 个探针文件并立即删除',
                      )}</strong>
                    </div>
                    ${
                      storageTest.remotePath
                        ? `
                            <div class="tool-stat">
                              <span>${escapeHtml(storageTest.provider === 'local' ? '本地路径' : '远程路径')}</span>
                              <strong>${escapeHtml(storageTest.remotePath)}</strong>
                            </div>
                          `
                        : ''
                    }
                    ${
                      storageTest.remoteUrl
                        ? `
                            <div class="tool-stat">
                              <span>远程链接</span>
                              <strong><a href="${escapeHtml(storageTest.remoteUrl)}" target="_blank" rel="noreferrer">${escapeHtml(storageTest.remoteUrl)}</a></strong>
                            </div>
                          `
                        : ''
                    }
                  </div>
                </div>
              `
            : ''
        }
        <div class="form-actions system-panel-actions">
          ${
            provider.id !== 'local'
              ? `<button class="button ghost" type="button" data-action="test-storage-system-settings" ${storageTestLoading ? 'disabled' : ''}>${escapeHtml(testButtonLabel)}</button>`
              : ''
          }
          <button class="button" type="button" data-action="save-storage-system-settings">保存存储配置</button>
        </div>
      </div>
    </article>
  `;
}

function summarizeAttachmentMetadataSyncResult(result = null) {
  if (!result) {
    return '';
  }

  const eligibleMailboxCount = Number(result.eligibleMailboxCount || 0);
  const scannedMessageCount = Number(result.scannedMessageCount || 0);
  const syncedMessageCount = Number(result.syncedMessageCount || 0);
  const storedAttachmentCount = Number(result.storedAttachmentCount || 0);
  const skippedMessageCount = Number(result.skippedMessageCount || 0);
  const errorCount = Number(result.errorCount || 0);

  if (!(eligibleMailboxCount > 0)) {
    return '当前没有勾选“附件同步”的邮箱，先到邮箱设置里勾选需要纳入手动同步范围的邮箱。';
  }

  const parts = [
    `已检查 ${scannedMessageCount} 封带附件邮件`,
    `成功落地 ${storedAttachmentCount} 个附件`,
    `涉及 ${syncedMessageCount} 封邮件`,
  ];

  if (skippedMessageCount > 0) {
    parts.push(`${skippedMessageCount} 封无需新增同步`);
  }

  if (errorCount > 0) {
    parts.push(`${errorCount} 封处理失败`);
  }

  return `${parts.join('，')}。已纳入范围邮箱 ${eligibleMailboxCount} 个。`;
}

function renderAttachmentMetadataPanel(state) {
  const items = Array.isArray(state.attachmentMetadata) ? state.attachmentMetadata : [];
  const loading = Boolean(state.attachmentMetadataLoading);
  const syncing = Boolean(state.attachmentMetadataSyncLoading);
  const deleting = Boolean(state.attachmentMetadataBulkDeleteLoading);
  const syncResult = state.attachmentMetadataSyncResult || null;
  const selectedIds = new Set(Array.isArray(state.attachmentMetadataSelectedIds) ? state.attachmentMetadataSelectedIds : []);
  const visibleSelectionIds = items
    .map((item) => {
      const messageId = String(item?.messageId || '').trim();
      const attachmentIndex = Number(item?.attachmentIndex);
      return messageId && Number.isInteger(attachmentIndex) && attachmentIndex >= 0
        ? `${messageId}::${attachmentIndex}`
        : '';
    })
    .filter(Boolean);
  const selectedCount = visibleSelectionIds.filter((selectionId) => selectedIds.has(selectionId)).length;
  const allVisibleAttachmentsSelected =
    Boolean(visibleSelectionIds.length) && visibleSelectionIds.every((selectionId) => selectedIds.has(selectionId));
  const attachmentPagination = state.attachmentMetadataPagination || {};
  const attachmentPage = Math.max(Number(attachmentPagination.page || state.attachmentMetadataPage || 1), 1);
  const attachmentPageSize = PAGE_SIZE_OPTIONS.includes(Number(attachmentPagination.pageSize || state.attachmentMetadataPageSize))
    ? Number(attachmentPagination.pageSize || state.attachmentMetadataPageSize)
    : 10;
  const attachmentTotalItems = Math.max(Number(attachmentPagination.totalItems || 0), 0);
  const attachmentTotalPages = Math.max(Number(attachmentPagination.totalPages || 1), 1);
  const syncSummary = summarizeAttachmentMetadataSyncResult(syncResult);
  const syncTone =
    Number(syncResult?.eligibleMailboxCount || 0) <= 0
      ? 'warning'
      : Number(syncResult?.errorCount || 0) > 0
        ? 'warning'
        : 'success';

  return `
    <article class="panel system-panel" data-icon="attachments">
      <div class="panel-header">
        <div>
          <h3>本地附件内容与元数据</h3>
          <p>这里只显示已经同步保存到本地的附件。普通收信时仅保留附件元数据，需要时请手动同步已勾选邮箱附件。</p>
        </div>
        <div class="tool-panel-actions">
          <span class="tag subtle">${escapeHtml(`${attachmentTotalItems} 条记录`)}</span>
          <button class="button" type="button" data-action="sync-selected-mailbox-attachments" ${(loading || syncing || deleting) ? 'disabled' : ''}>${syncing ? '同步中...' : '同步已勾选邮箱附件'}</button>
          <button class="button ghost" type="button" data-action="reload-attachment-metadata" ${(loading || syncing || deleting) ? 'disabled' : ''}>${loading ? '刷新中...' : '刷新列表'}</button>
        </div>
      </div>
      ${syncSummary ? `<div class="notice ${syncTone}">${escapeHtml(syncSummary)}</div>` : ''}
      ${
        loading
          ? '<div class="notice info">正在加载本地附件列表，请稍候...</div>'
          : items.length
            ? `
              <div class="metadata-attachment-bulk-toolbar">
                <label class="check-field metadata-attachment-select-all">
                  <input
                    type="checkbox"
                    data-action="toggle-select-all-visible-attachments"
                    ${allVisibleAttachmentsSelected ? 'checked' : ''}
                    ${(syncing || deleting) ? 'disabled' : ''}
                  />
                  <span>全选本页</span>
                </label>
                <span class="tag subtle">${escapeHtml(`已选 ${selectedCount} 个`)}</span>
                <button
                  class="tiny-button danger"
                  type="button"
                  data-action="bulk-delete-attachment-metadata"
                  ${(selectedCount && !syncing && !deleting) ? '' : 'disabled'}
                >
                  ${deleting ? '删除中...' : '批量删除'}
                </button>
                <p>批量删除只清理本地附件文件，邮件记录与附件元数据仍会保留，后续需要时可重新同步。</p>
              </div>
              <div class="metadata-attachment-list">
                ${items
                  .map((item) => {
                    const previewKind = attachmentPreviewKind(item);
                    const openUrl = `/api/messages/${encodeURIComponent(item.messageId)}/attachments/${item.attachmentIndex}/open`;
                    const downloadUrl = `/api/messages/${encodeURIComponent(item.messageId)}/attachments/${item.attachmentIndex}/download`;
                    const previewUrl = openUrl;
                    const previewAvailable = Boolean(previewUrl) && ['image', 'pdf', 'audio'].includes(previewKind);
                    const statusText = '已同步到本地';
                    const interactionAttrs = renderAttachmentInteractionAttributes({
                      previewKind,
                      previewUrl,
                      downloadUrl,
                      filename: item.filename || '附件',
                      contentType: item.contentType || '',
                      size: item.size || 0,
                      subtitle: item.subject || '',
                      mailboxLabel: item.mailboxEmail || item.mailboxName || '',
                      ownerLabel: item.ownerName || item.ownerEmail || '',
                      receivedAt: item.receivedAt || '',
                      storagePath: item.relativePath || item.publicPath || '',
                      statusText,
                      note: item.note || '',
                    });
                    const selectionId = `${String(item.messageId || '').trim()}::${Number(item.attachmentIndex)}`;
                    const isSelected = selectedIds.has(selectionId);

                    return `
                      <article class="metadata-attachment-card attachment-interactive-card ${previewAvailable ? 'has-hover-preview' : 'has-no-preview'} ${isSelected ? 'is-selected' : ''}" tabindex="0" title="${escapeHtmlAttribute(previewAvailable ? '悬停预览，双击弹窗查看' : '双击查看附件详情')}" ${interactionAttrs}>
                        <div class="metadata-attachment-main">
                          <div class="metadata-attachment-mainline">
                            <label class="metadata-attachment-select" title="选择这个本地附件">
                              <input
                                type="checkbox"
                                data-action="toggle-attachment-metadata-select"
                                data-selection-id="${escapeHtmlAttribute(selectionId)}"
                                ${isSelected ? 'checked' : ''}
                                ${(syncing || deleting) ? 'disabled' : ''}
                              />
                              <span>选择</span>
                            </label>
                            ${renderAutoIcon(attachmentPreviewIconKey(previewKind), item.filename || '附件', 'metadata-attachment-icon')}
                            <div class="metadata-attachment-copy">
                              <strong>${escapeHtml(item.filename || '附件')}</strong>
                              <p>${escapeHtml(item.subject || '（无主题邮件）')}</p>
                              <div class="metadata-attachment-meta">
                                <span>${escapeHtml(item.mailboxName || item.mailboxEmail || '')}</span>
                                <span>${escapeHtml(formatFileSize(item.size || 0))}</span>
                                <span>${escapeHtml(item.contentType || '未知类型')}</span>
                                <span>${escapeHtml(statusText)}</span>
                              </div>
                            </div>
                          </div>
                          <div class="metadata-attachment-actions">
                            <button class="tiny-button" type="button" data-action="open-attachment-preview-modal" ${interactionAttrs}>查看</button>
                            <a class="tiny-button" href="${escapeHtml(downloadUrl)}">下载</a>
                          </div>
                        </div>
                        <div class="metadata-attachment-foot">
                          <span class="attachment-interaction-hint">${previewAvailable ? '悬停预览 · 双击卡片弹窗查看' : '双击卡片查看详情'}</span>
                          <span class="tag subtle">${escapeHtml(item.receivedAt ? formatFullDate(item.receivedAt) : '未知时间')}</span>
                        </div>
                      </article>
                    `;
                  })
                  .join('')}
              </div>
              ${renderPaginationBar({
                type: 'attachment',
                page: attachmentPage,
                pageSize: attachmentPageSize,
                totalItems: attachmentTotalItems,
                totalPages: attachmentTotalPages,
                currentCount: items.length,
                pageSizeAction: 'attachment-page-size',
                pageAction: 'go-attachment-page',
                jumpAction: 'jump-attachment-page',
              })}
            `
            : `
              <div class="empty-card">当前还没有已同步到本地的附件。先在邮箱设置里勾选需要纳入范围的邮箱，再点击上方“同步已勾选邮箱附件”即可批量保存到本地。</div>
              ${renderPaginationBar({
                type: 'attachment',
                page: attachmentPage,
                pageSize: attachmentPageSize,
                totalItems: attachmentTotalItems,
                totalPages: attachmentTotalPages,
                currentCount: 0,
                pageSizeAction: 'attachment-page-size',
                pageAction: 'go-attachment-page',
                jumpAction: 'jump-attachment-page',
              })}
            `
      }
    </article>
  `;
}

function renderAttachmentPreviewModal(state) {
  const preview = state.attachmentPreviewModal;
  if (!preview) {
    return '';
  }

  const infoItems = [
    ['邮件主题', preview.subtitle],
    ['所属邮箱', preview.mailboxLabel],
    ['归属用户', preview.ownerLabel],
    ['接收时间', preview.receivedAt ? formatFullDate(preview.receivedAt) : ''],
    ['存储位置', preview.storagePath],
    ['状态说明', preview.note || preview.statusText],
  ].filter((item) => Boolean(String(item[1] || '').trim()));

  return `
    <div class="modal-shell attachment-viewer-shell">
      <div class="modal-backdrop" data-attachment-preview-overlay></div>
      <section class="modal-panel attachment-viewer-modal">
        <div class="attachment-viewer-head">
          <div class="attachment-viewer-title">
            ${renderAutoIcon(attachmentPreviewIconKey(preview.previewKind), preview.filename || '附件', 'attachment-viewer-icon')}
            <div class="attachment-viewer-copy">
              <p class="eyebrow">${escapeHtml(preview.previewKindLabel || attachmentPreviewKindLabel(preview.previewKind || 'file'))}</p>
              <h3>${escapeHtml(preview.filename || '附件')}</h3>
              <p>${escapeHtml(preview.subtitle || '双击打开后，会以卡片阅读器的形式查看当前附件。')}</p>
            </div>
          </div>
          <div class="attachment-viewer-actions">
            ${
              preview.previewUrl
                ? `<a class="button ghost" href="${escapeHtml(preview.previewUrl)}" target="_blank" rel="noreferrer noopener">新窗口打开</a>`
                : ''
            }
            ${
              preview.downloadUrl
                ? `<a class="button ghost" href="${escapeHtml(preview.downloadUrl)}">下载附件</a>`
                : ''
            }
            <button class="button" type="button" data-action="close-attachment-preview-modal">关闭</button>
          </div>
        </div>
        <div class="attachment-viewer-layout">
          <div class="attachment-viewer-stage">
            ${renderAttachmentViewerSurface(preview.previewKind || 'file', preview.previewUrl || '', preview.filename || '附件', 'attachment-viewer-stage-surface')}
          </div>
          <aside class="attachment-viewer-sidebar">
            <div class="attachment-viewer-summary">
              <div class="metadata-attachment-meta">
                <span>${escapeHtml(formatFileSize(preview.size || 0))}</span>
                <span>${escapeHtml(preview.contentType || '未知类型')}</span>
                <span>${escapeHtml(preview.statusText || '附件详情')}</span>
              </div>
            </div>
            <dl class="attachment-viewer-meta">
              ${infoItems
                .map(
                  ([label, value]) => `
                    <div>
                      <dt>${escapeHtml(label)}</dt>
                      <dd>${escapeHtml(value)}</dd>
                    </div>
                  `,
                )
                .join('')}
            </dl>
          </aside>
        </div>
      </section>
    </div>
  `;
}

function renderConfirmDialog(state) {
  const dialog = state.confirmDialog;
  if (!dialog) {
    return '';
  }

  const toneClass = dialog.tone === 'danger' ? 'is-danger' : '';
  const iconKey = dialog.icon || (dialog.tone === 'danger' ? 'warning' : 'notes');

  return `
    <div class="modal-shell confirm-dialog-shell">
      <div class="modal-backdrop" data-confirm-overlay></div>
      <section class="modal-panel confirm-dialog-modal ${toneClass}">
        <div class="confirm-dialog-header">
          <div class="confirm-dialog-badge ${toneClass}">
            ${renderAutoIcon(iconKey, dialog.title || '确认', 'confirm-dialog-icon')}
          </div>
          <div class="confirm-dialog-copy">
            <p class="eyebrow">${escapeHtml(dialog.eyebrow || '操作确认')}</p>
            <h3>${escapeHtml(dialog.title || '确认继续当前操作？')}</h3>
            <p>${escapeHtml(dialog.message || '该操作会立即生效，请确认后继续。')}</p>
          </div>
        </div>
        <div class="confirm-dialog-actions">
          <button class="button ghost" type="button" data-action="close-confirm-dialog">
            ${escapeHtml(dialog.cancelLabel || '取消')}
          </button>
          <button class="button confirm-dialog-confirm ${toneClass}" type="button" data-action="confirm-dialog-confirm">
            ${escapeHtml(dialog.confirmLabel || '确认')}
          </button>
        </div>
      </section>
    </div>
  `;
}

function renderBackups(state) {
  const settings = normalizeSystemSettings(state.systemSettingsDraft || state.systemSettings);
  const targetMeta = systemBackupTargetMeta(settings.backupTarget);
  const contentModeMeta = systemBackupContentModeMeta(settings.backupContentMode);
  const runTargetMeta = systemBackupTargetMeta(state.backupRunDestination || settings.backupTarget);
  const runContentModeMeta = systemBackupContentModeMeta(state.backupRunContentMode || settings.backupContentMode);
  const backupRecords = Array.isArray(state.backups) ? state.backups : [];
  const activeRunTarget = String(state.backupRunLoading || '').trim();
  const deletingBackupId = String(state.backupDeleteLoadingId || '').trim();
  const storageMeta = systemStorageProviderMeta(settings.storageProvider);
  const restoreFilename = String(state.backupRestoreFilename || '').trim();
  const restoreLoading = Boolean(state.backupRestoreLoading);
  const restoreModeMeta = systemBackupRestoreModeMeta(state.backupRestoreMode);

  return `
    <section class="view-grid view-grid-system">
      <form data-form="backup-settings" class="stack">
        <article class="panel system-panel">
          <div class="panel-header">
            <div>
              <h3>备份策略</h3>
              <p>这里可以设置自动备份频率、保留数量、备份内容和备份目标，支持打包下载，也支持同步推送到远程存储。</p>
            </div>
            <div class="tool-panel-actions">
              <span class="tag ${settings.backupEnabled ? '' : 'subtle'}">${settings.backupEnabled ? '自动备份已开启' : '自动备份未开启'}</span>
            </div>
          </div>
          <div class="tool-summary">
            <div class="tool-stat">
              <span>备份目标</span>
              <strong>${escapeHtml(targetMeta.label)}</strong>
            </div>
            <div class="tool-stat">
              <span>备份内容</span>
              <strong>${escapeHtml(contentModeMeta.label)}</strong>
            </div>
            <div class="tool-stat">
              <span>当前存储方式</span>
              <strong>${escapeHtml(storageMeta.label)}</strong>
            </div>
            <div class="tool-stat">
              <span>最近记录数</span>
              <strong>${escapeHtml(String(backupRecords.length))}</strong>
            </div>
          </div>
          <div class="stack">
            <div class="inline-grid">
              <label>
                <span>备份间隔（小时）</span>
                <input name="backupIntervalHours" type="number" min="1" max="720" value="${escapeHtml(settings.backupIntervalHours || 24)}" />
              </label>
              <label>
                <span>保留数量</span>
                <input name="backupRetentionCount" type="number" min="1" max="200" value="${escapeHtml(settings.backupRetentionCount || 10)}" />
              </label>
              <label>
                <span>备份目标</span>
                <select name="backupTarget">
                  ${SYSTEM_BACKUP_TARGET_OPTIONS.map(
                    (item) => `
                      <option value="${escapeHtml(item.id)}" ${item.id === targetMeta.id ? 'selected' : ''}>
                        ${escapeHtml(item.label)}
                      </option>
                    `,
                  ).join('')}
                </select>
              </label>
              <label>
                <span>备份内容</span>
                <select name="backupContentMode">
                  ${SYSTEM_BACKUP_CONTENT_MODE_OPTIONS.map(
                    (item) => `
                      <option value="${escapeHtml(item.id)}" ${item.id === contentModeMeta.id ? 'selected' : ''}>
                        ${escapeHtml(item.label)}
                      </option>
                    `,
                  ).join('')}
                </select>
              </label>
            </div>
            <div class="system-storage-inline-options">
              <label class="check-field">
                <input name="backupEnabled" type="checkbox" ${settings.backupEnabled ? 'checked' : ''} />
                <span>启用定时备份</span>
              </label>
            </div>
            <div class="form-actions system-panel-actions">
              <button class="button" type="button" data-action="save-backup-system-settings">保存备份策略</button>
            </div>
          </div>
        </article>
      </form>

      <article class="panel system-panel" data-backup-run-panel="true">
        <div class="panel-header">
          <div>
            <h3>立即执行</h3>
            <p>先选择这次要备份的内容和目标，再点击立即执行。下载按钮只会显示在本地备份成功的记录上。</p>
          </div>
          <div class="tool-panel-actions">
            <button class="button ghost" type="button" data-action="refresh-backups">刷新记录</button>
          </div>
        </div>
        <div class="inline-grid backup-run-config-row">
          <label>
            <span>本次备份内容</span>
            <select name="backupRunContentMode">
              ${SYSTEM_BACKUP_CONTENT_MODE_OPTIONS.map(
                (item) => `
                  <option value="${escapeHtml(item.id)}" ${item.id === runContentModeMeta.id ? 'selected' : ''}>
                    ${escapeHtml(item.label)}
                  </option>
                `,
              ).join('')}
            </select>
          </label>
          <label>
            <span>本次备份目标</span>
            <select name="backupRunDestination">
              ${SYSTEM_BACKUP_TARGET_OPTIONS.map(
                (item) => `
                  <option value="${escapeHtml(item.id)}" ${item.id === runTargetMeta.id ? 'selected' : ''}>
                    ${escapeHtml(item.label)}
                  </option>
                `,
              ).join('')}
            </select>
          </label>
        </div>
        <div class="form-actions backup-run-actions">
          <button class="button" type="button" data-action="run-backup" ${activeRunTarget ? 'disabled' : ''}>
            ${activeRunTarget ? '立即执行中...' : '立即执行'}
          </button>
        </div>
        ${
          runTargetMeta.id !== 'local' && storageMeta.id === 'local'
            ? '<div class="notice info">当前备份目标包含远程存储，但系统存储方式仍是“本地附件目录”。如果要把备份上传到远程，请先到“系统设置 -> 附件与远程存储”里切换并保存远程存储配置。</div>'
            : ''
        }
      </article>

      <article class="panel system-panel backup-restore-panel">
        <div class="panel-header">
          <div>
            <h3>系统还原</h3>
            <p>上传系统导出的 ZIP 备份数据包，可按下方模式选择仅导入数据库、仅导入网站附件，或完整恢复全部网站数据。恢复前会自动生成一份安全备份。</p>
          </div>
        </div>
        <div class="backup-restore-upload-shell">
          <label class="button ghost backup-restore-upload-button">
            ${renderAutoIcon('upload', '选择还原包', 'button-icon')}
            <span>${restoreFilename ? '重新选择还原包' : '选择还原包 ZIP'}</span>
            <input
              name="backupRestoreFile"
              type="file"
              accept=".zip,application/zip,application/x-zip-compressed"
            />
          </label>
          <div class="backup-restore-selected-file">
            <strong>${escapeHtml(restoreFilename || '尚未选择备份包')}</strong>
            <p>建议直接上传系统“备份记录”里下载的 ZIP 文件。还原期间会暂停邮箱同步，避免数据库和附件在恢复时发生写入冲突；若选择“全部网站数据”，会按备份包内的数据完整覆盖当前系统。</p>
          </div>
        </div>
        <div class="backup-restore-control-row">
          <label class="backup-restore-mode-field">
            <span>还原内容</span>
            <select name="backupRestoreMode">
              ${SYSTEM_BACKUP_RESTORE_MODE_OPTIONS.map(
                (item) => `
                  <option value="${escapeHtml(item.id)}" ${item.id === restoreModeMeta.id ? 'selected' : ''}>
                    ${escapeHtml(item.label)}
                  </option>
                `,
              ).join('')}
            </select>
            <small>
              ${
                restoreModeMeta.id === 'database_only'
                  ? '仅覆盖当前系统数据库，适合账号、邮件记录和配置数据迁移。'
                  : restoreModeMeta.id === 'attachments_only'
                    ? '仅覆盖本地附件目录，不改动数据库、日志和 .env 配置。'
                    : '按备份包内包含的数据完整恢复当前系统，默认推荐使用这个模式。'
              }
            </small>
          </label>
          <div class="form-actions backup-restore-actions">
            <button
              class="button"
              type="button"
              data-action="restore-backup"
              ${restoreFilename && !restoreLoading ? '' : 'disabled'}
            >
              ${restoreLoading ? '系统还原中...' : '开始系统还原'}
            </button>
          </div>
        </div>
        <div class="notice info">
          还原会按你选择的内容覆盖当前系统数据。若本次还原涉及数据库，当前后台会退出登录；若本次还原涉及 .env 配置，请在还原完成后手动重启服务。
        </div>
      </article>

      <article class="panel system-panel">
        <div class="panel-header">
          <div>
            <h3>备份记录</h3>
            <p>展示最近执行过的备份结果。失败记录也会保留，方便直接排查。</p>
          </div>
        </div>
        <div class="backup-record-list">
          ${
            backupRecords.length
              ? backupRecords
                  .map((backup) => renderBackupRecordRow(backup, deletingBackupId))
                  .join('')
              : '<div class="empty-card">当前还没有备份记录。先点上面的按钮执行一次，就会在这里看到本地下载入口和远程路径。</div>'
          }
        </div>
      </article>
    </section>
  `;
}

function renderSystemSettingsNav(items = [], activeId = 'general') {
  return `
    <div class="system-settings-nav">
      <div class="system-settings-nav-track" role="tablist" aria-label="系统设置分组">
        ${items
          .map(
            (item) => `
              <button
                class="system-settings-nav-button ${item.id === activeId ? 'is-active' : ''}"
                type="button"
                id="system-settings-tab-${escapeHtml(item.id)}"
                role="tab"
                aria-selected="${item.id === activeId ? 'true' : 'false'}"
                aria-controls="system-settings-group-${escapeHtml(item.id)}"
                data-action="switch-system-settings-group"
                data-group="${escapeHtml(item.id)}"
              >
                ${renderAutoIcon(item.icon || item.id, item.label, 'system-settings-nav-icon')}
                <span>${escapeHtml(item.label)}</span>
              </button>
            `,
          )
          .join('')}
      </div>
    </div>
  `;
}

function renderSystemSettingsGroupSection(id, title, description, panels = [], options = {}) {
  const iconKey = String(options.icon || 'system').trim() || 'system';
  const featureChips = Array.isArray(options.featureChips) ? options.featureChips.filter(Boolean) : [];
  const groupBadge = String(options.badge || '').trim();
  const labelledBy = String(options.labelledBy || `system-settings-tab-${id}`).trim();

  return `
    <section
      class="system-settings-group"
      id="system-settings-group-${escapeHtml(id)}"
      role="tabpanel"
      aria-labelledby="${escapeHtml(labelledBy)}"
    >
      <div class="system-settings-group-header">
        <div class="system-settings-group-title">
          ${renderAutoIcon(iconKey, title, 'system-settings-group-icon')}
          <div class="system-settings-group-copy">
            <h3>${escapeHtml(title)}</h3>
            <p>${escapeHtml(description)}</p>
          </div>
        </div>
        ${groupBadge ? `<span class="tag subtle system-settings-group-badge">${escapeHtml(groupBadge)}</span>` : ''}
      </div>
      ${
        featureChips.length
          ? `
            <div class="system-settings-group-feature-list">
              ${featureChips
                .map(
                  (chip) => `
                    <span class="system-settings-group-feature-pill">${escapeHtml(chip)}</span>
                  `,
                )
                .join('')}
            </div>
          `
          : ''
      }
      <div class="system-settings-group-panels">
        ${panels.join('')}
      </div>
    </section>
  `;
}

function resolveActiveSystemSettingsGroup(items = [], requestedId = 'general') {
  const normalizedRequestedId = String(requestedId || '').trim();
  return items.find((item) => item.id === normalizedRequestedId) || items[0] || null;
}

function renderSystemSettings(state) {
  const settings = normalizeSystemSettings(state.systemSettingsDraft || state.systemSettings);
  const activeTheme = systemThemePresetMeta(settings.themePresetId);
  const logoLocalPathPreview = systemLogoPathPreview(settings);
  const logoLocalPathHint = systemLogoPathHint(settings);
  const googleCallbackUrl =
    typeof window !== 'undefined'
      ? `${window.location.origin}/api/oauth/google/callback`
      : 'http://localhost:52080/api/oauth/google/callback';
  const googleAlternateCallbackUrl = googleCallbackUrl.includes('127.0.0.1')
    ? googleCallbackUrl.replace('127.0.0.1', 'localhost')
    : googleCallbackUrl.includes('localhost')
      ? googleCallbackUrl.replace('localhost', '127.0.0.1')
      : '';
  const microsoftCallbackUrl =
    typeof window !== 'undefined'
      ? `${window.location.origin}/api/oauth/microsoft/callback`
      : 'http://localhost:52080/api/oauth/microsoft/callback';
  const microsoftAlternateCallbackUrl = microsoftCallbackUrl.includes('127.0.0.1')
    ? microsoftCallbackUrl.replace('127.0.0.1', 'localhost')
    : microsoftCallbackUrl.includes('localhost')
      ? microsoftCallbackUrl.replace('localhost', '127.0.0.1')
      : '';
  const googleGuideMarkup = state.systemGoogleGuideOpen
    ? renderSystemGoogleGuideModal(googleCallbackUrl, googleAlternateCallbackUrl)
    : '';
  const microsoftGuideMarkup = state.systemMicrosoftGuideOpen
    ? renderSystemMicrosoftGuideModalV2(microsoftCallbackUrl, microsoftAlternateCallbackUrl)
    : '';
  const systemGroupNavItems = [
    { id: 'general', label: '通用设置', icon: 'system' },
    { id: 'access', label: '账号安全', icon: 'users' },
    { id: 'oauth', label: 'OAuth 应用', icon: 'users' },
    { id: 'gateway', label: '网关服务', icon: 'storage' },
    { id: 'metadata', label: '元数据设置', icon: 'attachments' },
    { id: 'content', label: '邮件增强', icon: 'mail' },
  ];
  const brandPanel = `
    <article class="panel system-panel" data-icon="system">
      <div class="panel-header">
        <div>
          <h3>站点品牌</h3>
          <p>这里统一管理站点名称、品牌 Logo 和浏览器标签页 icon。自动模式会生成本地图标，自定义图片会缓存到系统目录。</p>
        </div>
        <span class="tag">${escapeHtml(systemLogoModeLabel(settings.logoMode))}</span>
      </div>
      <div class="system-brand-preview-card">
        ${renderBrandAvatar(settings, 'system-brand-preview-avatar', `${settings.siteName} logo`, { preferDraftUrl: true })}
        <div class="system-brand-preview-copy">
          <strong>${escapeHtml(settings.siteName)}</strong>
          <p>${escapeHtml(systemLogoModeLabel(settings.logoMode))} / 标签页 icon 同步更新</p>
        </div>
      </div>
      <div class="stack">
        <label>
          <span>站点名称</span>
          <input name="siteName" value="${escapeHtml(settings.siteName)}" placeholder="例如：Mail Union" required />
        </label>
        <div class="system-choice-grid system-choice-grid-logo">
          <label class="system-choice-card">
            <input type="radio" name="logoMode" value="auto" ${settings.logoMode === 'auto' ? 'checked' : ''} />
            <span>
              <strong>系统默认 Logo</strong>
              <small>使用内置品牌 Logo，并同步作为网页顶部 icon。</small>
            </span>
          </label>
          <label class="system-choice-card">
            <input type="radio" name="logoMode" value="url" ${settings.logoMode === 'url' ? 'checked' : ''} />
            <span>
              <strong>直链图片</strong>
              <small>填写公开图片链接后，系统会缓存到本地并同步作为网页顶部 icon。</small>
            </span>
          </label>
          <label class="system-choice-card">
            <input type="radio" name="logoMode" value="upload" ${settings.logoMode === 'upload' ? 'checked' : ''} />
            <span>
              <strong>本地上传</strong>
              <small>直接上传本地 Logo 图片，系统会保存到本地目录并同步作为网页顶部 icon。</small>
            </span>
          </label>
        </div>
        <label>
          <span>Logo 直链</span>
          <input name="logoUrl" type="url" value="${escapeHtml(settings.logoUrl || '')}" placeholder="https://example.com/logo.png" />
        </label>
        <div class="system-upload-row">
          <label class="system-upload-path-field">
            <span>Logo 本地路径</span>
            <input
              type="text"
              value="${escapeHtml(logoLocalPathPreview)}"
              placeholder="上传并保存后，这里会显示系统中的实际文件路径"
              readonly
            />
          </label>
          <div class="system-upload-action-field">
            <span>上传图片</span>
            <label class="button ghost system-upload-button">
              ${renderAutoIcon('upload', '上传图片', 'button-icon')}
              <span>上传本地 Logo</span>
              <input
                name="logoUploadFile"
                type="file"
                accept=".png,.jpg,.jpeg,.webp,.gif,.svg,.ico,image/png,image/jpeg,image/webp,image/gif,image/svg+xml,image/x-icon"
              />
            </label>
          </div>
        </div>
        <div class="system-upload-help">${escapeHtml(logoLocalPathHint)}</div>
      </div>
      <div class="notice info">系统文件目录已启用：Logo / icon 会存到 <code>runtime/files/icons</code>，邮件图片会进 <code>runtime/files/images</code>，音频会进 <code>runtime/files/audio</code>，其他附件会进 <code>runtime/files/attachments</code>。</div>
      <div class="form-actions system-panel-actions">
        <button class="button" type="button" data-action="save-brand-system-settings">保存站点品牌</button>
      </div>
    </article>
  `;
  const themePanel = `
    <article class="panel system-panel" data-icon="theme-dark">
      <div class="panel-header">
        <div>
          <h3>主题模板</h3>
          <p>这里预置了 6 套不同气质的后台主题，其中“极光雾玻”是带雾化玻璃效果的模板。</p>
        </div>
        <span class="tag">${escapeHtml(activeTheme.name)}</span>
      </div>
      <div class="system-theme-grid">
        ${renderSystemThemePresetCards(activeTheme.id)}
      </div>
      <div class="system-theme-current">
        <strong>当前模板：${escapeHtml(activeTheme.name)}</strong>
        <p>${escapeHtml(activeTheme.description)}</p>
      </div>
      <div class="form-actions system-panel-actions">
        <button class="button" type="button" data-action="save-theme-system-settings">保存主题模板</button>
      </div>
    </article>
  `;
  const systemGroupSections = [
    {
      id: 'general',
      title: '通用设置',
      description: '统一管理站点品牌、网页图标、后台主题和后台登录时长。',
      icon: 'system',
      featureChips: ['站点品牌', '本地 Logo / icon', '主题模板', '登录时长'],
      panels: [brandPanel, themePanel, renderSystemSessionTimeoutPanel(settings)],
    },
    {
      id: 'access',
      title: '账号安全',
      description: '统一管理普通用户注册、邮箱验证码、找回密码和系统 SMTP 发信配置。',
      icon: 'users',
      featureChips: ['注册开关', '邮箱验证码', '找回密码', 'SMTP 发信'],
      panels: [
        renderSystemAuthConfigPanel(state, settings),
        renderSystemSmtpConfigPanel(state, settings),
      ],
    },
    {
      id: 'oauth',
      title: 'OAuth 应用',
      description: '把 Gmail 和 Outlook 的系统级授权配置收拢到同一个区域，后续新增邮箱时直接复用。',
      icon: 'users',
      featureChips: ['Google OAuth', 'Microsoft OAuth', '回调地址', '授权教程'],
      panels: [
        renderSystemGoogleConfigPanel(state, settings, googleCallbackUrl, googleAlternateCallbackUrl),
        renderSystemMicrosoftConfigPanel(state, settings, microsoftCallbackUrl, microsoftAlternateCallbackUrl),
      ],
    },
    {
      id: 'gateway',
      title: '网关服务',
      description: '统一管理外网代理，方便排查 OAuth、通知和外部服务联通问题。',
      icon: 'storage',
      featureChips: ['外网代理', '联通检查', '第三方接口'],
      panels: [renderSystemProxyConfigPanel(state, settings)],
    },
    {
      id: 'metadata',
      title: '元数据设置',
      description: '集中管理附件存储策略、远程同步方式以及邮件附件元数据预览。',
      icon: 'attachments',
      featureChips: ['附件策略', '远程存储', '附件预览', '元数据列表'],
      panels: [
        renderSystemStorageConfigPanel(state, settings),
        renderAttachmentMetadataPanel(state),
      ],
    },
    {
      id: 'content',
      title: '邮件增强',
      description: '收拢翻译与内容处理相关配置，避免零散分布在不同卡片里。',
      icon: 'mail',
      featureChips: ['邮件翻译', '目标语言', '第三方翻译引擎'],
      panels: [renderSystemTranslationConfigPanel(state, settings)],
    },
  ];
  const activeGroup = resolveActiveSystemSettingsGroup(
    systemGroupSections,
    state.systemSettingsGroup || 'general',
  );

  return `
    <section class="view-grid view-grid-system">
      <div class="system-settings-shell">
        ${renderSystemSettingsNav(systemGroupNavItems, activeGroup?.id || 'general')}
        <form data-form="system-settings" class="system-settings-form">
          ${
            activeGroup
              ? renderSystemSettingsGroupSection(
                  activeGroup.id,
                  activeGroup.title,
                  activeGroup.description,
                  activeGroup.panels,
                  {
                    icon: activeGroup.icon,
                    badge: `${activeGroup.panels.length} 个功能块`,
                    featureChips: activeGroup.featureChips,
                    labelledBy: `system-settings-tab-${activeGroup.id}`,
                  },
                )
              : ''
          }
        </form>
      </div>
      ${googleGuideMarkup}
      ${microsoftGuideMarkup}
    </section>
  `;
}

function elementIndex(element, selector) {
  if (!element?.parentElement) {
    return -1;
  }

  return Array.from(element.parentElement.children)
    .filter((entry) => entry.matches(selector))
    .indexOf(element);
}

function resolveHeaderIconKey(header) {
  const panel = header.closest('.panel, .modal-panel');
  const section = header.closest('section');

  if (header.closest('.mailbox-modal')) {
    return 'mailboxes';
  }

  if (section?.classList.contains('view-grid-dashboard')) {
    const panelIndex = elementIndex(panel, '.panel');
    if (panelIndex === 1) {
      return 'recent';
    }

    if (panelIndex === 2) {
      return 'mailboxes';
    }

    return 'dashboard';
  }

  if (section?.classList.contains('view-grid-inbox')) {
    return elementIndex(panel, '.panel') === 0 ? 'inbox' : 'mail';
  }

  if (section?.classList.contains('view-grid-mailboxes')) {
    return 'mailboxes';
  }

  if (section?.classList.contains('view-grid-users')) {
    return 'users';
  }

  if (section?.classList.contains('view-grid-profile')) {
    return elementIndex(panel, '.panel') === 0 ? 'profile' : 'users';
  }

  if (section?.classList.contains('view-grid-system')) {
    return panel?.dataset.icon || ['system', 'theme-dark'][elementIndex(panel, '.panel')] || 'system';
  }

  if (section?.classList.contains('view-grid-notifications')) {
    if (panel?.classList.contains('tool-panel')) {
      const toolPanels = Array.from(section.querySelectorAll('.tool-panel'));
      return ['tool', 'notes'][toolPanels.indexOf(panel)] || 'tool';
    }

    if (panel?.closest('.notification-card-grid')) {
      return panel?.dataset.icon || 'notifications';
    }

    return 'notifications';
  }

  return resolveAutoIconKey(header.dataset.icon || panel?.dataset.icon || header.textContent, header.textContent);
}

function hydrateAutoIcons(root) {
  root.querySelectorAll('.panel-header').forEach((header) => {
    const intro = header.firstElementChild;
    if (!intro || intro.classList.contains('section-title') || intro.tagName !== 'DIV') {
      return;
    }

    intro.outerHTML = renderSectionTitle(resolveHeaderIconKey(header), intro.innerHTML);
  });
}

function renderPublicFeatureCard(iconKey, title, text, pills = []) {
  return `
    <article class="public-home-feature-card">
      <div class="public-home-feature-head">
        ${renderAutoIcon(iconKey, title, 'public-home-feature-icon')}
        <div class="public-home-card-copy">
          <h3>${escapeHtml(title)}</h3>
          <p>${escapeHtml(text)}</p>
        </div>
      </div>
      <div class="public-home-card-pills">
        ${pills.map((pill) => `<span class="public-home-card-pill">${escapeHtml(pill)}</span>`).join('')}
      </div>
    </article>
  `;
}

function renderPublicWorkflowStep(step, title, text) {
  return `
    <article class="public-home-step-card">
      <span class="public-home-step-index">${escapeHtml(step)}</span>
      <h3>${escapeHtml(title)}</h3>
      <p>${escapeHtml(text)}</p>
    </article>
  `;
}

function renderPublicIntegrationPill(content, note = '') {
  return `
    <div class="public-home-integration-pill">
      <div class="public-home-integration-pill-main">${content}</div>
      ${note ? `<span>${escapeHtml(note)}</span>` : ''}
    </div>
  `;
}

function renderAuthPortal(state) {
  const systemSettings = normalizeSystemSettings(state.systemSettings);
  const allowRegister = Boolean(systemSettings.registrationEnabled);
  const allowForgot = Boolean(systemSettings.passwordResetEnabled);
  const authMode =
    state.authMode === 'forgot' && allowForgot
      ? 'forgot'
      : state.authMode === 'register' && allowRegister
        ? 'register'
        : 'login';
  const whitelist = Array.isArray(systemSettings.registrationEmailDomainWhitelist)
    ? systemSettings.registrationEmailDomainWhitelist
    : [];
  const sendCodeLoading =
    Boolean(state.authCodeSending)
    && ((authMode === 'register' && state.authCodePurpose === 'register')
      || (authMode === 'forgot' && state.authCodePurpose === 'reset'));

  return `
    ${renderGlobalNotice(state.notice)}
    <div class="login-shell auth-portal-shell">
      <div class="login-ambient login-ambient-a"></div>
      <div class="login-ambient login-ambient-b"></div>
      <section class="login-card auth-portal-card">
        <div class="login-copy public-auth-copy">
          <div class="auth-portal-head">
            <div class="login-brand-lockup">
              ${renderBrandAvatar(systemSettings, 'login-brand-avatar public-home-auth-avatar', `${systemSettings.siteName} logo`)}
              <div class="login-brand-copy public-auth-brand-copy">
                <p class="eyebrow">统一登录入口 /login</p>
                <h2>${escapeHtml(
                  authMode === 'forgot'
                    ? '通过邮箱找回密码'
                    : authMode === 'register'
                      ? '创建用户账号'
                      : '登录后台',
                )}</h2>
              </div>
            </div>
            <a class="auth-portal-home-button" href="/">返回首页</a>
          </div>
          <p>${escapeHtml(
            authMode === 'forgot'
              ? '输入登录用户名、联系邮箱和验证码后即可重置密码。'
              : authMode === 'register'
                ? '普通用户在这里创建账号后，等待管理员启用即可进入自己的后台。'
                : '所有账号都从这里登录；登录成功后系统会自动识别身份，并跳转到管理员后台或用户后台。',
          )}</p>
        </div>

        <div class="auth-switch" role="tablist" aria-label="认证模式切换">
          <button class="auth-switch-item ${authMode === 'login' ? 'active' : ''}" type="button" data-action="switch-auth-mode" data-mode="login">登录</button>
          ${allowRegister ? `<button class="auth-switch-item ${authMode === 'register' ? 'active' : ''}" type="button" data-action="switch-auth-mode" data-mode="register">注册</button>` : ''}
          ${allowForgot ? `<button class="auth-switch-item ${authMode === 'forgot' ? 'active' : ''}" type="button" data-action="switch-auth-mode" data-mode="forgot">找回密码</button>` : ''}
        </div>

        ${
          authMode === 'register'
            ? `
              <form data-form="register" class="stack">
                <label>
                  <span>昵称</span>
                  <input name="name" placeholder="例如：运营部" required />
                </label>
                <label>
                  <span>登录用户名</span>
                  <input name="username" placeholder="例如：zhangsan" required />
                </label>
                <label>
                  <span>联系邮箱${systemSettings.registrationEmailVerificationRequired || whitelist.length ? '' : '（可选）'}</span>
                  <input name="email" type="email" placeholder="例如：name@example.com" ${systemSettings.registrationEmailVerificationRequired || whitelist.length ? 'required' : ''} />
                </label>
                ${
                  systemSettings.registrationEmailVerificationRequired
                    ? `
                      <div class="inline-grid auth-portal-code-row">
                        <label>
                          <span>邮箱验证码</span>
                          <input name="emailCode" inputmode="numeric" placeholder="6 位验证码" required />
                        </label>
                        <div class="auth-portal-inline-actions">
                          <button class="button ghost" type="button" data-action="send-auth-email-code" data-purpose="register">
                            ${escapeHtml(sendCodeLoading ? '发送中...' : '发送验证码')}
                          </button>
                        </div>
                      </div>
                    `
                    : ''
                }
                <label>
                  <span>头像链接（可选）</span>
                  <input name="avatarUrl" type="url" placeholder="https://example.com/avatar.png" />
                </label>
                <label>
                  <span>登录密码</span>
                  <input name="password" type="password" placeholder="至少 4 位" required />
                </label>
                ${
                  whitelist.length
                    ? `<div class="notice info">允许注册的邮箱域名：${escapeHtml(whitelist.join('、'))}</div>`
                    : ''
                }
                <button class="button wide" type="submit">提交注册</button>
                <p class="login-form-foot">普通用户注册后默认处于停用状态，需要管理员启用并分配权限。</p>
              </form>
            `
            : authMode === 'forgot'
              ? `
                <form data-form="forgot-password" class="stack">
                  <label>
                    <span>登录用户名</span>
                    <input name="login" placeholder="请输入登录用户名" required />
                  </label>
                  <label>
                    <span>联系邮箱</span>
                    <input name="email" type="email" placeholder="请输入注册时填写的联系邮箱" required />
                  </label>
                  <div class="inline-grid auth-portal-code-row">
                    <label>
                      <span>邮箱验证码</span>
                      <input name="emailCode" inputmode="numeric" placeholder="6 位验证码" required />
                    </label>
                    <div class="auth-portal-inline-actions">
                      <button class="button ghost" type="button" data-action="send-auth-email-code" data-purpose="reset">
                        ${escapeHtml(sendCodeLoading ? '发送中...' : '发送验证码')}
                      </button>
                    </div>
                  </div>
                  <label>
                    <span>新密码</span>
                    <input name="password" type="password" placeholder="请输入新密码" required />
                  </label>
                  <button class="button wide" type="submit">重置密码</button>
                </form>
              `
              : `
                <form data-form="login" class="stack">
                  <label>
                    <span>登录用户名</span>
                    <input name="username" placeholder="请输入登录用户名" required />
                  </label>
                  <label>
                    <span>登录密码</span>
                    <input name="password" type="password" placeholder="请输入密码" required />
                  </label>
                  <button class="button wide" type="submit">进入系统</button>
                </form>
              `
        }
      </section>
    </div>
  `;
}

function renderLogin(state) {
  const systemSettings = normalizeSystemSettings(state.systemSettings);
  const providerPresets = Array.isArray(state.providers) ? state.providers : [];
  const portalEntryPath = state.user
    ? `${state.user.role === 'admin' ? '/gm' : '/user'}#${state.user.role === 'admin' ? 'dashboard' : 'inbox'}`
    : '/login';
  const featureCards = [
    {
      iconKey: 'mailboxes',
      title: '多邮箱统一管控',
      text: '集中接入 Gmail、Outlook、QQ、163 和通用 IMAP 邮箱，支持测试、启停、排序、批量删除和定时同步。',
      pills: ['OAuth2 / IMAP', '批量管理', '同步间隔'],
    },
    {
      iconKey: 'view',
      title: '原邮件 HTML 阅读',
      text: '后台详情和独立落地页默认保留原邮箱 HTML 排版，图片、链接、划线文字和移动端布局都尽量原样呈现。',
      pills: ['原样排版', '移动端适配', '完整落地页'],
    },
    {
      iconKey: 'notifications',
      title: '摘要通知 + 加密全文',
      text: 'Telegram、企业微信应用、企业微信机器人和飞书默认发送短摘要，点击“查看完整内容”打开带密钥的完整邮件。',
      pills: ['短摘要', '加密 token', '无需登录查看'],
    },
    {
      iconKey: 'translate',
      title: '邮件翻译与智能识别',
      text: '默认 Google 翻译，完整邮件页面可一键翻译，并识别验证码、订单、订阅、广告、垃圾邮件等类型。',
      pills: ['Google 翻译', '验证码高亮', '类型识别'],
    },
    {
      iconKey: 'telegram',
      title: '通知封面卡片',
      text: 'Telegram 和企业微信应用通知可切换封面模式，系统内置普通、验证码、垃圾、广告、订单、订阅六类默认封面。',
      pills: ['内置封面', '可开可关', '统一模板'],
    },
    {
      iconKey: 'backups',
      title: '附件、备份与迁移',
      text: '附件只保存本地已同步内容，备份支持数据库、网站数据和全部数据，导入备份包即可迁移或还原系统。',
      pills: ['附件分页', '全站备份', '导入还原'],
    },
  ];
  const workflow = [
    ['01', '集中接入邮箱', '按邮箱厂商选择 IMAP 或 OAuth2，单个添加、批量导入、连接测试和权限归属都能统一管理。'],
    ['02', '设置通知策略', '选择 Telegram、企业微信应用、企业微信机器人或飞书，统一摘要模板、封面和完整内容链接。'],
    ['03', '阅读、识别、翻译', '后台或通知链接都能打开完整 HTML 邮件，英文邮件可一键翻译并尽量保留原始排版。'],
    ['04', '备份迁移系统', '按数据库、附件或全站数据备份，也可以导入备份包完成系统还原和服务器迁移。'],
  ];
  const heroMetrics = [
    { value: 'HTML', label: '原邮件排版', note: '后台和落地页尽量保持原版' },
    { value: '6 类', label: '内置通知封面', note: '普通、验证码、订单、订阅等' },
    { value: '3 档', label: '备份还原模式', note: '数据库、网站数据或全站数据' },
  ];
  const coverCards = [
    ['verification-mail.png', '验证码邮件', '验证码高亮增强', '278531'],
    ['order-mail.png', '订单通知', '交易与物流提醒', '#12306'],
    ['subscription-mail.png', '订阅提醒', '续费与账单识别', 'Netflix'],
    ['marketing-mail.png', '广告邮件', '营销内容归类', 'Promo'],
    ['junk-mail.png', '垃圾邮件', '风险邮件标记', 'Risk'],
    ['standard-mail.png', '普通邮件', '日常邮件默认封面', 'Mail'],
  ];
  const accountRows = [
    ['gmail', 'work@company.com', '启用中', '5 分钟', '09:31'],
    ['outlook', 'service@shop.com', '启用中', '10 分钟', '09:28'],
    ['netease163', 'notice@platform.com', '启用中', '15 分钟', '09:20'],
    ['qq', 'support@brand.com', '启用中', '15 分钟', '09:16'],
    ['gmail', 'news@info.com', '禁用', '30 分钟', '未同步'],
  ];
  const notificationCards = [
    ['telegram', 'Telegram 机器人', '摘要通知 / 封面模式', '12 条未读'],
    ['wecom', '企业微信应用', '卡片消息 / 完整内容链接', '8 条未读'],
    ['wecom', '企业微信机器人', '群机器人摘要提醒', '6 条未读'],
    ['feishu', '飞书通知', 'Webhook / Sign Secret', '3 条未读'],
  ];
  const backupCards = [
    ['database_only', '仅备份数据库', '账号、邮件、通知配置和系统设置'],
    ['site_only', '仅备份网站数据', '附件、封面、上传资源和运行数据'],
    ['database_and_site', '备份数据库 + 网站数据', '迁移服务器或重装恢复时一键还原'],
  ];

  return `
    ${renderGlobalNotice(state.notice)}
    <div class="login-shell public-home-shell">
      <div class="login-ambient login-ambient-a"></div>
      <div class="login-ambient login-ambient-b"></div>
      <div class="public-home-orbit public-home-orbit-a"></div>
      <div class="public-home-orbit public-home-orbit-b"></div>
      <div class="public-home">
        <header class="public-home-header">
          <div class="public-home-brand">
            ${renderBrandAvatar(systemSettings, 'public-home-brand-avatar', `${systemSettings.siteName} logo`)}
            <div class="public-home-brand-copy">
              <strong>${escapeHtml(systemSettings.siteName)}</strong>
              <span>统一邮件管理后台</span>
            </div>
          </div>
          <div class="public-home-nav">
            <a class="public-home-nav-link" href="/legal/privacy">隐私政策</a>
            <a class="public-home-nav-link" href="/legal/terms">服务条款</a>
            <button class="button ghost public-home-nav-button" type="button" data-action="scroll-public-section" data-target="public-showcase">产品展示</button>
            <button class="button ghost public-home-nav-button" type="button" data-action="scroll-public-section" data-target="public-features">功能矩阵</button>
            <a class="button public-home-nav-button" href="${escapeHtml(portalEntryPath)}">${state.user ? '继续后台' : '进入后台'}</a>
          </div>
        </header>

        <section class="public-home-hero" id="public-home-top">
          <div class="public-home-hero-copy">
            <span class="public-home-badge">Unified Email Command Center</span>
            <div class="public-home-title-kicker">Mail Union</div>
            <h1>多邮箱统一管理后台</h1>
            <p class="public-home-lead">Mail Union系统管理邮件，只需一步，简单而高效！</p>
            <p>把不同邮箱集中到一个系统里，统一收信、阅读、翻译、通知、备份和附件管理。通知只发重点摘要，完整邮件通过加密链接打开，并尽量保持原邮箱 HTML 阅读效果。</p>
            <div class="public-home-feature-rail">
              ${[
                ['mailboxes', '多邮箱统一管理'],
                ['view', '原邮件 HTML 阅读'],
                ['notifications', '摘要通知 + 完整内容链接'],
                ['translate', '一键翻译邮件'],
                ['storage', '附件本地化管理'],
                ['backups', '备份与恢复'],
              ]
                .map(
                  ([iconKey, label]) => `
                    <div class="public-home-rail-item">
                      ${renderAutoIcon(iconKey, label, 'public-home-rail-icon')}
                      <strong>${escapeHtml(label)}</strong>
                    </div>
                  `,
                )
                .join('')}
            </div>
            <div class="public-home-metric-grid">
              ${heroMetrics
                .map(
                  (item) => `
                    <article class="public-home-metric-card">
                      <strong>${escapeHtml(item.value)}</strong>
                      <span>${escapeHtml(item.label)}</span>
                      <small>${escapeHtml(item.note)}</small>
                    </article>
                  `,
                )
                .join('')}
            </div>
          </div>

          <div class="public-home-hero-visual">
            <div class="public-home-preview-card">
              <div class="public-home-preview-bar">
                <div class="public-home-preview-dots" aria-hidden="true">
                  <span></span>
                  <span></span>
                  <span></span>
                </div>
                <div class="public-home-command-search">搜索邮件、发件人或主题</div>
                <span class="tag">管理员</span>
              </div>
              <div class="public-home-preview-layout">
                <aside class="public-home-preview-sidebar">
                  <div class="public-home-preview-nav-item is-active">
                    ${renderAutoIcon('mail', '收件箱', 'public-home-preview-nav-icon')}
                    <span>总览</span>
                  </div>
                  <div class="public-home-preview-nav-item">
                    ${renderAutoIcon('inbox', '收件箱', 'public-home-preview-nav-icon')}
                    <span>收件箱</span>
                  </div>
                  <div class="public-home-preview-nav-item">
                    ${renderAutoIcon('star', '已加星标', 'public-home-preview-nav-icon')}
                    <span>已加星标</span>
                  </div>
                  <div class="public-home-preview-nav-item">
                    ${renderAutoIcon('trash-bin', '垃圾邮件', 'public-home-preview-nav-icon')}
                    <span>垃圾邮件</span>
                  </div>
                  <div class="public-home-preview-divider"></div>
                  <div class="public-home-preview-nav-item">
                    ${renderAutoIcon('mailboxes', '邮箱账号', 'public-home-preview-nav-icon')}
                    <span>邮箱账号</span>
                  </div>
                  <div class="public-home-mailbox-mini">
                    <span>work@company.com</span><b>128</b>
                    <span>service@shop.com</span><b>86</b>
                    <span>support@brand.com</span><b>37</b>
                  </div>
                </aside>
                <div class="public-home-preview-content">
                  <div class="public-home-preview-stats">
                    <div class="public-home-preview-stat">
                      <strong>328</strong>
                      <span>今日收件</span>
                      <small>较昨日 +12%</small>
                    </div>
                    <div class="public-home-preview-stat">
                      <strong>126</strong>
                      <span>未读邮件</span>
                      <small>自动聚合</small>
                    </div>
                    <div class="public-home-preview-stat">
                      <strong>32</strong>
                      <span>验证码邮件</span>
                      <small>重点高亮</small>
                    </div>
                  </div>
                  <div class="public-home-preview-list">
                    <article class="public-home-preview-message is-unread">
                      <div>
                        <strong>Microsoft 验证码邮件</strong>
                        <p>验证码 <mark>278531</mark> 已识别，通知摘要更短，完整内容通过加密链接查看。</p>
                      </div>
                      <span>刚刚</span>
                    </article>
                    <article class="public-home-preview-message">
                      <div>
                        <strong>GitHub Security Alert</strong>
                        <p>英文邮件可一键翻译，仍尽量保留原始 HTML 排版、图片、按钮和链接。</p>
                      </div>
                      <span>2 分钟前</span>
                    </article>
                    <article class="public-home-preview-message">
                      <div>
                        <strong>系统备份完成</strong>
                        <p>数据库、网站附件或全站数据可按需导出，导入备份包即可还原迁移。</p>
                      </div>
                      <span>5 分钟前</span>
                    </article>
                  </div>
                </div>
              </div>
            </div>

            <div class="public-home-email-card public-home-email-card-main">
              <div class="public-home-email-card-head">
                <strong>Your verification code</strong>
                <span>验证码</span>
              </div>
              <div class="public-home-email-meta">
                <span>GitHub &lt;noreply@github.com&gt;</span>
                <span>09:31</span>
              </div>
              <div class="public-home-code-box">278531</div>
              <p>This code will expire in <mark>10 minutes</mark>. Do not share this code with anyone.</p>
            </div>

            <div class="public-home-float-card">
              <div class="public-home-float-card-head">
                ${renderAutoIcon('open', '加密链接', 'public-home-float-icon')}
                <div>
                  <strong>完整邮件链接已生成</strong>
                  <span>带加密 token，点开即可查看原邮件 HTML 内容</span>
                </div>
              </div>
              <div class="public-home-float-chip-grid">
                <span>不登录查看</span>
                <span>完整排版</span>
                <span>一键翻译</span>
                <span>短链接入口</span>
              </div>
            </div>
          </div>
        </section>

        <section class="public-home-showcase" id="public-showcase">
          <article class="public-home-poster-panel public-home-poster-mailboxes">
            <div class="public-home-poster-copy">
              <span class="eyebrow">Mailbox Management</span>
              <h2>多邮箱管理与同步</h2>
              <p>多个邮箱，一个后台统一接入。支持连接测试、启用禁用、编辑删除、排序、批量删除、单个同步、全部同步和后台定时同步。</p>
              <div class="public-home-poster-pills">
                <span>支持多个邮箱账号接入</span>
                <span>连接测试更省心</span>
                <span>单个 / 全部邮箱同步</span>
                <span>定时同步与间隔配置</span>
                <span>Microsoft 邮箱导入 / 授权能力</span>
              </div>
            </div>
            <div class="public-home-mailbox-board">
              <div class="public-home-board-head">
                <strong>邮箱账号管理</strong>
                <button type="button">+ 添加邮箱账号</button>
              </div>
              <div class="public-home-mailbox-stats">
                <div><span>邮箱总数</span><strong>24</strong></div>
                <div><span>启用中</span><strong>18</strong></div>
                <div><span>最后同步时间</span><strong>09:31</strong></div>
                <div><span>同步状态</span><strong>全部正常</strong></div>
              </div>
              <div class="public-home-mailbox-table">
                ${accountRows
                  .map(
                    ([provider, email, status, interval, syncedAt]) => `
                      <div class="public-home-mailbox-row">
                        ${renderMailboxProviderIcon(provider, providerPresets, 'public-home-table-provider-icon')}
                        <strong>${escapeHtml(email)}</strong>
                        <span class="${status === '禁用' ? 'is-off' : 'is-on'}">${escapeHtml(status)}</span>
                        <em>${escapeHtml(interval)}</em>
                        <b>${escapeHtml(syncedAt)}</b>
                      </div>
                    `,
                  )
                  .join('')}
              </div>
              <div class="public-home-sync-cards">
                <div><strong>单个邮箱同步</strong><span>选择指定邮箱，立即同步</span><button type="button">立即同步</button></div>
                <div><strong>一键同步全部邮箱</strong><span>对所有启用邮箱执行同步</span><button type="button">立即同步</button></div>
                <div><strong>定时同步任务</strong><span>后台自动执行，保持数据最新</span><button type="button">每 10 分钟</button></div>
              </div>
            </div>
          </article>

          <article class="public-home-showcase-card public-home-showcase-wide">
            <div class="public-home-showcase-copy">
              <span class="eyebrow">HTML Original Reading</span>
              <h2>统一收件箱与 HTML 原文阅读</h2>
              <p>邮件同步后进入统一收件箱，支持筛选、批量操作、状态更新和完整 HTML 阅读。每封邮件都可以生成独立加密落地页，无需登录即可查看指定邮件。</p>
              <div class="public-home-mini-list">
                <span>统一收件箱查看</span>
                <span>批量操作与状态更新</span>
                <span>原邮件 HTML 样式阅读</span>
                <span>完整邮件落地页</span>
              </div>
            </div>
            <div class="public-home-mail-reader">
              <div class="public-home-reader-toolbar">
                <span>全部账户</span>
                <span>全部状态</span>
                <span>2026-04-30</span>
              </div>
              <div class="public-home-reader-table">
                ${[
                  ['产品更新：Mail Union v2.1 发布', 'Mail Union 团队', '未读'],
                  ['会议邀请：Q2 项目复盘会', 'Alice Zhang', '已读'],
                  ['Your verification code', 'GitHub', '未读'],
                  ['账单已生成（2026年04月）', 'Billing Center', '已读'],
                  ['安全提醒：新的登录设备', 'Mail Security', '重要'],
                ]
                  .map(
                    ([subject, sender, status]) => `
                      <div class="public-home-reader-row">
                        <span></span>
                        <strong>${escapeHtml(subject)}</strong>
                        <em>${escapeHtml(sender)}</em>
                        <b>${escapeHtml(status)}</b>
                      </div>
                    `,
                  )
                  .join('')}
              </div>
              <div class="public-home-reader-landing">
                <div>
                  <strong>完整邮件落地页</strong>
                  <p>加密 token 访问，无需登录即可查看完整邮件。</p>
                </div>
                <code>https://mu.io/view/3f8a7c...</code>
              </div>
            </div>
          </article>

          <article class="public-home-showcase-card public-home-translate-showcase">
            <div class="public-home-showcase-copy">
              <span class="eyebrow">Translate & Classify</span>
              <h2>邮件翻译与智能识别</h2>
              <p>快速看懂英文邮件，验证码、订单、订阅、广告和垃圾邮件自动归类，重点内容在通知和页面里更醒目。</p>
            </div>
            <div class="public-home-translate-board">
              <div class="public-home-translate-pane">
                <span>原文（英语）</span>
                <strong>Your verification code</strong>
                <p>Please use the following <mark>code</mark> to verify your email address. This code will expire in <mark>10 minutes</mark>.</p>
                <div class="public-home-code-box small">278531</div>
              </div>
              <div class="public-home-translate-swap">↔</div>
              <div class="public-home-translate-pane">
                <span>译文（简体中文）</span>
                <strong>你的验证码</strong>
                <p>请使用以下验证码验证邮箱地址。该验证码将在 <mark>10 分钟</mark> 后过期。</p>
                <div class="public-home-code-box small">278531</div>
              </div>
            </div>
            <div class="public-home-classify-grid">
              ${[
                ['验证码', '278531', '高亮'],
                ['订单', '#12306', '高亮'],
                ['订阅', 'Netflix', '高亮'],
                ['广告', 'Amazon', '标记'],
                ['垃圾邮件', '可疑链接', '风险'],
              ]
                .map(
                  ([type, value, badge]) => `
                    <div>
                      <span>${escapeHtml(type)}</span>
                      <strong>${escapeHtml(value)}</strong>
                      <b>${escapeHtml(badge)}</b>
                    </div>
                  `,
                )
                .join('')}
            </div>
          </article>

          <article class="public-home-showcase-card public-home-cover-showcase">
            <div class="public-home-showcase-copy">
              <span class="eyebrow">Notification Covers</span>
              <h2>通知封面卡片统一标准风格</h2>
              <p>系统内置六张默认通知封面，后续清空数据库或上传开源版本，封面仍然作为系统自带资源保留。</p>
            </div>
            <div class="public-home-cover-grid">
              ${coverCards
                .map(
                  ([image, title, desc, badge]) => `
                    <div class="public-home-cover-card">
                      <img src="/assets/notification-covers/${escapeHtml(image)}" alt="${escapeHtml(title)}" loading="lazy" />
                      <div>
                        <strong>${escapeHtml(title)}</strong>
                        <span>${escapeHtml(desc)}</span>
                      </div>
                      <b>${escapeHtml(badge)}</b>
                    </div>
                  `,
                )
                .join('')}
            </div>
          </article>

          <article class="public-home-poster-panel public-home-poster-notifications">
            <div class="public-home-poster-copy">
              <span class="eyebrow">Notification Center</span>
              <h2>通知摘要、模板策略与完整内容链接</h2>
              <p>所有通知默认走“短摘要 + 查看完整内容”，避免 Telegram 和企业微信里出现长文本、乱码、链接混乱。想看完整邮件，直接点加密链接进入一比一 HTML 邮件页面。</p>
              <div class="public-home-poster-pills">
                <span>Telegram</span>
                <span>企业微信应用</span>
                <span>企业微信机器人</span>
                <span>飞书通知</span>
                <span>统一通知模板</span>
                <span>封面 / 普通模式切换</span>
              </div>
            </div>
            <div class="public-home-notification-stage">
              <div class="public-home-notification-grid">
                ${notificationCards
                  .map(
                    ([iconKey, title, desc, count], index) => `
                      <div class="public-home-notification-tile ${index === 1 ? 'is-featured' : ''}">
                        ${renderAutoIcon(iconKey, title, 'public-home-notification-icon')}
                        <div>
                          <strong>${escapeHtml(title)}</strong>
                          <span>${escapeHtml(desc)}</span>
                        </div>
                        <b>${escapeHtml(count)}</b>
                      </div>
                    `,
                  )
                  .join('')}
              </div>
              <div class="public-home-notification-message">
                <div class="public-home-notification-cover">
                  <img src="/assets/notification-covers/verification-mail.png" alt="验证码邮件通知封面" loading="lazy" />
                </div>
                <div class="public-home-notification-copy">
                  <span>摘要通知</span>
                  <strong>GitHub 验证码邮件</strong>
                  <p>验证码 278531，10 分钟后过期。点击下方按钮查看完整 HTML 邮件内容。</p>
                  <button type="button">查看完整内容</button>
                </div>
              </div>
            </div>
          </article>

          <article class="public-home-poster-panel public-home-poster-ops">
            <div class="public-home-poster-copy">
              <span class="eyebrow">Attachments / Backup / Security</span>
              <h2>附件本地化、备份还原与安全访问</h2>
              <p>附件默认不会无脑保存，只有手动同步到本地后才会展示。系统备份支持数据库、网站数据和全部网站数据，还原时可按类型导入，迁移服务器更稳。</p>
              <div class="public-home-poster-pills">
                <span>只显示本地附件</span>
                <span>同步已勾选邮箱附件</span>
                <span>附件分页浏览</span>
                <span>数据库 / 网站数据备份</span>
                <span>导入备份包还原</span>
                <span>后台登录有效期</span>
              </div>
            </div>
            <div class="public-home-ops-board">
              <div class="public-home-attachment-panel">
                <strong>本地附件</strong>
                <div class="public-home-attachment-list">
                  <span>receipt.pdf <b>245 KB</b></span>
                  <span>invoice-2026.xlsx <b>82 KB</b></span>
                  <span>contract.zip <b>1.8 MB</b></span>
                </div>
                <div class="public-home-pagination-dots"><i></i><i></i><i></i><i></i></div>
              </div>
              <div class="public-home-backup-panel">
                <strong>备份与还原</strong>
                <div class="public-home-backup-options">
                  ${backupCards
                    .map(
                      ([mode, title, desc]) => `
                        <div>
                          <span>${escapeHtml(mode)}</span>
                          <strong>${escapeHtml(title)}</strong>
                          <p>${escapeHtml(desc)}</p>
                        </div>
                      `,
                    )
                    .join('')}
                </div>
              </div>
              <div class="public-home-security-panel">
                ${renderAutoIcon('open', '加密访问', 'public-home-security-icon')}
                <div>
                  <strong>加密链接安全访问</strong>
                  <p>每封邮件生成独立 token 链接，不登录也能查看指定邮件，链接不再只跳首页。</p>
                </div>
              </div>
            </div>
          </article>
        </section>

        <section class="public-home-section" id="public-features">
          <div class="public-home-section-head">
            <span class="eyebrow">Capability Matrix</span>
            <h2>系统能力矩阵</h2>
            <p>你的系统已经覆盖邮件接入、阅读、通知、附件、翻译、备份、权限和迁移，首页现在会把这些价值直接展示出来。</p>
          </div>
          <div class="public-home-feature-grid">
            ${featureCards
              .map((card) => renderPublicFeatureCard(card.iconKey, card.title, card.text, card.pills))
              .join('')}
          </div>
        </section>

        <section class="public-home-section" id="public-integrations">
          <div class="public-home-section-head">
            <span class="eyebrow">Integrations</span>
            <h2>邮箱、通知、附件和备份统一收拢</h2>
            <p>更适合做成你自己的邮件运营后台，不需要在多个客户端和配置页面之间来回切换。</p>
          </div>
          <div class="public-home-integration-grid">
            <article class="public-home-integration-card">
              <h3>邮箱接入</h3>
              <div class="public-home-integration-pill-grid">
                ${[
                  renderPublicIntegrationPill(
                    `${renderMailboxProviderIcon('gmail', providerPresets, 'public-home-provider-icon')}<strong>Gmail</strong>`,
                    'OAuth2 / IMAP',
                  ),
                  renderPublicIntegrationPill(
                    `${renderMailboxProviderIcon('outlook', providerPresets, 'public-home-provider-icon')}<strong>Outlook</strong>`,
                    'Graph / OAuth2 / IMAP',
                  ),
                  renderPublicIntegrationPill(
                    `${renderMailboxProviderIcon('qq', providerPresets, 'public-home-provider-icon')}<strong>QQ 邮箱</strong>`,
                    '授权码接入',
                  ),
                  renderPublicIntegrationPill(
                    `${renderMailboxProviderIcon('netease163', providerPresets, 'public-home-provider-icon')}<strong>163 邮箱</strong>`,
                    'IMAP 接入',
                  ),
                ].join('')}
              </div>
            </article>

            <article class="public-home-integration-card">
              <h3>通知渠道</h3>
              <div class="public-home-integration-pill-grid">
                ${[
                  renderPublicIntegrationPill(
                    `${renderAutoIcon('telegram', 'Telegram', 'public-home-provider-icon')}<strong>Telegram</strong>`,
                    '摘要通知 / 封面卡片 / 完整内容链接',
                  ),
                  renderPublicIntegrationPill(
                    `${renderAutoIcon('wecom', '企业微信', 'public-home-provider-icon')}<strong>企业微信</strong>`,
                    '应用通知 / 机器人通知 / 回调配置',
                  ),
                  renderPublicIntegrationPill(
                    `${renderAutoIcon('feishu', '飞书', 'public-home-provider-icon')}<strong>飞书</strong>`,
                    'Webhook URL（机器人地址） / Sign Secret（签名密钥）',
                  ),
                ].join('')}
              </div>
            </article>

            <article class="public-home-integration-card">
              <h3>系统能力</h3>
              <div class="public-home-integration-pill-grid">
                ${[
                  renderPublicIntegrationPill(
                    `${renderAutoIcon('translate', '翻译', 'public-home-provider-icon')}<strong>邮件翻译</strong>`,
                    '默认 Google 翻译，完整内容页一键翻译',
                  ),
                  renderPublicIntegrationPill(
                    `${renderAutoIcon('system', '系统设置', 'public-home-provider-icon')}<strong>主题与品牌</strong>`,
                    '站点名称、Logo、默认封面和主题模板',
                  ),
                  renderPublicIntegrationPill(
                    `${renderAutoIcon('backups', '系统备份', 'public-home-provider-icon')}<strong>备份与远程存储</strong>`,
                    '数据库 / 附件 / 全站数据备份与还原',
                  ),
                  renderPublicIntegrationPill(
                    `${renderAutoIcon('attachment', '附件管理', 'public-home-provider-icon')}<strong>附件管理</strong>`,
                    '本地同步、分页浏览、按邮箱手动同步',
                  ),
                ].join('')}
              </div>
            </article>
          </div>
        </section>

        <section class="public-home-section" id="public-workflow">
          <div class="public-home-section-head">
            <span class="eyebrow">Workflow</span>
            <h2>四步就能跑起来一套自己的统一邮箱系统</h2>
            <p>从接入邮箱到通知完整内容，再到附件同步和备份还原，常用流程已经尽量做顺。</p>
          </div>
          <div class="public-home-step-grid">
            ${workflow.map((item) => renderPublicWorkflowStep(item[0], item[1], item[2])).join('')}
          </div>
        </section>

        <footer class="public-home-footer">
          <span>${escapeHtml(systemSettings.siteName)}</span>
          <div class="public-home-footer-links">
            <a href="/legal/privacy">隐私政策</a>
            <a href="/legal/terms">服务条款</a>
          </div>
          <span>首页、登录注册、统一后台和完整邮件预览已经整合为同一个入口。</span>
        </footer>
      </div>
    </div>
  `;
}

function renderNotice(notice) {
  if (!notice) {
    return '';
  }

  return `<div class="notice ${escapeHtml(notice.tone)}">${escapeHtml(notice.text)}</div>`;
}

function renderGlobalNotice(notice) {
  if (!notice) {
    return '';
  }

  return `
    <div class="global-notice-layer" role="status" aria-live="polite" aria-atomic="true">
      <div class="global-notice-card">
        ${renderNotice(notice)}
      </div>
    </div>
  `;
}

function renderDashboard(state) {
  const stats = state.dashboard?.stats || {};
  const cards = [
    { label: '邮箱总数', value: stats.totalMailboxes ?? 0 },
    { label: '邮件总数', value: stats.totalMessages ?? 0 },
    { label: '未读邮件', value: stats.unreadMessages ?? 0 },
    { label: '异常邮箱', value: stats.errorMailboxes ?? 0 },
    ...(state.user.role === 'admin' ? [{ label: '启用用户', value: stats.activeUsers ?? 0 }] : []),
  ];

  return `
    <section class="view-grid view-grid-dashboard">
      <article class="panel hero-panel">
        <div>
          <p class="eyebrow">System Overview</p>
          <h2>管理邮件，只需一步，简单而高效！</h2>
          <p class="panel-copy">点击左侧菜单切换模块，每个功能都单独归位，界面会更干净。</p>
        </div>
        <button class="button" data-action="sync-all">同步当前可见邮箱</button>
      </article>
      <div class="stats-grid">
        ${cards
          .map(
            (card, index) => `
              <article class="stat-card">
                <div class="stat-card-head">
                  <p>${escapeHtml(card.label)}</p>
                  ${renderAutoIcon(['mailboxes', 'mail', 'unread', 'warning', 'users'][index] || card.label, card.label, 'stat-card-icon')}
                </div>
                <strong>${escapeHtml(card.value)}</strong>
              </article>
            `,
          )
          .join('')}
      </div>
      <article class="panel">
        <div class="panel-header"><div><h3>最近邮件</h3><p>最近同步到系统的邮件摘要。</p></div></div>
        <div class="mini-list">
          ${
            state.dashboard?.recentMessages?.length
              ? state.dashboard.recentMessages
                  .map(
                    (message) => `
                      <button class="mini-item" data-action="open-message" data-message-id="${escapeHtml(message.id)}">
                        <strong>${escapeHtml(message.subject)}</strong>
                        <p>${escapeHtml(message.fromName || message.fromAddress || '未知发件人')}</p>
                        <span>${formatDate(message.receivedAt)}</span>
                      </button>
                    `,
                  )
                  .join('')
              : '<div class="empty-card">暂时还没有邮件记录。</div>'
          }
        </div>
      </article>
      <article class="panel">
        <div class="panel-header"><div><h3>邮箱状态</h3><p>你当前可见的邮箱账户。</p></div></div>
        <div class="mini-list">
          ${
            state.dashboard?.recentMailboxes?.length
              ? state.dashboard.recentMailboxes
                  .map(
                    (mailbox) => `
                      <div class="mini-item static">
                        <strong>${escapeHtml(mailbox.name)}</strong>
                        <p>${escapeHtml(mailbox.email)}</p>
                        <span>${mailbox.unreadCount} 未读 / ${mailbox.messageCount} 封</span>
                      </div>
                    `,
                  )
                  .join('')
              : '<div class="empty-card">暂时还没有邮箱账户。</div>'
          }
        </div>
      </article>
    </section>
  `;
}

function groupMessagesByDay(messages) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const yesterday = today - 24 * 60 * 60 * 1000;
  const groups = [];
  const bucketMap = new Map();

  for (const message of messages || []) {
    const receivedAt = new Date(message.receivedAt);
    const currentDay = new Date(
      receivedAt.getFullYear(),
      receivedAt.getMonth(),
      receivedAt.getDate(),
    ).getTime();
    const label =
      currentDay >= today
        ? '今天'
        : currentDay >= yesterday
          ? '昨天'
          : new Intl.DateTimeFormat('zh-CN', {
              month: 'numeric',
              day: 'numeric',
            }).format(receivedAt);

    if (!bucketMap.has(label)) {
      const bucket = { label, messages: [] };
      bucketMap.set(label, bucket);
      groups.push(bucket);
    }

    bucketMap.get(label).messages.push(message);
  }

  return groups;
}

function renderInbox(state) {
  return `
    <section class="view-grid view-grid-inbox">
      <article class="panel inbox-toolbar">
        <div class="toolbar-grid">
          ${ownerFilter(state)}
          <label class="compact-field">
            <span>邮箱筛选</span>
            <select data-action="mailbox-filter">
              <option value="">全部邮箱</option>
              ${state.mailboxes
                .map(
                  (mailbox) => `
                    <option value="${escapeHtml(mailbox.id)}" ${mailbox.id === state.selectedMailboxId ? 'selected' : ''}>
                      ${escapeHtml(mailbox.name)} · ${escapeHtml(mailbox.email)}
                    </option>
                  `,
                )
                .join('')}
            </select>
          </label>
          <label class="compact-field grow">
            <span>搜索</span>
            <input data-action="search" value="${escapeHtml(state.search)}" placeholder="搜索标题、发件人、摘要" />
          </label>
          <div class="toolbar-actions">
            <button class="button ghost" data-action="refresh-inbox">刷新</button>
            <button class="button" data-action="sync-all">同步当前可见邮箱</button>
          </div>
        </div>
      </article>
      <article class="panel message-list-panel">
        <div class="panel-header"><div><h3>邮件列表</h3><p>${state.messages.length} 封结果</p></div></div>
        <div class="message-list">
          ${
            state.messages.length
              ? state.messages
                  .map(
                    (message) => `
                      <button class="message-item ${message.id === state.selectedMessageId ? 'active' : ''}" data-action="select-message" data-message-id="${escapeHtml(message.id)}">
                        <div class="message-topline">
                          <span class="tag">${escapeHtml(message.mailboxName || message.mailboxEmail)}</span>
                          <span>${formatDate(message.receivedAt)}</span>
                        </div>
                        <strong>${escapeHtml(message.subject)}</strong>
                        <p>${escapeHtml(message.fromName || message.fromAddress || '未知发件人')}</p>
                        <span>${escapeHtml(message.preview)}</span>
                        ${
                          state.user.role === 'admin'
                            ? `<small>${escapeHtml(message.ownerName || message.ownerEmail || '')}</small>`
                            : ''
                        }
                      </button>
                    `,
                  )
                  .join('')
              : '<div class="empty-card">当前筛选条件下没有邮件。</div>'
          }
        </div>
      </article>
      <article class="panel message-detail-panel">
        <div class="panel-header"><div><h3>邮件详情</h3><p>点击左侧邮件即可查看正文。</p></div></div>
        ${
          state.selectedMessage
            ? `
              <div class="detail-shell">
                <header class="detail-header">
                  <div><p class="eyebrow">主题</p><h2>${escapeHtml(state.selectedMessage.subject)}</h2></div>
                  <div class="detail-header-meta">
                    <span>${formatFullDate(state.selectedMessage.receivedAt)}</span>
                    <span>${state.selectedMessage.isRead ? '已读' : '未读'}</span>
                  </div>
                </header>
                <div class="detail-grid">
                  <div><p class="detail-label">发件人</p><p>${escapeHtml(state.selectedMessage.fromName || state.selectedMessage.fromAddress || '未知')}</p></div>
                  <div><p class="detail-label">所属邮箱</p><p>${escapeHtml(`${state.selectedMessage.mailboxName} · ${state.selectedMessage.mailboxEmail}`)}</p></div>
                </div>
                <section class="sub-panel">
                  <h3>正文</h3>
                  <pre>${escapeHtml(state.selectedMessage.textBody || state.selectedMessage.preview || '没有可显示的纯文本正文。')}</pre>
                </section>
              </div>
            `
            : '<div class="empty-card full-height">请选择一封邮件查看详情。</div>'
        }
      </article>
    </section>
  `;
}

function renderInboxView(state) {
  const folderItems = [
    { id: 'unread', label: '未读', count: state.messageFolderCounts?.unreadCount ?? 0 },
    { id: 'read', label: '已读', count: state.messageFolderCounts?.readCount ?? 0 },
    { id: 'starred', label: '星标邮件', count: state.messageFolderCounts?.starredCount ?? 0 },
    { id: 'all', label: '全部邮件', count: state.messageFolderCounts?.totalCount ?? 0 },
  ];
  const groupedMessages = groupMessagesByDay(state.messages);

  return `
    <section class="view-grid view-grid-inbox inbox-view">
      <article class="panel inbox-toolbar">
        <div class="panel-header">
          <div>
            <h3>收件箱分组</h3>
            <p>默认显示未读邮件，可切换到已读、星标或全部邮件。</p>
          </div>
        </div>
        <div class="inbox-folder-strip">
          ${folderItems
            .map(
              (folder) => `
                <button
                  class="inbox-folder-pill ${state.inboxFolder === folder.id ? 'active' : ''}"
                  type="button"
                  data-action="set-inbox-folder"
                  data-folder="${escapeHtml(folder.id)}"
                >
                  <span>${escapeHtml(folder.label)}</span>
                  <strong>${escapeHtml(folder.count)}</strong>
                </button>
              `,
            )
            .join('')}
        </div>
        <div class="toolbar-grid">
          ${ownerFilter(state)}
          <label class="compact-field">
            <span>邮箱筛选</span>
            <select data-action="mailbox-filter">
              <option value="">全部邮箱</option>
              ${state.mailboxes
                .map(
                  (mailbox) => `
                    <option value="${escapeHtml(mailbox.id)}" ${mailbox.id === state.selectedMailboxId ? 'selected' : ''}>
                      ${escapeHtml(mailbox.name)} · ${escapeHtml(mailbox.email)}
                    </option>
                  `,
                )
                .join('')}
            </select>
          </label>
          <label class="compact-field grow">
            <span>搜索</span>
            <input data-action="search" value="${escapeHtml(state.search)}" placeholder="搜索主题、发件人、摘要" />
          </label>
          <div class="toolbar-actions">
            <button class="button ghost" data-action="refresh-inbox">刷新</button>
            <button class="button" data-action="sync-all">同步当前可见邮箱</button>
          </div>
        </div>
      </article>
      <article class="panel message-list-panel">
        <div class="panel-header">
          <div>
            <h3>邮件列表</h3>
            <p>${state.messages.length} 封结果</p>
          </div>
        </div>
        <div class="message-list message-row-list">
          ${
            groupedMessages.length
              ? groupedMessages
                  .map(
                    (group) => `
                      <section class="message-group">
                        <div class="message-group-head">
                          <strong>${escapeHtml(group.label)}</strong>
                          <span>${escapeHtml(group.messages.length)} 封</span>
                        </div>
                        <div class="message-group-list">
                          ${group.messages
                            .map(
                              (message) => `
                                <article class="message-row ${message.id === state.selectedMessageId ? 'active' : ''} ${message.isRead ? 'is-read' : 'is-unread'}">
                                  <button
                                    class="message-star-toggle ${message.isStarred ? 'active' : ''}"
                                    type="button"
                                    data-action="toggle-message-star"
                                    data-message-id="${escapeHtml(message.id)}"
                                    title="${message.isStarred ? '取消星标' : '加入星标'}"
                                  >
                                    ${message.isStarred ? '&#9733;' : '&#9734;'}
                                  </button>
                                  <button
                                    class="message-item"
                                    type="button"
                                    data-action="select-message"
                                    data-message-id="${escapeHtml(message.id)}"
                                  >
                                    <div class="message-row-grid">
                                      <div class="message-row-primary">
                                        <div class="message-row-heading">
                                          <span class="message-row-sender">${escapeHtml(message.fromName || message.fromAddress || '未知发件人')}</span>
                                          <span class="message-row-subject">${escapeHtml(message.subject)}</span>
                                        </div>
                                        <span class="message-row-preview">${escapeHtml(message.preview || '暂无摘要')}</span>
                                      </div>
                                      <div class="message-row-meta">
                                        <span class="message-row-mailbox">${escapeHtml(message.mailboxName || message.mailboxEmail)}</span>
                                        ${
                                          state.user.role === 'admin' && (message.ownerName || message.ownerEmail)
                                            ? `<span class="message-row-owner">${escapeHtml(message.ownerName || message.ownerEmail)}</span>`
                                            : ''
                                        }
                                        <span class="message-row-date">${formatDate(message.receivedAt)}</span>
                                      </div>
                                    </div>
                                  </button>
                                </article>
                              `,
                            )
                            .join('')}
                        </div>
                      </section>
                    `,
                  )
                  .join('')
              : '<div class="empty-card">当前筛选条件下没有邮件。</div>'
          }
        </div>
      </article>
      <article class="panel message-detail-panel">
        <div class="panel-header">
          <div>
            <h3>邮件详情</h3>
            <p>点击左侧邮件后查看完整内容。</p>
          </div>
        </div>
        ${
          state.selectedMessage
            ? `
              <div class="detail-shell">
                <header class="detail-header">
                  <div>
                    <p class="eyebrow">主题</p>
                    <h2>${escapeHtml(state.selectedMessage.subject)}</h2>
                  </div>
                  <div class="detail-header-meta">
                    <button
                      class="tiny-button"
                      type="button"
                      data-action="translate-message"
                      data-message-id="${escapeHtml(state.selectedMessage.id)}"
                    >
                      ${state.messageTranslationLoadingId === state.selectedMessage.id ? '翻译中...' : state.messageTranslations?.[state.selectedMessage.id] ? '重新翻译' : '一键翻译'}
                    </button>
                    <button
                      class="tiny-button ${state.selectedMessage.isStarred ? 'active-star' : ''}"
                      type="button"
                      data-action="toggle-message-star"
                      data-message-id="${escapeHtml(state.selectedMessage.id)}"
                    >
                      ${state.selectedMessage.isStarred ? '已星标' : '设为星标'}
                    </button>
                    <span>${formatFullDate(state.selectedMessage.receivedAt)}</span>
                    <span>${state.selectedMessage.isRead ? '已读' : '未读'}</span>
                  </div>
                </header>
                <div class="detail-grid">
                  <div><p class="detail-label">发件人</p><p>${escapeHtml(state.selectedMessage.fromName || state.selectedMessage.fromAddress || '未知')}</p></div>
                  <div><p class="detail-label">所属邮箱</p><p>${escapeHtml(`${state.selectedMessage.mailboxName} · ${state.selectedMessage.mailboxEmail}`)}</p></div>
                </div>
                <section class="sub-panel">
                  <h3>正文</h3>
                  <pre>${escapeHtml(state.selectedMessage.textBody || state.selectedMessage.preview || '没有可显示的正文内容。')}</pre>
                </section>
                ${renderMessageTranslationSection(state, state.selectedMessage, { title: '翻译结果' })}
              </div>
            `
            : '<div class="empty-card full-height">点击左侧任意一封邮件后，在这里查看完整内容。</div>'
        }
      </article>
    </section>
  `;
}

function renderMessageTranslationSection(state, message, options = {}) {
  if (!message?.id) {
    return '';
  }

  const translation = state.messageTranslations?.[message.id] || null;
  const error = state.messageTranslationErrors?.[message.id] || '';
  const loading = state.messageTranslationLoadingId === message.id;
  const title = options.title || '邮件翻译';

  if (!translation && !error && !loading) {
    return '';
  }

  return `
    <section class="sub-panel message-translation-panel">
      <div class="message-translation-head">
        <h3>${escapeHtml(title)}</h3>
        ${
          translation
            ? `
              <div class="message-translation-meta">
                <span class="tag subtle">${escapeHtml(translation.providerLabel || '翻译引擎')}</span>
                <span>${escapeHtml(translation.targetLanguage || 'zh-CN')}</span>
                <span>${escapeHtml(formatFullDate(translation.generatedAt))}</span>
              </div>
            `
            : ''
        }
      </div>
      ${loading ? '<div class="notice info">正在翻译邮件内容，请稍候...</div>' : ''}
      ${error ? `<div class="notice error">${escapeHtml(error)}</div>` : ''}
      ${
        translation?.fallbackNotice
          ? `<div class="notice info">${escapeHtml(translation.fallbackNotice)}</div>`
          : ''
      }
      ${
        translation
          ? `
            ${
              translation.translatedSubject
                ? `
                  <div class="message-translation-subject">
                    <span>翻译主题</span>
                    <strong>${escapeHtml(translation.translatedSubject)}</strong>
                  </div>
                `
                : ''
            }
            ${
              translation.translatedBody
                ? renderFormattedMessageBody(translation.translatedBody, {
                    emptyText: '当前邮件没有可展示的正文翻译结果。',
                  })
                : '<div class="notice info">当前邮件没有可展示的正文翻译结果。</div>'
            }
          `
          : ''
      }
    </section>
  `;
}

function renderMessageReaderModal(state) {
  if (!state.messageReaderOpen || !state.selectedMessage) {
    return '';
  }

  const message = state.selectedMessage;
  const messageReaderScrollKey = `message-reader:${message.id}`;
  const ownerMeta =
    state.user.role === 'admin' && (message.ownerName || message.ownerEmail)
      ? `
          <div>
            <p class="detail-label">归属用户</p>
            <p>${escapeHtml(message.ownerName || message.ownerEmail)}</p>
          </div>
        `
      : '';

  return `
    <div class="modal-shell">
      <div class="modal-backdrop" data-message-reader-overlay></div>
      <section class="modal-panel message-reader-modal" data-preserve-scroll-key="${escapeHtml(messageReaderScrollKey)}">
        <div class="message-reader-head">
          <div class="message-reader-headline">
            <div class="message-reader-title">
              <p class="eyebrow">Message</p>
              <h3>${escapeHtml(message.subject || '（无主题）')}</h3>
              <p>主收件箱保持列表视图，完整邮件内容在这里单独查看。</p>
            </div>
            <div class="message-reader-top-actions">
              <button
                class="tiny-button"
                type="button"
                data-action="toggle-message-read"
                data-message-id="${escapeHtml(message.id)}"
                data-next-read="${message.isRead ? 'false' : 'true'}"
              >
                ${message.isRead ? '设为未读' : '标为已读'}
              </button>
              <button
                class="tiny-button ${message.isStarred ? 'active-star' : ''}"
                type="button"
                data-action="toggle-message-star"
                data-message-id="${escapeHtml(message.id)}"
              >
                ${message.isStarred ? '取消星标' : '设为星标'}
              </button>
              <button
                class="tiny-button danger"
                type="button"
                data-action="delete-current-message"
                data-message-id="${escapeHtml(message.id)}"
              >
                ${String(message.folderKind || '').toLowerCase() === 'trash' ? '彻底删除' : '删除邮件'}
              </button>
              <button class="button ghost" type="button" data-action="close-message-reader">关闭</button>
            </div>
          </div>
          <div class="message-reader-toolbar">
            <div class="message-reader-actions">
              <button
                class="tiny-button"
                type="button"
                data-action="translate-message"
                data-message-id="${escapeHtml(message.id)}"
              >
                ${state.messageTranslationLoadingId === message.id ? '翻译中...' : state.messageTranslations?.[message.id] ? '重新翻译' : '一键翻译'}
              </button>
            </div>
          </div>
        </div>
        <div class="detail-grid message-reader-meta">
          <div><p class="detail-label">发件人</p><p>${escapeHtml(message.fromName || message.fromAddress || '未知')}</p></div>
          <div><p class="detail-label">所属邮箱</p><p>${escapeHtml(`${message.mailboxName} / ${message.mailboxEmail}`)}</p></div>
          <div><p class="detail-label">接收时间</p><p>${escapeHtml(formatFullDate(message.receivedAt))}</p></div>
          <div><p class="detail-label">状态</p><p>${message.isRead ? '已读' : '未读'}</p></div>
          ${ownerMeta}
        </div>
        <section class="sub-panel message-reader-content">
          <h3>邮件正文</h3>
          ${renderOriginalMessageHtml(message, {
            emptyText: '暂无可显示的邮件正文。',
          })}
        </section>
        ${renderMessageAttachmentsSection(message)}
        ${renderMessageTranslationSection(state, message, { title: '翻译结果' })}
      </section>
    </div>
  `;
}

function renderInboxWorkspace(state) {
  const isTrashGroupActive = state.inboxFolder === 'trash' || state.inboxFolder === 'junk';
  const folderItems = [
    { id: 'all', label: '全部邮件', count: state.messageFolderCounts?.totalCount ?? 0 },
    { id: 'unread', label: '未读', count: state.messageFolderCounts?.unreadCount ?? 0 },
    { id: 'read', label: '已读', count: state.messageFolderCounts?.readCount ?? 0 },
    { id: 'starred', label: '星标邮件', count: state.messageFolderCounts?.starredCount ?? 0 },
    {
      id: 'trash-group',
      label: '垃圾箱',
      count: (state.messageFolderCounts?.trashCount ?? 0) + (state.messageFolderCounts?.junkCount ?? 0),
    },
  ];
  const trashFolderItems = [
    { id: 'trash', label: '已删除', count: state.messageFolderCounts?.trashCount ?? 0 },
    { id: 'junk', label: '垃圾邮件', count: state.messageFolderCounts?.junkCount ?? 0 },
  ];
  const groupedMessages = groupMessagesByDay(state.messages);
  const selectedMessageIds = new Set(state.selectedMessageIds || []);
  const allVisibleSelected =
    Boolean(state.messages.length) && state.messages.every((message) => selectedMessageIds.has(message.id));
  const selectionCount = selectedMessageIds.size;
  const messageListScrollKey = [
    'message-list',
    state.inboxFolder || 'all',
    state.selectedMailboxId || 'all',
    state.selectedOwnerUserId || 'all',
    String(state.search || '').trim() || 'none',
  ].join(':');
  const bulkDisabled = selectionCount ? '' : 'disabled';
  const inboxMailboxSearchTokens = tokenizeSearchQuery(state.inboxMailboxSearch);
  const inboxSelectedMailbox = state.selectedMailboxId
    ? state.mailboxes.find((mailbox) => mailbox.id === state.selectedMailboxId) || null
    : null;
  const inboxMailboxMatches = state.mailboxes.filter((mailbox) =>
    mailboxMatchesQuery(mailbox, inboxMailboxSearchTokens, state.providers),
  );
  const inboxMailboxOptions = mergeSelectedSearchOption(
    inboxMailboxMatches,
    inboxSelectedMailbox,
    inboxMailboxSearchTokens,
  );

  return `
    <section class="view-grid view-grid-inbox inbox-view">
      <article class="panel inbox-toolbar">
        <div class="panel-header">
          <div>
            <h3>收件箱分组</h3>
            <p>垃圾箱作为父分类，下面再细分为“已删除”和“垃圾邮件”。</p>
          </div>
        </div>
        <div class="inbox-folder-strip">
          ${folderItems
            .map((folder) => {
              const isActive = folder.id === 'trash-group' ? isTrashGroupActive : state.inboxFolder === folder.id;
              const targetFolder = folder.id === 'trash-group' ? 'trash' : folder.id;
              return `
                <button
                  class="inbox-folder-pill ${isActive ? 'active' : ''}"
                  type="button"
                  data-action="set-inbox-folder"
                  data-folder="${escapeHtml(targetFolder)}"
                >
                  <span>${escapeHtml(folder.label)}</span>
                  <strong>${escapeHtml(folder.count)}</strong>
                </button>
              `;
            })
            .join('')}
        </div>
        ${
          isTrashGroupActive
            ? `
              <div class="inbox-folder-substrip">
                ${trashFolderItems
                  .map(
                    (folder) => `
                      <button
                        class="inbox-folder-pill inbox-folder-subpill ${state.inboxFolder === folder.id ? 'active' : ''}"
                        type="button"
                        data-action="set-inbox-folder"
                        data-folder="${escapeHtml(folder.id)}"
                      >
                        <span>${escapeHtml(folder.label)}</span>
                        <strong>${escapeHtml(folder.count)}</strong>
                      </button>
                    `,
                  )
                  .join('')}
              </div>
            `
            : ''
        }
        <div class="toolbar-grid inbox-toolbar-grid">
          ${ownerFilter(state)}
          <div class="compact-field inbox-mailbox-filter-stack">
            <label class="compact-field">
              <span>邮箱筛选</span>
              <select data-action="mailbox-filter">
                <option value="">全部邮箱</option>
                ${
                  inboxMailboxOptions.length
                    ? inboxMailboxOptions
                        .map(
                          (mailbox) => `
                            <option value="${escapeHtml(mailbox.id)}" ${mailbox.id === state.selectedMailboxId ? 'selected' : ''}>
                              ${escapeHtml(mailbox.name)} / ${escapeHtml(mailbox.email)}
                            </option>
                          `,
                        )
                        .join('')
                    : '<option value="" disabled>没有匹配的邮箱</option>'
                }
              </select>
            </label>
            <label class="compact-field">
              <span>搜索邮箱</span>
              <input
                data-action="inbox-mailbox-search"
                value="${escapeHtml(state.inboxMailboxSearch || '')}"
                placeholder="模糊搜索邮箱名称、地址"
              />
            </label>
          </div>
          <label class="compact-field grow">
            <span>搜索邮件</span>
            <input data-action="search" value="${escapeHtml(state.search)}" placeholder="搜索主题、发件人、摘要" />
          </label>
          <div class="toolbar-actions inbox-toolbar-actions">
            <button class="button ghost" data-action="refresh-inbox">刷新</button>
            <button class="button" data-action="sync-all">同步当前可见邮箱</button>
          </div>
        </div>
      </article>
      <article class="panel message-list-panel message-list-panel-wide">
        <div class="panel-header">
          <div>
            <h3>邮件列表</h3>
            <p>${state.messages.length} 封结果</p>
          </div>
        </div>
        <div class="message-bulk-toolbar">
          <label class="message-select-all">
            <input
              type="checkbox"
              data-action="toggle-select-all-visible"
              ${allVisibleSelected ? 'checked' : ''}
              ${state.messages.length ? '' : 'disabled'}
            />
            <span>${selectionCount ? `已选 ${selectionCount} 封` : '全选当前列表'}</span>
          </label>
          <div class="message-bulk-actions">
            <button class="tiny-button" type="button" data-action="bulk-message-state" data-mode="read" ${bulkDisabled}>标为已读</button>
            <button class="tiny-button" type="button" data-action="bulk-message-state" data-mode="unread" ${bulkDisabled}>标为未读</button>
            <button class="tiny-button" type="button" data-action="bulk-message-state" data-mode="star" ${bulkDisabled}>加星</button>
            <button class="tiny-button" type="button" data-action="bulk-message-state" data-mode="unstar" ${bulkDisabled}>取消星标</button>
            <button class="tiny-button danger" type="button" data-action="bulk-delete-messages" ${bulkDisabled}>${state.inboxFolder === 'trash' ? '彻底删除' : '删除邮件'}</button>
          </div>
        </div>
        <div class="message-list message-row-list" data-preserve-scroll-key="${escapeHtml(messageListScrollKey)}">
          ${
            groupedMessages.length
              ? groupedMessages
                  .map(
                    (group) => `
                      <section class="message-group">
                        <div class="message-group-head">
                          <strong>${escapeHtml(group.label)}</strong>
                          <span>${escapeHtml(group.messages.length)} 封</span>
                        </div>
                        <div class="message-group-list">
                          ${group.messages
                            .map(
                              (message) => `
                                <article class="message-row ${state.messageReaderOpen && message.id === state.selectedMessageId ? 'active' : ''} ${selectedMessageIds.has(message.id) ? 'is-selected' : ''} ${message.isRead ? 'is-read' : 'is-unread'}">
                                  <label class="message-row-check">
                                    <input
                                      type="checkbox"
                                      data-action="toggle-message-select"
                                      data-message-id="${escapeHtml(message.id)}"
                                       ${selectedMessageIds.has(message.id) ? 'checked' : ''}
                                     />
                                   </label>
                                  <button
                                    class="message-item"
                                    type="button"
                                    data-action="select-message"
                                    data-message-id="${escapeHtml(message.id)}"
                                  >
                                    <div class="message-row-grid">
                                      <div class="message-row-primary">
                                        <div class="message-row-heading">
                                          ${message.isRead ? '' : '<span class="message-row-unread-dot"></span>'}
                                          <span class="message-row-sender">${escapeHtml(message.fromName || message.fromAddress || '未知发件人')}</span>
                                          <span class="message-row-subject">${escapeHtml(message.subject || '（无主题）')}</span>
                                        </div>
                                        <span class="message-row-preview">${escapeHtml(message.preview || '暂无摘要')}</span>
                                      </div>
                                      <div class="message-row-meta">
                                        <span class="message-row-mailbox">${escapeHtml(message.mailboxName || message.mailboxEmail)}</span>
                                        ${
                                          state.user.role === 'admin' && (message.ownerName || message.ownerEmail)
                                            ? `<span class="message-row-owner">${escapeHtml(message.ownerName || message.ownerEmail)}</span>`
                                            : ''
                                        }
                                        <span class="message-row-date">${formatDate(message.receivedAt)}</span>
                                      </div>
                                    </div>
                                  </button>
                                  <button
                                    class="message-star-toggle ${message.isStarred ? 'active' : ''}"
                                    type="button"
                                    data-action="toggle-message-star"
                                    data-message-id="${escapeHtml(message.id)}"
                                    title="${message.isStarred ? '取消星标' : '加入星标'}"
                                  >
                                    ${message.isStarred ? '&#9733;' : '&#9734;'}
                                  </button>
                                </article>
                              `,
                            )
                            .join('')}
                        </div>
                      </section>
                    `,
                  )
                  .join('')
              : '<div class="empty-card">当前筛选条件下没有邮件。</div>'
          }
        </div>
      </article>
    </section>
    ${renderMessageReaderModal(state)}
  `;
}

function renderInboxWorkspaceV2(state) {
  const isTrashGroupActive = state.inboxFolder === 'trash' || state.inboxFolder === 'junk';
  const folderItems = [
    { id: 'all', label: '\u5168\u90e8\u90ae\u4ef6', count: state.messageFolderCounts?.totalCount ?? 0 },
    { id: 'unread', label: '\u672a\u8bfb', count: state.messageFolderCounts?.unreadCount ?? 0 },
    { id: 'read', label: '\u5df2\u8bfb', count: state.messageFolderCounts?.readCount ?? 0 },
    { id: 'starred', label: '\u661f\u6807\u90ae\u4ef6', count: state.messageFolderCounts?.starredCount ?? 0 },
    {
      id: 'trash-group',
      label: '\u5783\u573e\u7bb1',
      count: (state.messageFolderCounts?.trashCount ?? 0) + (state.messageFolderCounts?.junkCount ?? 0),
    },
  ];
  const trashFolderItems = [
    { id: 'trash', label: '\u5df2\u5220\u9664', count: state.messageFolderCounts?.trashCount ?? 0 },
    { id: 'junk', label: '\u5783\u573e\u90ae\u4ef6', count: state.messageFolderCounts?.junkCount ?? 0 },
  ];
  const groupedMessages = groupMessagesByDay(state.messages);
  const selectedMessageIds = new Set(state.selectedMessageIds || []);
  const allVisibleSelected =
    Boolean(state.messages.length) && state.messages.every((message) => selectedMessageIds.has(message.id));
  const selectionCount = selectedMessageIds.size;
  const bulkDisabled = selectionCount ? '' : 'disabled';
  const inboxPagination = state.inboxPagination || {};
  const activeFolderTotal =
    state.inboxFolder === 'unread'
      ? Number(state.messageFolderCounts?.unreadCount || 0)
      : state.inboxFolder === 'read'
        ? Number(state.messageFolderCounts?.readCount || 0)
        : state.inboxFolder === 'starred'
          ? Number(state.messageFolderCounts?.starredCount || 0)
          : state.inboxFolder === 'trash'
            ? Number(state.messageFolderCounts?.trashCount || 0)
            : state.inboxFolder === 'junk'
              ? Number(state.messageFolderCounts?.junkCount || 0)
              : Number(state.messageFolderCounts?.totalCount || 0);
  const inboxOwnerSearchTokens = tokenizeSearchQuery(state.inboxOwnerSearch);
  const inboxSelectedOwner = state.selectedOwnerUserId
    ? state.users.find((user) => user.id === state.selectedOwnerUserId) || null
    : null;
  const inboxOwnerMatches = state.users.filter((user) => {
    if (!inboxOwnerSearchTokens.length) {
      return true;
    }

    const haystack = [
      user.name,
      user.username,
      user.email,
      formatUserHandle(user),
      formatUserContact(user),
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();

    return inboxOwnerSearchTokens.every((token) => haystack.includes(token));
  });
  const inboxOwnerOptions = mergeSelectedSearchOption(inboxOwnerMatches, inboxSelectedOwner, inboxOwnerSearchTokens);
  const inboxMailboxSearchTokens = tokenizeSearchQuery(state.inboxMailboxSearch);
  const inboxSelectedMailbox = state.selectedMailboxId
    ? state.mailboxes.find((mailbox) => mailbox.id === state.selectedMailboxId) || null
    : null;
  const inboxMailboxMatches = state.mailboxes.filter((mailbox) =>
    mailboxMatchesQuery(mailbox, inboxMailboxSearchTokens, state.providers),
  );
  const inboxMailboxOptions = mergeSelectedSearchOption(
    inboxMailboxMatches,
    inboxSelectedMailbox,
    inboxMailboxSearchTokens,
  );

  const renderMailboxFilter = () => {
    const totalMailboxCount = state.mailboxes.length;
    const triggerTitle =
      inboxSelectedMailbox?.name || inboxSelectedMailbox?.email || '\u5168\u90e8\u90ae\u7bb1';
    const triggerMeta = inboxSelectedMailbox
      ? mailboxProviderMeta(inboxSelectedMailbox.provider, state.providers).label
      : totalMailboxCount
        ? `${totalMailboxCount} \u4e2a\u90ae\u7bb1`
        : '\u6682\u65e0\u90ae\u7bb1';
    const mailboxOptionsMarkup = inboxMailboxOptions.length
      ? inboxMailboxOptions
          .map((mailbox) => {
            const providerLabel = mailboxProviderMeta(mailbox.provider, state.providers).label;
            const secondaryLine =
              mailbox.name && mailbox.name !== mailbox.email ? `${mailbox.email} / ${providerLabel}` : providerLabel;
            return `
              <button
                class="inbox-mailbox-option ${mailbox.id === inboxSelectedMailbox?.id ? 'is-active' : ''}"
                type="button"
                data-action="select-inbox-mailbox"
                data-mailbox-id="${escapeHtml(mailbox.id)}"
              >
                <span class="inbox-mailbox-option-main">
                  ${renderMailboxProviderIcon(mailbox.provider, state.providers, 'provider-icon-inline')}
                  <span class="inbox-mailbox-option-copy">
                    <strong>${escapeHtml(mailbox.name || mailbox.email || '\u672a\u547d\u540d\u90ae\u7bb1')}</strong>
                    <small>${escapeHtml(secondaryLine)}</small>
                  </span>
                </span>
                <span class="inbox-mailbox-option-meta">${escapeHtml(`${Number(mailbox.unreadCount || 0)} \u672a\u8bfb`)}</span>
              </button>
            `;
          })
          .join('')
      : `<div class="inbox-mailbox-empty">${escapeHtml('\u6ca1\u6709\u5339\u914d\u7684\u90ae\u7bb1')}</div>`;

    return `
      <label class="compact-field">
        <span>${escapeHtml('\u90ae\u7bb1\u7b5b\u9009')}</span>
        <div class="inbox-mailbox-filter ${state.inboxMailboxFilterOpen ? 'is-open' : ''}" data-inbox-mailbox-filter>
          <button
            class="inbox-mailbox-trigger"
            type="button"
            data-action="toggle-inbox-mailbox-filter"
            aria-expanded="${state.inboxMailboxFilterOpen ? 'true' : 'false'}"
          >
            <span class="inbox-mailbox-trigger-main">
              ${renderMailboxProviderIcon(inboxSelectedMailbox?.provider || 'all', state.providers, 'provider-icon-inline')}
              <span class="inbox-mailbox-trigger-copy">
                <strong>${escapeHtml(triggerTitle)}</strong>
              </span>
            </span>
            <span class="inbox-mailbox-trigger-side">
              <span class="inbox-mailbox-trigger-meta">${escapeHtml(triggerMeta)}</span>
              <span class="inbox-mailbox-trigger-caret" aria-hidden="true"></span>
            </span>
          </button>
          ${
            state.inboxMailboxFilterOpen
              ? `
                  <div class="inbox-mailbox-panel">
                    <label class="inbox-mailbox-search-shell">
                      <span class="inbox-mailbox-search-icon" aria-hidden="true">&#8981;</span>
                      <input
                        data-action="inbox-mailbox-search"
                        value="${escapeHtml(state.inboxMailboxSearch || '')}"
                        placeholder="${escapeHtml('\u641c\u7d22\u90ae\u7bb1\u540d\u79f0\u3001\u5730\u5740')}"
                        autocomplete="off"
                      />
                    </label>
                    <div class="inbox-mailbox-option-list">
                      <button
                        class="inbox-mailbox-option ${inboxSelectedMailbox ? '' : 'is-active'}"
                        type="button"
                        data-action="select-inbox-mailbox"
                        data-mailbox-id=""
                      >
                        <span class="inbox-mailbox-option-main">
                          ${renderMailboxProviderIcon('all', state.providers, 'provider-icon-inline')}
                          <span class="inbox-mailbox-option-copy">
                            <strong>${escapeHtml('\u5168\u90e8\u90ae\u7bb1')}</strong>
                            <small>${escapeHtml('\u663e\u793a\u5f53\u524d\u8303\u56f4\u5185\u7684\u5168\u90e8\u90ae\u7bb1')}</small>
                          </span>
                        </span>
                        <span class="inbox-mailbox-option-meta">${escapeHtml(`${totalMailboxCount} \u4e2a`)}</span>
                      </button>
                      ${mailboxOptionsMarkup}
                    </div>
                  </div>
                `
              : ''
          }
        </div>
      </label>
    `;
  };

  const renderOwnerFilter = () => {
    if (state.user.role !== 'admin') {
      return '';
    }

    const totalUserCount = state.users.length;
    const triggerTitle = inboxSelectedOwner?.name || '\u5168\u90e8\u7528\u6237';
    const triggerMeta = inboxSelectedOwner
      ? formatUserHandle(inboxSelectedOwner)
      : totalUserCount
        ? `${totalUserCount} \u4e2a\u7528\u6237`
        : '\u6682\u65e0\u7528\u6237';
    const ownerOptionsMarkup = inboxOwnerOptions.length
      ? inboxOwnerOptions
          .map((user) => `
              <button
                class="inbox-mailbox-option ${user.id === inboxSelectedOwner?.id ? 'is-active' : ''}"
                type="button"
                data-action="select-inbox-owner"
                data-user-id="${escapeHtml(user.id)}"
              >
                <span class="inbox-mailbox-option-main">
                  ${renderAvatar(user.avatarUrl, userInitials(user), 'filter-user-avatar', user.name || user.username || 'user')}
                  <span class="inbox-mailbox-option-copy">
                    <strong>${escapeHtml(user.name || user.username || '\u672a\u547d\u540d\u7528\u6237')}</strong>
                    <small>${escapeHtml(formatUserHandle(user))}</small>
                  </span>
                </span>
                <span class="inbox-mailbox-option-meta">${escapeHtml(user.role === 'admin' ? '\u7ba1\u7406\u5458' : '\u7528\u6237')}</span>
              </button>
            `)
          .join('')
      : `<div class="inbox-mailbox-empty">${escapeHtml('\u6ca1\u6709\u5339\u914d\u7684\u7528\u6237')}</div>`;

    return `
      <label class="compact-field">
        <span>${escapeHtml('\u7528\u6237\u7b5b\u9009')}</span>
        <div class="inbox-mailbox-filter ${state.inboxOwnerFilterOpen ? 'is-open' : ''}" data-inbox-owner-filter>
          <button
            class="inbox-mailbox-trigger"
            type="button"
            data-action="toggle-inbox-owner-filter"
            aria-expanded="${state.inboxOwnerFilterOpen ? 'true' : 'false'}"
          >
            <span class="inbox-mailbox-trigger-main">
              ${
                inboxSelectedOwner
                  ? renderAvatar(
                      inboxSelectedOwner.avatarUrl,
                      userInitials(inboxSelectedOwner),
                      'filter-user-avatar',
                      inboxSelectedOwner.name || inboxSelectedOwner.username || 'user',
                    )
                  : renderAvatar('', '\u5168', 'filter-user-avatar', 'all users')
              }
              <span class="inbox-mailbox-trigger-copy">
                <strong>${escapeHtml(triggerTitle)}</strong>
              </span>
            </span>
            <span class="inbox-mailbox-trigger-side">
              <span class="inbox-mailbox-trigger-meta">${escapeHtml(triggerMeta)}</span>
              <span class="inbox-mailbox-trigger-caret" aria-hidden="true"></span>
            </span>
          </button>
          ${
            state.inboxOwnerFilterOpen
              ? `
                  <div class="inbox-mailbox-panel">
                    <label class="inbox-mailbox-search-shell">
                      <span class="inbox-mailbox-search-icon" aria-hidden="true">&#8981;</span>
                      <input
                        data-action="inbox-owner-search"
                        value="${escapeHtml(state.inboxOwnerSearch || '')}"
                        placeholder="${escapeHtml('\u641c\u7d22\u6635\u79f0\u3001\u7528\u6237\u540d\u3001\u90ae\u7bb1')}"
                        autocomplete="off"
                      />
                    </label>
                    <div class="inbox-mailbox-option-list">
                      <button
                        class="inbox-mailbox-option ${inboxSelectedOwner ? '' : 'is-active'}"
                        type="button"
                        data-action="select-inbox-owner"
                        data-user-id=""
                      >
                        <span class="inbox-mailbox-option-main">
                          ${renderAvatar('', '\u5168', 'filter-user-avatar', 'all users')}
                          <span class="inbox-mailbox-option-copy">
                            <strong>${escapeHtml('\u5168\u90e8\u7528\u6237')}</strong>
                            <small>${escapeHtml('\u663e\u793a\u5f53\u524d\u6240\u6709\u7528\u6237\u7684\u90ae\u4ef6')}</small>
                          </span>
                        </span>
                        <span class="inbox-mailbox-option-meta">${escapeHtml(`${totalUserCount} \u4e2a`)}</span>
                      </button>
                      ${ownerOptionsMarkup}
                    </div>
                  </div>
                `
              : ''
          }
        </div>
      </label>
    `;
  };

  return `
    <section class="view-grid view-grid-inbox inbox-view">
      <article class="panel inbox-toolbar">
        <div class="panel-header">
          <div>
            <h3>${escapeHtml('\u6536\u4ef6\u7bb1\u5206\u7c7b')}</h3>
            <p>${escapeHtml('\u5783\u573e\u7bb1\u4f5c\u4e3a\u7236\u5206\u7c7b\uff0c\u4e0b\u65b9\u7ee7\u7eed\u7ec6\u5206\u4e3a\u201c\u5df2\u5220\u9664\u201d\u548c\u201c\u5783\u573e\u90ae\u4ef6\u201d\u3002')}</p>
          </div>
        </div>
        <div class="inbox-folder-strip">
          ${folderItems
            .map((folder) => {
              const isActive = folder.id === 'trash-group' ? isTrashGroupActive : state.inboxFolder === folder.id;
              const targetFolder = folder.id === 'trash-group' ? 'trash' : folder.id;
              return `
                <button
                  class="inbox-folder-pill ${isActive ? 'active' : ''}"
                  type="button"
                  data-action="set-inbox-folder"
                  data-folder="${escapeHtml(targetFolder)}"
                >
                  <span>${escapeHtml(folder.label)}</span>
                  <strong>${escapeHtml(folder.count)}</strong>
                </button>
              `;
            })
            .join('')}
        </div>
        ${
          isTrashGroupActive
            ? `
                <div class="inbox-folder-substrip">
                  ${trashFolderItems
                    .map(
                      (folder) => `
                        <button
                          class="inbox-folder-pill inbox-folder-subpill ${state.inboxFolder === folder.id ? 'active' : ''}"
                          type="button"
                          data-action="set-inbox-folder"
                          data-folder="${escapeHtml(folder.id)}"
                        >
                          <span>${escapeHtml(folder.label)}</span>
                          <strong>${escapeHtml(folder.count)}</strong>
                        </button>
                      `,
                    )
                    .join('')}
                </div>
              `
            : ''
        }
        <div class="toolbar-grid inbox-toolbar-grid">
          ${renderOwnerFilter()}
          ${renderMailboxFilter()}
          <label class="compact-field grow">
            <span>${escapeHtml('\u641c\u7d22\u90ae\u4ef6')}</span>
            <input
              data-action="search"
              value="${escapeHtml(state.search)}"
              placeholder="${escapeHtml('\u641c\u7d22\u4e3b\u9898\u3001\u53d1\u4ef6\u4eba\u3001\u6458\u8981')}"
            />
          </label>
          <div class="toolbar-actions inbox-toolbar-actions">
            <button class="button ghost" data-action="refresh-inbox">${escapeHtml('\u5237\u65b0')}</button>
            <button class="button" data-action="sync-all">${escapeHtml('\u540c\u6b65\u5f53\u524d\u53ef\u89c1\u90ae\u7bb1')}</button>
          </div>
        </div>
      </article>
      <article class="panel message-list-panel message-list-panel-wide">
        <div class="panel-header">
          <div>
            <h3>${escapeHtml('\u90ae\u4ef6\u5217\u8868')}</h3>
            <p>${escapeHtml(`本页 ${state.messages.length} 封，当前条件共 ${activeFolderTotal} 封`)}</p>
          </div>
        </div>
        <div class="message-bulk-toolbar">
          <label class="message-select-all">
            <input
              type="checkbox"
              data-action="toggle-select-all-visible"
              ${allVisibleSelected ? 'checked' : ''}
              ${state.messages.length ? '' : 'disabled'}
            />
            <span>${
              selectionCount
                ? `${escapeHtml('\u5df2\u9009')} ${selectionCount} ${escapeHtml('\u5c01')}`
                : escapeHtml('\u5168\u9009\u5f53\u524d\u5217\u8868')
            }</span>
          </label>
          <div class="message-bulk-actions">
            <button class="tiny-button" type="button" data-action="bulk-message-state" data-mode="read" ${bulkDisabled}>${escapeHtml('\u6807\u8bb0\u4e3a\u5df2\u8bfb')}</button>
            <button class="tiny-button" type="button" data-action="bulk-message-state" data-mode="unread" ${bulkDisabled}>${escapeHtml('\u6807\u8bb0\u4e3a\u672a\u8bfb')}</button>
            <button class="tiny-button" type="button" data-action="bulk-message-state" data-mode="star" ${bulkDisabled}>${escapeHtml('\u52a0\u661f')}</button>
            <button class="tiny-button" type="button" data-action="bulk-message-state" data-mode="unstar" ${bulkDisabled}>${escapeHtml('\u53d6\u6d88\u661f\u6807')}</button>
            <button class="tiny-button danger" type="button" data-action="bulk-delete-messages" ${bulkDisabled}>${
              escapeHtml(state.inboxFolder === 'trash' ? '\u5f7b\u5e95\u5220\u9664' : '\u5220\u9664\u90ae\u4ef6')
            }</button>
          </div>
        </div>
        <div class="message-list message-row-list">
          ${
            groupedMessages.length
              ? groupedMessages
                  .map(
                    (group) => `
                      <section class="message-group">
                        <div class="message-group-head">
                          <strong>${escapeHtml(group.label)}</strong>
                          <span>${escapeHtml(group.messages.length)} ${escapeHtml('\u5c01')}</span>
                        </div>
                        <div class="message-group-list">
                          ${group.messages
                            .map(
                              (message) => `
                                <article class="message-row ${state.messageReaderOpen && message.id === state.selectedMessageId ? 'active' : ''} ${selectedMessageIds.has(message.id) ? 'is-selected' : ''} ${message.isRead ? 'is-read' : 'is-unread'}">
                                  <label class="message-row-check">
                                    <input
                                      type="checkbox"
                                      data-action="toggle-message-select"
                                      data-message-id="${escapeHtml(message.id)}"
                                      ${selectedMessageIds.has(message.id) ? 'checked' : ''}
                                    />
                                  </label>
                                  <button
                                    class="message-item"
                                    type="button"
                                    data-action="select-message"
                                    data-message-id="${escapeHtml(message.id)}"
                                  >
                                    <div class="message-row-grid">
                                      <div class="message-row-primary">
                                        <div class="message-row-heading">
                                          ${message.isRead ? '' : '<span class="message-row-unread-dot"></span>'}
                                          <span class="message-row-sender">${escapeHtml(message.fromName || message.fromAddress || '\u672a\u77e5\u53d1\u4ef6\u4eba')}</span>
                                          <span class="message-row-subject">${escapeHtml(message.subject || '\uff08\u65e0\u4e3b\u9898\uff09')}</span>
                                        </div>
                                        <span class="message-row-preview">${escapeHtml(message.preview || '\u6682\u65e0\u6458\u8981')}</span>
                                      </div>
                                      <div class="message-row-meta">
                                        <span class="message-row-mailbox">${escapeHtml(message.mailboxName || message.mailboxEmail)}</span>
                                        ${
                                          state.user.role === 'admin' && (message.ownerName || message.ownerEmail)
                                            ? `<span class="message-row-owner">${escapeHtml(message.ownerName || message.ownerEmail)}</span>`
                                            : ''
                                        }
                                        <span class="message-row-date">${formatDate(message.receivedAt)}</span>
                                      </div>
                                    </div>
                                  </button>
                                  <button
                                    class="message-star-toggle ${message.isStarred ? 'active' : ''}"
                                    type="button"
                                    data-action="toggle-message-star"
                                    data-message-id="${escapeHtml(message.id)}"
                                    title="${escapeHtml(message.isStarred ? '\u53d6\u6d88\u661f\u6807' : '\u52a0\u5165\u661f\u6807')}"
                                  >
                                    ${message.isStarred ? '&#9733;' : '&#9734;'}
                                  </button>
                                </article>
                              `,
                            )
                            .join('')}
                        </div>
                      </section>
                    `,
                  )
                  .join('')
              : `<div class="empty-card">${escapeHtml('\u5f53\u524d\u7b5b\u9009\u6761\u4ef6\u4e0b\u6ca1\u6709\u90ae\u4ef6\u3002')}</div>`
          }
        </div>
        ${renderPaginationBar({
          type: 'inbox',
          page: inboxPagination.page || 1,
          pageSize: inboxPagination.pageSize || 10,
          totalItems: activeFolderTotal,
          totalPages: inboxPagination.totalPages || 1,
          currentCount: state.messages.length,
          pageSizeAction: 'inbox-page-size',
          pageAction: 'go-inbox-page',
          jumpAction: 'jump-inbox-page',
        })}
      </article>
    </section>
    ${renderMessageReaderModal(state)}
  `;
}

function syncIntervalOptions(selectedValue = 5) {
  const options = [1, 5, 10, 30, 60, 120, 300];
  return options
    .map(
      (value) => `
        <option value="${value}" ${Number(selectedValue) === value ? 'selected' : ''}>${value} 秒</option>
      `,
    )
    .join('');
}

function renderMailboxes(state) {
  const providerOptions = state.providers
    .map(
      (provider, index) => `
        <option value="${escapeHtml(provider.id)}" ${provider.id === 'gmail' || (!index && provider.id !== 'gmail') ? 'selected' : ''}>
          ${escapeHtml(provider.label)}
        </option>
      `,
    )
    .join('');
  const ownerOptions =
    state.user.role === 'admin'
      ? `
          <label class="mailbox-grid-field">
            <span>归属用户</span>
            <select name="ownerUserId">
              ${state.usersForAssignment
                .map(
                  (user) => `
                    <option value="${escapeHtml(user.id)}" ${
                      user.id === (state.selectedOwnerUserId || state.user.id) ? 'selected' : ''
                    }>
                      ${escapeHtml(user.name)} · ${escapeHtml(formatUserHandle(user))}
                    </option>
                  `,
                )
                .join('')}
            </select>
          </label>
        `
      : '';

  return `
    <section class="view-grid view-grid-mailboxes">
      <article class="panel">
        <div class="panel-header"><div><h3>添加新邮箱</h3><p>保存前会先测试 IMAP 连接，成功后自动同步。</p></div></div>
        <form data-form="mailbox" class="stack mailbox-form">
          ${ownerOptions}
          <label><span>邮箱类型</span><select name="provider" data-action="provider-change">${providerOptions}</select></label>
          <label><span>显示名称</span><input name="name" placeholder="例如：工作邮箱" /></label>
          <label><span>邮箱地址</span><input name="email" type="email" required /></label>
          <label><span>登录用户名</span><input name="username" placeholder="默认等于邮箱地址" /></label>
          <label><span>IMAP 密码 / 授权码</span><input name="password" type="password" required /></label>
          <div class="inline-grid">
            <label><span>IMAP 主机</span><input name="imapHost" required /></label>
            <label><span>端口</span><input name="imapPort" type="number" value="993" required /></label>
          </div>
          <div class="inline-grid">
            <label><span>同步频率</span><select name="syncIntervalSeconds">${syncIntervalOptions(5)}</select></label>
            <label class="check-field"><input name="secure" type="checkbox" checked /><span>启用 TLS / SSL</span></label>
          </div>
          <div class="note" data-provider-note></div>
          <div class="form-actions">
            <button class="button ghost" type="button" data-action="test-mailbox">测试连接</button>
            <button class="button" type="submit">保存并同步</button>
          </div>
        </form>
      </article>
      <article class="panel">
        <div class="panel-header"><div><h3>邮箱账户</h3><p>系统里已接入的邮箱列表。</p></div>${ownerFilter(state)}</div>
        <div class="mailbox-grid">
          ${
            state.mailboxes.length
              ? state.mailboxes
                  .map(
                    (mailbox) => `
                      <article class="mailbox-card">
                        <div class="mailbox-card-top"><span class="tag">${escapeHtml(mailbox.provider)}</span><span class="status ${escapeHtml(mailbox.status)}">${escapeHtml(mailbox.status)}</span></div>
                        <strong>${escapeHtml(mailbox.name)}</strong>
                        <p>${escapeHtml(mailbox.email)}</p>
                        ${
                          state.user.role === 'admin'
                            ? `<small>${escapeHtml(mailbox.ownerName || mailbox.ownerEmail || '未分配')}</small>`
                            : ''
                        }
                        <div class="mailbox-meta"><span>${mailbox.unreadCount} 未读</span><span>${mailbox.messageCount} 封邮件</span></div>
                        <form data-form="mailbox-interval" data-mailbox-id="${escapeHtml(mailbox.id)}" class="mailbox-interval-form">
                          <label class="compact-field grow">
                            <span>同步频率</span>
                            <select name="syncIntervalSeconds">${syncIntervalOptions(mailbox.syncIntervalSeconds || 5)}</select>
                          </label>
                          <button class="tiny-button" type="submit">保存频率</button>
                        </form>
                        <div class="mailbox-actions">
                          <button class="tiny-button" data-action="sync-mailbox" data-mailbox-id="${escapeHtml(mailbox.id)}">同步</button>
                          <button class="tiny-button danger" data-action="delete-mailbox" data-mailbox-id="${escapeHtml(mailbox.id)}">删除</button>
                        </div>
                        ${mailbox.lastError ? `<div class="notice error">${escapeHtml(mailbox.lastError)}</div>` : ''}
                      </article>
                    `,
                  )
                  .join('')
              : '<div class="empty-card">当前还没有邮箱账户。</div>'
          }
        </div>
      </article>
    </section>
  `;
}

function renderMailboxesViewLegacy(state) {
  const defaultProviderId =
    state.providers.find((provider) => provider.id === 'gmail')?.id || state.providers[0]?.id || 'generic';
  const fallbackPreset = state.providers.find((provider) => provider.id === defaultProviderId) || state.providers[0] || {};
  const draft = state.mailboxDraft || {
    mailboxId: '',
    ownerUserId: state.selectedOwnerUserId || state.user.id,
    provider: defaultProviderId,
    name: '',
    email: '',
    username: '',
    password: '',
    imapHost: fallbackPreset.imapHost || '',
    imapPort: Number(fallbackPreset.imapPort || 993),
    syncIntervalSeconds: 5,
    sortOrder: 100,
    isPinned: false,
    secure: Boolean(fallbackPreset.secure),
  };
  const isEditingMailbox = Boolean(draft.mailboxId);
  const selectedOwnerUserId = draft.ownerUserId || state.selectedOwnerUserId || state.user.id;
  const selectedProvider =
    state.providers.find((provider) => provider.id === draft.provider) || fallbackPreset;
  const providerOptions = state.providers
    .map(
      (provider) => `
        <option value="${escapeHtml(provider.id)}" ${provider.id === draft.provider ? 'selected' : ''}>
          ${escapeHtml(provider.label)}
        </option>
      `,
    )
    .join('');
  const ownerField =
    state.user.role === 'admin'
      ? `
          <label>
            <span>归属用户</span>
            <select name="ownerUserId">
              ${state.usersForAssignment
                .map(
                  (user) => `
                    <option value="${escapeHtml(user.id)}" ${user.id === selectedOwnerUserId ? 'selected' : ''}>
                      ${escapeHtml(user.name)} / ${escapeHtml(formatUserHandle(user))}
                    </option>
                  `,
                )
                .join('')}
            </select>
          </label>
        `
      : `<input type="hidden" name="ownerUserId" value="${escapeHtml(selectedOwnerUserId)}" />`;

  return `
    <section class="view-grid view-grid-mailboxes">
      <article class="panel">
        <div class="panel-header">
          <div>
            <h3>${isEditingMailbox ? '编辑邮箱配置' : '添加新邮箱'}</h3>
            <p>${
              isEditingMailbox
                ? '支持直接修改邮箱参数，密码留空时会继续使用当前已保存的授权信息，保存前会自动重新检测连接并同步。'
                : '保存前会先测试 IMAP 连接，成功后自动同步。'
            }</p>
          </div>
          ${isEditingMailbox ? '<button class="button ghost" type="button" data-action="cancel-mailbox-edit">取消编辑</button>' : ''}
        </div>
        <form data-form="mailbox" class="stack mailbox-form">
          <input type="hidden" name="mailboxId" value="${escapeHtml(draft.mailboxId || '')}" />
          ${ownerField}
          <label><span>邮箱类型</span><select name="provider" data-action="provider-change">${providerOptions}</select></label>
          <label><span>显示名称</span><input name="name" value="${escapeHtml(draft.name || '')}" placeholder="例如：工作邮箱" /></label>
          <label><span>邮箱地址</span><input name="email" type="email" value="${escapeHtml(draft.email || '')}" required /></label>
          <label><span>登录用户名</span><input name="username" value="${escapeHtml(draft.username || '')}" placeholder="默认等于邮箱地址" /></label>
          <label>
            <span>IMAP 密码 / 授权码</span>
            <input
              name="password"
              type="password"
              value="${escapeHtml(draft.password || '')}"
              ${isEditingMailbox ? '' : 'required'}
              placeholder="${isEditingMailbox ? '留空则继续使用当前密码' : ''}"
            />
          </label>
          <div class="inline-grid">
            <label><span>IMAP 主机</span><input name="imapHost" value="${escapeHtml(draft.imapHost || '')}" required /></label>
            <label><span>端口</span><input name="imapPort" type="number" value="${escapeHtml(draft.imapPort || 993)}" required /></label>
          </div>
          <div class="inline-grid">
            <label><span>同步频率</span><select name="syncIntervalSeconds">${syncIntervalOptions(draft.syncIntervalSeconds || 5)}</select></label>
            <label class="check-field"><input name="secure" type="checkbox" ${draft.secure ? 'checked' : ''} /><span>启用 TLS / SSL</span></label>
          </div>
          <div class="note" data-provider-note>${escapeHtml(selectedProvider?.note || '')}</div>
          <div class="form-actions">
            <button class="button ghost" type="button" data-action="test-mailbox">测试连接</button>
            <button class="button" type="submit">${isEditingMailbox ? '保存修改并同步' : '保存并同步'}</button>
          </div>
        </form>
      </article>
      <article class="panel">
        <div class="panel-header"><div><h3>邮箱账户</h3><p>这里展示当前系统中已经接入的邮箱，你可以直接编辑、调整同步频率或手动同步。</p></div>${ownerFilter(state)}</div>
        <div class="mailbox-grid">
          ${
            state.mailboxes.length
              ? state.mailboxes
                  .map(
                    (mailbox) => `
                      <article class="mailbox-card ${mailbox.id === state.editingMailboxId ? 'active' : ''}">
                        <div class="mailbox-card-top">
                          <span class="tag">${escapeHtml(mailbox.provider)}</span>
                          <span class="status ${escapeHtml(mailbox.status)}">${escapeHtml(mailbox.status)}</span>
                        </div>
                        <strong>${escapeHtml(mailbox.name)}</strong>
                        <p>${escapeHtml(mailbox.email)}</p>
                        <small>${escapeHtml(mailbox.username)} 路 ${escapeHtml(mailbox.imapHost)}:${escapeHtml(mailbox.imapPort)}</small>
                        ${
                          state.user.role === 'admin'
                            ? `<small>${escapeHtml(mailbox.ownerName || mailbox.ownerEmail || '未分配')}</small>`
                            : ''
                        }
                        <div class="mailbox-meta">
                          <span>${mailbox.unreadCount} 未读</span>
                          <span>${mailbox.messageCount} 封邮件</span>
                          <span>${mailbox.lastSyncedAt ? `上次 ${escapeHtml(formatDate(mailbox.lastSyncedAt))}` : '未同步'}</span>
                        </div>
                        <form data-form="mailbox-interval" data-mailbox-id="${escapeHtml(mailbox.id)}" class="mailbox-interval-form">
                          <label class="compact-field grow">
                            <span>同步频率</span>
                            <select name="syncIntervalSeconds">${syncIntervalOptions(mailbox.syncIntervalSeconds || 5)}</select>
                          </label>
                          <button class="tiny-button" type="submit">保存频率</button>
                        </form>
                        <div class="mailbox-actions">
                          <button class="tiny-button" data-action="edit-mailbox" data-mailbox-id="${escapeHtml(mailbox.id)}">编辑</button>
                          <button class="tiny-button" data-action="sync-mailbox" data-mailbox-id="${escapeHtml(mailbox.id)}">同步</button>
                          <button class="tiny-button danger" data-action="delete-mailbox" data-mailbox-id="${escapeHtml(mailbox.id)}">删除</button>
                        </div>
                        ${mailbox.lastError ? `<div class="notice error">${escapeHtml(mailbox.lastError)}</div>` : ''}
                      </article>
                    `,
                  )
                  .join('')
              : '<div class="empty-card">当前还没有接入邮箱账户。</div>'
          }
        </div>
      </article>
    </section>
  `;
}

function renderMailboxesView(state) {
  const defaultProviderId =
    state.providers.find((provider) => provider.id === 'gmail')?.id || state.providers[0]?.id || 'generic';
  const fallbackPreset =
    state.providers.find((provider) => provider.id === defaultProviderId) || state.providers[0] || {};
  const draft = state.mailboxDraft || {
    mailboxId: '',
    ownerUserId: state.selectedOwnerUserId || state.user.id,
    provider: defaultProviderId,
    name: '',
    email: '',
    username: '',
    password: '',
    imapHost: fallbackPreset.imapHost || '',
    imapPort: Number(fallbackPreset.imapPort || 993),
    syncIntervalSeconds: 5,
    secure: Boolean(fallbackPreset.secure),
  };
  const isEditingMailbox = Boolean(draft.mailboxId);
  const activeMailbox = draft.mailboxId
    ? state.mailboxes.find((mailbox) => mailbox.id === draft.mailboxId) || null
    : null;
  const selectedOwnerUserId = draft.ownerUserId || state.selectedOwnerUserId || state.user.id;
  const selectedProvider =
    state.providers.find((provider) => provider.id === draft.provider) || fallbackPreset;
  const providerOptions = state.providers
    .map(
      (provider) => `
        <option value="${escapeHtml(provider.id)}" ${provider.id === draft.provider ? 'selected' : ''}>
          ${escapeHtml(provider.label)}
        </option>
      `,
    )
    .join('');
  const ownerField =
    state.user.role === 'admin'
      ? `
          <label>
            <span>归属用户</span>
            <select name="ownerUserId">
              ${state.usersForAssignment
                .map(
                  (user) => `
                    <option value="${escapeHtml(user.id)}" ${user.id === selectedOwnerUserId ? 'selected' : ''}>
                      ${escapeHtml(user.name)} / ${escapeHtml(formatUserHandle(user))}
                    </option>
                  `,
                )
                .join('')}
            </select>
          </label>
        `
      : `<input type="hidden" name="ownerUserId" value="${escapeHtml(selectedOwnerUserId)}" />`;
  const mailboxSearchTokens = tokenizeSearchQuery(state.mailboxSearch);
  const displayOrderHint = draft.isPinned
    ? `置顶邮箱会优先显示，当前排序值 ${Number(draft.sortOrder ?? 100)}。`
    : `排序值越小越靠前，当前值 ${Number(draft.sortOrder ?? 100)}，建议常规邮箱保持 100。`;
  const providerCounts = state.mailboxes.reduce((counts, mailbox) => {
    const providerId = mailbox.provider || 'generic';
    counts.set(providerId, (counts.get(providerId) || 0) + 1);
    return counts;
  }, new Map());
  const providerFilters = [
    {
      id: 'all',
      count: state.mailboxes.length,
      ...mailboxProviderMeta('all', state.providers),
    },
    ...Array.from(providerCounts.entries()).map(([providerId, count]) => ({
      count,
      ...mailboxProviderMeta(providerId, state.providers),
    })),
  ];
  const filteredMailboxes = state.mailboxes.filter((mailbox) => {
    const providerMatched =
      !state.mailboxProviderFilter ||
      state.mailboxProviderFilter === 'all' ||
      mailbox.provider === state.mailboxProviderFilter;
    const searchMatched = mailboxMatchesQuery(mailbox, mailboxSearchTokens, state.providers);

    return providerMatched && searchMatched;
  });
  const modalMarkup = state.mailboxModalOpen
    ? `
        <div class="modal-shell">
          <div class="modal-backdrop" data-mailbox-overlay></div>
          <section class="modal-panel mailbox-modal">
            <div class="panel-header">
              <div>
                <p class="eyebrow">Mailbox</p>
                <h3>${isEditingMailbox ? '邮箱详情与编辑' : '新增邮箱'}</h3>
                <p>${isEditingMailbox ? '这里会显示当前邮箱信息，也可以直接修改并保存。' : '填写邮箱参数后即可接入系统。'}</p>
              </div>
              <button class="button ghost" type="button" data-action="close-mailbox-modal">关闭</button>
            </div>
            ${
              activeMailbox
                ? `
                  <div class="mailbox-modal-summary">
                    <div class="mailbox-summary-card">
                      <span>邮箱地址</span>
                      <strong>${escapeHtml(activeMailbox.email)}</strong>
                    </div>
                    <div class="mailbox-summary-card">
                      <span>同步状态</span>
                      <strong>${escapeHtml(activeMailbox.status)}</strong>
                    </div>
                    <div class="mailbox-summary-card">
                      <span>未读邮件</span>
                      <strong>${escapeHtml(activeMailbox.unreadCount)}</strong>
                    </div>
                    <div class="mailbox-summary-card">
                      <span>上次同步</span>
                      <strong>${escapeHtml(activeMailbox.lastSyncedAt ? formatDate(activeMailbox.lastSyncedAt) : '未同步')}</strong>
                    </div>
                  </div>
                `
                : ''
            }
            <form data-form="mailbox" class="stack mailbox-form mailbox-modal-form">
              <input type="hidden" name="mailboxId" value="${escapeHtml(draft.mailboxId || '')}" />
              ${ownerField}
              <label><span>邮箱类型</span><select name="provider" data-action="provider-change">${providerOptions}</select></label>
              <label><span>显示名称</span><input name="name" value="${escapeHtml(draft.name || '')}" placeholder="例如：工作邮箱" /></label>
              <label><span>邮箱地址</span><input name="email" type="email" value="${escapeHtml(draft.email || '')}" required /></label>
              <label><span>登录用户名</span><input name="username" value="${escapeHtml(draft.username || '')}" placeholder="默认等于邮箱地址" /></label>
              <label>
                <span>IMAP 密码 / 授权码</span>
                <input
                  name="password"
                  type="password"
                  value="${escapeHtml(draft.password || '')}"
                  ${isEditingMailbox ? '' : 'required'}
                  placeholder="${isEditingMailbox ? '留空则继续使用当前已保存的密码' : ''}"
                />
              </label>
              <div class="inline-grid">
                <label><span>IMAP 主机</span><input name="imapHost" value="${escapeHtml(draft.imapHost || '')}" required /></label>
                <label><span>端口</span><input name="imapPort" type="number" value="${escapeHtml(draft.imapPort || 993)}" required /></label>
              </div>
              <div class="inline-grid">
                <label><span>同步频率</span><select name="syncIntervalSeconds">${syncIntervalOptions(draft.syncIntervalSeconds || 5)}</select></label>
                <label class="check-field"><input name="secure" type="checkbox" ${draft.secure ? 'checked' : ''} /><span>启用 TLS / SSL</span></label>
              </div>
              <div class="note" data-provider-note>${escapeHtml(selectedProvider?.note || '')}</div>
              <div class="form-actions">
                <button class="button ghost" type="button" data-action="test-mailbox">测试连接</button>
                ${
                  isEditingMailbox
                    ? `<button class="button ghost" type="button" data-action="sync-mailbox" data-mailbox-id="${escapeHtml(draft.mailboxId)}">立即同步</button>`
                    : ''
                }
                <button class="button" type="submit">${isEditingMailbox ? '保存修改' : '保存并接入'}</button>
              </div>
              ${
                isEditingMailbox
                  ? `
                    <div class="mailbox-modal-danger">
                      <button class="tiny-button danger" type="button" data-action="delete-mailbox" data-mailbox-id="${escapeHtml(draft.mailboxId)}">删除这个邮箱</button>
                    </div>
                  `
                  : ''
              }
            </form>
          </section>
        </div>
      `
    : '';

  return `
    <section class="view-grid view-grid-mailboxes mailbox-layout">
      <article class="panel">
        <div class="panel-header mailbox-list-head">
          <div>
            <h3>邮箱账户</h3>
            <p>一个邮箱一行展示，点击即可弹出详情窗口查看和修改参数。</p>
          </div>
          <div class="mailbox-toolbar">
            ${ownerFilter(state)}
            <button class="button" type="button" data-action="create-mailbox">新增邮箱</button>
          </div>
        </div>
        <div class="mailbox-head-strip">
          <div class="mailbox-head-title">
            ${renderAutoIcon('mailboxes', 'mailboxes', 'mailbox-head-icon')}
            <h3>邮箱账户</h3>
          </div>
          <div class="mailbox-head-controls">
            <div class="mailbox-provider-strip mailbox-provider-strip-compact">
              ${providerFilters
                .map(
                  (provider) => `
                    <button
                      class="provider-filter-chip ${state.mailboxProviderFilter === provider.id ? 'active' : ''}"
                      type="button"
                      data-action="set-mailbox-provider-filter"
                      data-provider="${escapeHtml(provider.id)}"
                    >
                      ${renderMailboxProviderIcon(provider.id, state.providers, 'provider-icon-inline')}
                      <span>${escapeHtml(provider.label)}</span>
                      <strong>${escapeHtml(provider.count)}</strong>
                    </button>
                  `,
                )
                .join('')}
            </div>
            ${ownerFilterCompact(state)}
            <label class="mailbox-search-shell mailbox-search-shell-compact" aria-label="搜索邮箱">
              <span class="mailbox-search-field">
                <span class="mailbox-search-icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24" focusable="false">
                    <path d="M10.5 4a6.5 6.5 0 1 0 4.06 11.58l4.43 4.43 1.41-1.41-4.43-4.43A6.5 6.5 0 0 0 10.5 4Zm0 2a4.5 4.5 0 1 1 0 9 4.5 4.5 0 0 1 0-9Z" fill="currentColor"/>
                  </svg>
                </span>
                <input
                  data-action="mailbox-search"
                  value="${escapeHtml(state.mailboxSearch || '')}"
                  placeholder="搜索邮箱名或邮箱地址"
                  aria-label="搜索邮箱"
                />
              </span>
            </label>
            <button class="button" type="button" data-action="create-mailbox">新增邮箱</button>
          </div>
        </div>
        <div class="mailbox-list">
          ${
            state.mailboxes.length
              ? state.mailboxes
                  .map(
                    (mailbox) => `
                      <article class="mailbox-row-card ${mailbox.id === state.editingMailboxId && state.mailboxModalOpen ? 'active' : ''}">
                        <div class="mailbox-row-body">
                          <button class="mailbox-row-main" type="button" data-action="open-mailbox-modal" data-mailbox-id="${escapeHtml(mailbox.id)}">
                          <div class="mailbox-row-top">
                            <div class="mailbox-row-title">
                              <strong>${escapeHtml(mailbox.name)}</strong>
                              <span class="tag">${escapeHtml(mailbox.provider)}</span>
                              <span class="status ${escapeHtml(mailbox.status)}">${escapeHtml(mailbox.status)}</span>
                            </div>
                            <span class="mailbox-row-open">查看详情</span>
                          </div>
                          <p>${escapeHtml(mailbox.email)}</p>
                          <div class="mailbox-row-chips">
                            <span>${escapeHtml(mailbox.username)}</span>
                            <span>${escapeHtml(mailbox.imapHost)}:${escapeHtml(mailbox.imapPort)}</span>
                            ${
                              state.user.role === 'admin'
                                ? `<span>${escapeHtml(mailbox.ownerName || mailbox.ownerEmail || '未分配')}</span>`
                                : ''
                            }
                            <span>${escapeHtml(mailbox.unreadCount)} 未读</span>
                            <span>${escapeHtml(mailbox.messageCount)} 封邮件</span>
                            <span>${escapeHtml((mailbox.syncIntervalSeconds || 5) + ' 秒刷新')}</span>
                            <span>${escapeHtml(mailbox.lastSyncedAt ? `上次 ${formatDate(mailbox.lastSyncedAt)}` : '未同步')}</span>
                          </div>
                        </button>
                        </div>
                        <div class="mailbox-row-actions">
                          <button class="tiny-button" type="button" data-action="sync-mailbox" data-mailbox-id="${escapeHtml(mailbox.id)}">同步</button>
                          <button class="tiny-button" type="button" data-action="open-mailbox-modal" data-mailbox-id="${escapeHtml(mailbox.id)}">打开</button>
                          <button class="tiny-button danger" type="button" data-action="delete-mailbox" data-mailbox-id="${escapeHtml(mailbox.id)}">删除</button>
                        </div>
                        ${mailbox.lastError ? `<div class="notice error">${escapeHtml(mailbox.lastError)}</div>` : ''}
                      </article>
                    `,
                  )
                  .join('')
              : '<div class="empty-card">当前还没有接入邮箱账户。</div>'
          }
        </div>
      </article>
      ${modalMarkup}
    </section>
  `;
}

function renderMailboxesWorkspace(state) {
  const defaultProviderId =
    state.providers.find((provider) => provider.id === 'gmail')?.id || state.providers[0]?.id || 'generic';
  const fallbackPreset =
    state.providers.find((provider) => provider.id === defaultProviderId) || state.providers[0] || {};
  const draft = state.mailboxDraft || {
    mailboxId: '',
    ownerUserId: state.selectedOwnerUserId || state.user.id,
    provider: defaultProviderId,
    name: '',
    email: '',
    username: '',
    password: '',
    imapHost: fallbackPreset.imapHost || '',
    imapPort: Number(fallbackPreset.imapPort || 993),
    syncIntervalSeconds: 5,
    secure: Boolean(fallbackPreset.secure),
  };
  const isEditingMailbox = Boolean(draft.mailboxId);
  const activeMailbox = draft.mailboxId
    ? state.mailboxes.find((mailbox) => mailbox.id === draft.mailboxId) || null
    : null;
  const selectedOwnerUserId = draft.ownerUserId || state.selectedOwnerUserId || state.user.id;
  const selectedProvider =
    state.providers.find((provider) => provider.id === draft.provider) || fallbackPreset;
  const selectedProviderMeta = mailboxProviderMeta(draft.provider, state.providers);
  const isGmailProvider = draft.provider === 'gmail';
  const isOutlookProvider = draft.provider === 'outlook';
  const isGmailOauth = isGmailProvider && draft.authType !== 'password';
  const isMicrosoftOauth = isOutlookProvider;
  const usesOauth = isGmailOauth || isMicrosoftOauth;
  const mailboxPasswordVisible = Boolean(state.mailboxPasswordVisible);
  const oauthConfigured = Boolean(draft.oauthConfigured);
  const oauthGraphReady = Boolean(draft.oauthGraphReady);
  const oauthImapReady = Boolean(draft.oauthImapReady);
  const microsoftProtocolMode = String(draft.microsoftProtocolMode || 'graph_imap_dual').trim() || 'graph_imap_dual';
  const simplifiedOutlookProtocolMode = 'graph_only';
  const isOutlookOauthMode = isMicrosoftOauth && microsoftProtocolMode !== simplifiedOutlookProtocolMode;
  const isOutlookGraphMode = isMicrosoftOauth && !isOutlookOauthMode;
  const hasManualMicrosoftRefreshToken = Boolean(
    String(draft.microsoftRefreshToken || draft.microsoftGraphRefreshToken || draft.microsoftImapRefreshToken || '').trim(),
  );
  const systemSettings = normalizeSystemSettings(state.systemSettings);
  const systemMicrosoftClientIdValue = String(systemSettings.microsoftClientId || '').trim();
  const systemMicrosoftConfigured = Boolean(systemSettings.microsoftAppConfigured && systemMicrosoftClientIdValue);
  const systemMicrosoftTenantId = String(systemSettings.microsoftTenantId || 'common').trim() || 'common';
  const manualMicrosoftClientId = String(draft.microsoftClientId || '').trim();
  const hasMicrosoftClientIdOverride = Boolean(
    manualMicrosoftClientId && manualMicrosoftClientId !== systemMicrosoftClientIdValue,
  );
  const canStartMicrosoftOauth = systemMicrosoftConfigured || Boolean(manualMicrosoftClientId);
  const effectiveOauthEmail = draft.oauthEmail || draft.email || '';
  const outlookRefreshTokenPlaceholder = isEditingMailbox
    ? '留空则继续使用当前已保存的 Refresh Token；要更换时再粘贴新令牌'
    : '粘贴 Microsoft Graph Refresh Token';
  const providerNote = selectedProvider?.note || '';
  const oauthTitle = isGmailProvider ? 'Gmail 登录方式' : isOutlookProvider ? 'Outlook 登录方式' : '';
  const oauthRecommendedTag = isOutlookProvider ? 'Graph 方式' : usesOauth ? '次选 OAuth2' : '默认应用专用密码';
  const oauthPrimaryLabel = isGmailProvider ? 'Google OAuth2' : 'Microsoft OAuth2';
  const oauthSecondaryLabel = isGmailProvider ? '应用专用密码' : 'IMAP 密码 / 应用密码';
  const oauthActionLabel = isGmailProvider ? 'Google' : 'Microsoft';
  const oauthClientIdName = isGmailProvider ? 'googleClientId' : 'microsoftClientId';
  const oauthClientSecretName = isGmailProvider ? 'googleClientSecret' : 'microsoftClientSecret';
  const oauthClientIdValue = isGmailProvider ? draft.googleClientId || '' : draft.microsoftClientId || '';
  const oauthClientSecretValue = isGmailProvider ? draft.googleClientSecret || '' : draft.microsoftClientSecret || '';
  const oauthClientIdLabel = isGmailProvider ? 'Google Client ID' : 'Microsoft Client ID';
  const oauthClientSecretLabel = isGmailProvider ? 'Google Client Secret' : 'Microsoft Client Secret';
  const oauthConnectAction = isGmailProvider ? 'start-google-oauth' : 'start-microsoft-oauth';
  const oauthAddressLabel = isGmailProvider ? 'Gmail 地址（可留空，授权后自动识别）' : 'Outlook 邮箱地址（建议填写）';
  const oauthAddressPlaceholder = isGmailProvider ? '例如：yourname@gmail.com' : '例如：name@outlook.com';
  const oauthIntroText = isGmailProvider
    ? 'Gmail 现在更适合用 Google OAuth2 接入；应用专用密码仅适合已开启两步验证的个人账号。'
    : 'Outlook / Microsoft 365 更推荐直接使用 Microsoft OAuth2；如果一定要用密码，请先确认网页版已开启 IMAP。';
  const providerOptions = state.providers
    .map(
      (provider) => `
        <option value="${escapeHtml(provider.id)}" ${provider.id === draft.provider ? 'selected' : ''}>
          ${escapeHtml(mailboxProviderMeta(provider.id, state.providers).label)}
        </option>
      `,
    )
    .join('');
  const ownerField =
    state.user.role === 'admin'
      ? `
          <label>
            <span>归属用户</span>
            <select name="ownerUserId">
              ${state.usersForAssignment
                .map(
                  (user) => `
                    <option value="${escapeHtml(user.id)}" ${user.id === selectedOwnerUserId ? 'selected' : ''}>
                      ${escapeHtml(user.name)} / ${escapeHtml(formatUserHandle(user))}
                    </option>
                  `,
                )
                .join('')}
            </select>
          </label>
        `
      : `<input type="hidden" name="ownerUserId" value="${escapeHtml(selectedOwnerUserId)}" />`;
  const mailboxSearchQuery = String(state.mailboxSearch || '').trim().toLowerCase();
  const providerCounts = state.mailboxes.reduce((counts, mailbox) => {
    const providerId = mailbox.provider || 'generic';
    counts.set(providerId, (counts.get(providerId) || 0) + 1);
    return counts;
  }, new Map());
  const providerFilters = [
    {
      id: 'all',
      count: state.mailboxes.length,
      ...mailboxProviderMeta('all', state.providers),
    },
    ...Array.from(providerCounts.entries()).map(([providerId, count]) => ({
      count,
      ...mailboxProviderMeta(providerId, state.providers),
    })),
  ];
  const filteredMailboxes = state.mailboxes.filter((mailbox) => {
    const providerMatched =
      !state.mailboxProviderFilter ||
      state.mailboxProviderFilter === 'all' ||
      mailbox.provider === state.mailboxProviderFilter;
    const searchMatched =
      !mailboxSearchQuery ||
      String(mailbox.name || '').toLowerCase().includes(mailboxSearchQuery) ||
      String(mailbox.email || '').toLowerCase().includes(mailboxSearchQuery);

    return providerMatched && searchMatched;
  });
  const guideModalMarkup =
    state.mailboxModalOpen && state.mailboxGuideOpen ? renderMailboxGuideModal(state, draft.provider) : '';
  const importDraft = state.mailboxImportDraft || {
    ownerUserId: state.selectedOwnerUserId || state.user.id,
    importText: '',
    microsoftClientSecret: '',
    microsoftTenantId: systemMicrosoftTenantId,
    microsoftProtocolMode: 'graph_only',
    imapHost: 'outlook.office365.com',
    imapPort: 993,
    secure: true,
    syncIntervalSeconds: 5,
    sortOrder: 100,
    isPinned: false,
  };
  const importModalMarkup = state.mailboxImportModalOpen
    ? `
        <div class="modal-shell">
          <div class="modal-backdrop" data-mailbox-import-overlay></div>
          <section class="modal-panel mailbox-modal mailbox-import-modal">
            <div class="panel-header">
              ${renderSectionTitle(
                'outlook',
                `
                  <h3>批量导入 Outlook OAuth</h3>
                  <p>支持固定格式文件或直接粘贴文本：邮箱----密码----ClientId----RefreshToken。也支持扩展成 5~7 段，依次补 Tenant、协议模式、Client Secret。</p>
                `,
                'mailbox-modal-title',
              )}
              <button class="button ghost" type="button" data-action="close-mailbox-import-modal">关闭</button>
            </div>
            ${state.mailboxImportNotice ? renderNotice(state.mailboxImportNotice) : ''}
            <form data-form="mailbox-import" class="stack mailbox-form mailbox-modal-form">
              <div class="mailbox-config-grid mailbox-config-grid-top">
                <label class="mailbox-grid-field">
                  <span>归属用户</span>
                  <select name="ownerUserId">
                    ${(Array.isArray(state.usersForAssignment) ? state.usersForAssignment : [])
                      .map(
                        (user) => `
                          <option value="${escapeHtml(user.id)}" ${user.id === (importDraft.ownerUserId || state.user.id) ? 'selected' : ''}>
                            ${escapeHtml(user.name || user.username || user.email || '用户')}
                          </option>
                        `,
                      )
                      .join('')}
                  </select>
                </label>
                <label class="mailbox-grid-field">
                  <span>Tenant</span>
                  <input name="microsoftTenantId" value="${escapeHtml(importDraft.microsoftTenantId || 'common')}" placeholder="默认 common" />
                </label>
                <label class="mailbox-grid-field">
                  <span>协议模式</span>
                  <select name="microsoftProtocolMode">
                    <option value="graph_imap_dual" ${String(importDraft.microsoftProtocolMode || '') === 'graph_imap_dual' ? 'selected' : ''}>Graph API + IMAP</option>
                    <option value="graph_only" ${String(importDraft.microsoftProtocolMode || '') === 'graph_only' ? 'selected' : ''}>仅 Graph API</option>
                    <option value="imap_only" ${String(importDraft.microsoftProtocolMode || '') === 'imap_only' ? 'selected' : ''}>仅 IMAP</option>
                  </select>
                </label>
              </div>
              <div class="mailbox-config-grid mailbox-config-grid-compact">
                <label class="mailbox-grid-field">
                  <span>默认 IMAP Host</span>
                  <input name="imapHost" value="${escapeHtml(importDraft.imapHost || 'outlook.office365.com')}" />
                </label>
                <label class="mailbox-grid-field">
                  <span>端口</span>
                  <input name="imapPort" type="number" value="${escapeHtml(importDraft.imapPort || 993)}" />
                </label>
                <label class="mailbox-grid-field">
                  <span>同步频率</span>
                  <select name="syncIntervalSeconds">${syncIntervalOptions(importDraft.syncIntervalSeconds || 5)}</select>
                </label>
                <label class="mailbox-grid-field">
                  <span>排序值</span>
                  <input name="sortOrder" type="number" min="0" step="1" value="${escapeHtml(importDraft.sortOrder ?? 100)}" />
                </label>
              </div>
              <div class="mailbox-toggle-strip">
                <label class="check-field mailbox-toggle-card">
                  <input name="secure" type="checkbox" ${importDraft.secure ? 'checked' : ''} />
                  <span>启用 TLS / SSL</span>
                </label>
                <label class="check-field mailbox-toggle-card">
                  <input name="isPinned" type="checkbox" ${importDraft.isPinned ? 'checked' : ''} />
                  <span>导入后置顶</span>
                </label>
              </div>
              <label class="mailbox-grid-field mailbox-grid-field-full">
                <span>可选 Client Secret</span>
                <input name="microsoftClientSecret" value="${escapeHtml(importDraft.microsoftClientSecret || '')}" placeholder="如果你的应用是 public client，这里可以留空" />
              </label>
              <label class="mailbox-grid-field mailbox-grid-field-full">
                <span>导入文件</span>
                <input name="importFile" type="file" accept=".txt,.csv" />
              </label>
              <label class="mailbox-grid-field mailbox-grid-field-full">
                <span>或直接粘贴配置</span>
                <textarea name="importText" rows="8" placeholder="支持每行一个账号，例如：name@outlook.com----client-id----refresh-token 或 name@outlook.com----password----client-id----refresh-token">${escapeHtml(importDraft.importText || '')}</textarea>
              </label>
              <div class="form-actions mailbox-modal-actions">
                <div class="mailbox-modal-actions-left">
                  <span class="note">兼容 3 段和 4 段格式，也支持额外追加 tenant / protocol / client secret。</span>
                </div>
                <div class="mailbox-modal-actions-right">
                  <button class="button ghost" type="button" data-action="close-mailbox-import-modal">取消</button>
                  <button class="button" type="submit">开始导入</button>
                </div>
              </div>
            </form>
          </section>
        </div>
      `
    : '';
  const modalMarkup = state.mailboxModalOpen
    ? `
        <div class="modal-shell">
          <div class="modal-backdrop" data-mailbox-overlay></div>
          <section class="modal-panel mailbox-modal">
            <div class="panel-header">
              <div>
                <p class="eyebrow">Mailbox</p>
                <h3>${isEditingMailbox ? '邮箱详情与编辑' : '新增邮箱'}</h3>
                <p>${isEditingMailbox ? '这里会显示当前邮箱信息，也可以直接修改并保存。' : '填写邮箱参数后即可接入系统。'}</p>
              </div>
              <button class="button ghost" type="button" data-action="close-mailbox-modal">关闭</button>
            </div>
            ${state.mailboxNotice ? renderNotice(state.mailboxNotice) : ''}
            ${
              activeMailbox
                ? `
                  <div class="mailbox-modal-summary">
                    <div class="mailbox-summary-card">
                      <span>邮箱地址</span>
                      <strong>${escapeHtml(activeMailbox.email)}</strong>
                    </div>
                    <div class="mailbox-summary-card">
                      <span>邮箱厂商</span>
                      <strong>${escapeHtml(mailboxProviderMeta(activeMailbox.provider, state.providers).label)}</strong>
                    </div>
                    <div class="mailbox-summary-card">
                      <span>未读邮件</span>
                      <strong>${escapeHtml(activeMailbox.unreadCount)}</strong>
                    </div>
                    <div class="mailbox-summary-card">
                      <span>上次同步</span>
                      <strong>${escapeHtml(activeMailbox.lastSyncedAt ? formatDate(activeMailbox.lastSyncedAt) : '未同步')}</strong>
                    </div>
                  </div>
                `
                : ''
            }
            <form data-form="mailbox" class="stack mailbox-form mailbox-modal-form">
              <input type="hidden" name="mailboxId" value="${escapeHtml(draft.mailboxId || '')}" />
              <input type="hidden" name="oauthConfigured" value="${oauthConfigured ? 'true' : 'false'}" />
              <input type="hidden" name="oauthGraphReady" value="${oauthGraphReady ? 'true' : 'false'}" />
              <input type="hidden" name="oauthImapReady" value="${oauthImapReady ? 'true' : 'false'}" />
              <input type="hidden" name="oauthEmail" value="${escapeHtml(effectiveOauthEmail)}" />
              ${ownerField}
              <label><span>邮箱类型</span><select name="provider" data-action="provider-change">${providerOptions}</select></label>
              <div class="mailbox-guide-inline">
                <div class="mailbox-guide-inline-meta">
                  ${renderMailboxProviderIcon(draft.provider, state.providers, 'provider-icon-inline')}
                  <span>${escapeHtml(selectedProviderMeta.label)}</span>
                </div>
                <button class="mailbox-guide-chip" type="button" data-action="open-mailbox-guide">接入说明</button>
              </div>
              ${
                isGmailProvider || isOutlookProvider
                  ? `
                    <div class="mailbox-auth-card">
                      <div class="mailbox-auth-head">
                        <strong>${oauthTitle}</strong>
                        <span class="tag ${isOutlookProvider || usesOauth ? '' : 'subtle'}">${oauthRecommendedTag}</span>
                      </div>
                      ${
                        isGmailProvider
                          ? `
                            <div class="auth-mode-strip">
                              <label class="auth-mode-option ${!usesOauth ? 'active' : ''}">
                                <input
                                  name="authType"
                                  type="radio"
                                  value="password"
                                  ${!usesOauth ? 'checked' : ''}
                                  data-action="auth-type-change"
                                />
                                <span>${oauthSecondaryLabel}</span>
                              </label>
                              <label class="auth-mode-option ${usesOauth ? 'active' : ''}">
                                <input
                                  name="authType"
                                  type="radio"
                                  value="gmail_oauth"
                                  ${usesOauth ? 'checked' : ''}
                                  data-action="auth-type-change"
                                />
                                <span>${oauthPrimaryLabel}</span>
                              </label>
                            </div>
                          `
                          : `
                            <input type="hidden" name="authType" value="microsoft_oauth" />
                            <input type="hidden" name="microsoftTenantId" value="${escapeHtml(draft.microsoftTenantId || systemMicrosoftTenantId || 'common')}" />
                            <input type="hidden" name="microsoftProtocolMode" value="${simplifiedOutlookProtocolMode}" />
                            <div class="mailbox-oauth-note">
                              <span class="tag subtle">邮箱地址</span>
                              <span class="tag subtle">密码</span>
                              <span class="tag subtle">Client ID</span>
                              <span class="tag subtle">Refresh Token</span>
                              <span class="tag subtle">备注</span>
                            </div>
                          `
                      }
                      <p class="mailbox-auth-tip">${oauthIntroText}</p>
                    </div>
                  `
                  : '<input type="hidden" name="authType" value="password" />'
              }
              <label><span>显示名称</span><input name="name" value="${escapeHtml(draft.name || '')}" placeholder="例如：工作邮箱" /></label>
              <label>
                <span>${usesOauth ? oauthAddressLabel : '邮箱地址'}</span>
                <input
                  name="email"
                  type="email"
                  value="${escapeHtml(draft.email || '')}"
                  ${usesOauth ? '' : 'required'}
                  placeholder="${usesOauth ? oauthAddressPlaceholder : ''}"
                />
              </label>
              <label>
                <span>登录用户名</span>
                <input
                  name="username"
                  value="${escapeHtml(draft.username || '')}"
                  placeholder="${usesOauth ? '留空则自动使用授权邮箱' : '默认等于邮箱地址'}"
                />
              </label>
              ${
                usesOauth
                  ? `
                    <div class="mailbox-oauth-card">
                      <div class="mailbox-oauth-grid">
                        <label>
                          <span>${oauthClientIdLabel}</span>
                          <input
                            name="${oauthClientIdName}"
                            value="${escapeHtml(oauthClientIdValue)}"
                            placeholder="${isGmailProvider ? '来自 Google Cloud OAuth 2.0 Client' : '来自 Azure / Entra 应用注册'}"
                          />
                        </label>
                        <label>
                          <span>${oauthClientSecretLabel}</span>
                          <input
                            name="${oauthClientSecretName}"
                            type="password"
                            value="${escapeHtml(oauthClientSecretValue)}"
                            placeholder="${oauthConfigured ? '留空则继续使用当前已保存的 Secret' : '首次接入时需要填写'}"
                          />
                        </label>
                      </div>
                      ${
                        isMicrosoftOauth
                          ? `
                            <div class="mailbox-oauth-grid mailbox-oauth-grid-single">
                              <label>
                                <span>Tenant ID / 租户</span>
                                <input
                                  name="microsoftTenantId"
                                  value="${escapeHtml(draft.microsoftTenantId || 'common')}"
                                  placeholder="个人 Outlook 建议填 common；企业租户可填租户 ID"
                                />
                              </label>
                            </div>
                          `
                          : ''
                      }
                      <div class="mailbox-oauth-status ${oauthConfigured ? 'is-ready' : ''}">
                        <strong>${oauthConfigured ? '当前已授权' : '尚未完成授权'}</strong>
                        <span>${escapeHtml(
                          oauthConfigured
                            ? effectiveOauthEmail || `这个${isGmailProvider ? ' Gmail' : ' Outlook'}账号`
                            : `填写 Client 后点击下方“连接${oauthActionLabel}”完成授权`,
                        )}</span>
                      </div>
                      <div class="mailbox-oauth-actions">
                        <button
                          class="button ghost"
                          type="button"
                          data-action="${oauthConnectAction}"
                          ${isMicrosoftOauth && !systemMicrosoftConfigured ? 'disabled' : ''}
                        >${oauthConfigured ? `重新连接 ${oauthActionLabel}` : `连接 ${oauthActionLabel}`}</button>
                      </div>
                    </div>
                  `
                  : `
                    <label>
                      <span>IMAP 密码 / 授权码</span>
                      <div class="password-field">
                        <input
                          name="password"
                          type="${mailboxPasswordVisible ? 'text' : 'password'}"
                          value="${escapeHtml(draft.password || '')}"
                          ${isEditingMailbox ? '' : 'required'}
                          placeholder="${isEditingMailbox ? '留空则继续使用当前已保存的密码' : ''}"
                        />
                        <button
                          class="password-toggle-button ${mailboxPasswordVisible ? 'is-active' : ''}"
                          type="button"
                          data-action="toggle-mailbox-password"
                          aria-label="${mailboxPasswordVisible ? '隐藏 IMAP 密码' : '显示 IMAP 密码'}"
                        >
                          ${mailboxPasswordVisible ? '隐藏' : '显示'}
                        </button>
                      </div>
                    </label>
                  `
              }
              <div class="inline-grid">
                <label><span>IMAP 主机</span><input name="imapHost" value="${escapeHtml(draft.imapHost || '')}" required /></label>
                <label><span>端口</span><input name="imapPort" type="number" value="${escapeHtml(draft.imapPort || 993)}" required /></label>
              </div>
              <div class="inline-grid">
                <label><span>同步频率</span><select name="syncIntervalSeconds">${syncIntervalOptions(draft.syncIntervalSeconds || 5)}</select></label>
                <label class="check-field"><input name="secure" type="checkbox" ${draft.secure ? 'checked' : ''} /><span>启用 TLS / SSL</span></label>
              </div>
              <div class="mailbox-sync-settings">
                <label class="settings-switch-row mailbox-settings-switch">
                  <span class="settings-switch-copy">
                    <strong>附件同步</strong>
                    <small>勾选后，该邮箱会纳入系统设置里的手动本地附件同步范围；普通收信时只保留元数据，不会自动保存附件实体。</small>
                  </span>
                  <span class="settings-switch-control">
                    <input name="syncAttachments" type="checkbox" ${draft.syncAttachments ? 'checked' : ''} />
                    <span class="settings-switch-slider" aria-hidden="true"></span>
                  </span>
                </label>
              </div>
              <div class="note" data-provider-note>${escapeHtml(providerNote)}</div>
              <div class="form-actions">
                ${
                  usesOauth && !oauthConfigured
                    ? ''
                    : '<button class="button ghost" type="button" data-action="test-mailbox">测试连接</button>'
                }
                ${
                  isEditingMailbox
                    ? `<button class="button ghost" type="button" data-action="sync-mailbox" data-mailbox-id="${escapeHtml(draft.mailboxId)}">立即同步</button>`
                    : ''
                }
                <button class="button" type="submit">${
                  usesOauth && !oauthConfigured
                    ? isEditingMailbox
                      ? `连接 ${oauthActionLabel} 并更新`
                      : `连接 ${oauthActionLabel} 并接入`
                    : isEditingMailbox
                      ? '保存修改'
                      : '保存并接入'
                }</button>
              </div>
              ${
                isEditingMailbox
                  ? `
                    <div class="mailbox-modal-danger">
                      <button class="tiny-button danger" type="button" data-action="delete-mailbox" data-mailbox-id="${escapeHtml(draft.mailboxId)}">删除这个邮箱</button>
                    </div>
                  `
                  : ''
              }
            </form>
          </section>
        </div>
      `
    : '';

  return `
    <section class="view-grid view-grid-mailboxes mailbox-layout">
      <article class="panel">
        <div class="mailbox-head-strip">
          <div class="mailbox-head-title">
            ${renderAutoIcon('mailboxes', 'mailboxes', 'mailbox-head-icon')}
            <h3>邮箱账户</h3>
          </div>
          <div class="mailbox-head-controls">
            <div class="mailbox-provider-strip mailbox-provider-strip-compact">
              ${providerFilters
                .map(
                  (provider) => `
                    <button
                      class="provider-filter-chip ${state.mailboxProviderFilter === provider.id ? 'active' : ''}"
                      type="button"
                      data-action="set-mailbox-provider-filter"
                      data-provider="${escapeHtml(provider.id)}"
                    >
                      ${renderMailboxProviderIcon(provider.id, state.providers, 'provider-icon-inline')}
                      <span>${escapeHtml(provider.label)}</span>
                      <strong>${escapeHtml(provider.count)}</strong>
                    </button>
                  `,
                )
                .join('')}
            </div>
            ${ownerFilterCompact(state)}
            <label class="mailbox-search-shell mailbox-search-shell-compact" aria-label="搜索邮箱">
              <span class="mailbox-search-field">
                <span class="mailbox-search-icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24" focusable="false">
                    <path d="M10.5 4a6.5 6.5 0 1 0 4.06 11.58l4.43 4.43 1.41-1.41-4.43-4.43A6.5 6.5 0 0 0 10.5 4Zm0 2a4.5 4.5 0 1 1 0 9 4.5 4.5 0 0 1 0-9Z" fill="currentColor"/>
                  </svg>
                </span>
                <input
                  data-action="mailbox-search"
                  value="${escapeHtml(state.mailboxSearch || '')}"
                  placeholder="搜索邮箱名或邮箱地址"
                  aria-label="搜索邮箱"
                />
              </span>
            </label>
            <button class="button" type="button" data-action="create-mailbox">新增邮箱</button>
          </div>
        </div>
        <div class="mailbox-list">
          ${
            filteredMailboxes.length
              ? filteredMailboxes
                  .map(
                    (mailbox) => `
                      <article class="mailbox-row-card ${mailbox.id === state.editingMailboxId && state.mailboxModalOpen ? 'active' : ''}">
                        <div class="mailbox-row-body">
                          <button class="mailbox-row-main" type="button" data-action="open-mailbox-modal" data-mailbox-id="${escapeHtml(mailbox.id)}">
                            <div class="mailbox-row-top">
                              <div class="mailbox-row-title">
                                ${renderMailboxProviderIcon(mailbox.provider, state.providers)}
                                <div class="mailbox-row-title-copy">
                                  <strong>${escapeHtml(mailbox.name)}</strong>
                                  <div class="mailbox-row-title-meta">
                                    <span class="tag">${escapeHtml(mailboxProviderMeta(mailbox.provider, state.providers).label)}</span>
                                    <span class="status ${escapeHtml(mailbox.status)}">${escapeHtml(mailbox.status)}</span>
                                  </div>
                                </div>
                              </div>
                              <span class="mailbox-row-open">查看详情</span>
                            </div>
                            <p>${escapeHtml(mailbox.email)}</p>
                            <div class="mailbox-row-chips">
                              <span>${escapeHtml(mailbox.username)}</span>
                              <span>${escapeHtml(mailbox.imapHost)}:${escapeHtml(mailbox.imapPort)}</span>
                              ${
                                state.user.role === 'admin'
                                  ? `<span>${escapeHtml(mailbox.ownerName || mailbox.ownerEmail || '未分配')}</span>`
                                  : ''
                              }
                              <span>${escapeHtml((mailbox.syncIntervalSeconds || 5) + ' 秒刷新')}</span>
                            </div>
                          </button>
                        </div>
                        <div class="mailbox-row-actions">
                          <button class="tiny-button" type="button" data-action="sync-mailbox" data-mailbox-id="${escapeHtml(mailbox.id)}">同步</button>
                          <button class="tiny-button" type="button" data-action="open-mailbox-modal" data-mailbox-id="${escapeHtml(mailbox.id)}">打开</button>
                          <button class="tiny-button danger" type="button" data-action="delete-mailbox" data-mailbox-id="${escapeHtml(mailbox.id)}">删除</button>
                        </div>
                        ${mailbox.lastError ? `<div class="notice error">${escapeHtml(mailbox.lastError)}</div>` : ''}
                      </article>
                    `,
                  )
                  .join('')
              : '<div class="empty-card">当前筛选条件下没有匹配的邮箱账号。</div>'
          }
        </div>
      </article>
      ${modalMarkup}
      ${importModalMarkup}
      ${guideModalMarkup}
    </section>
  `;
}

function renderMailboxesWorkspaceV2(state) {
  const defaultProviderId =
    state.providers.find((provider) => provider.id === 'gmail')?.id || state.providers[0]?.id || 'generic';
  const fallbackPreset =
    state.providers.find((provider) => provider.id === defaultProviderId) || state.providers[0] || {};
  const draft = state.mailboxDraft || {
    mailboxId: '',
    ownerUserId: state.selectedOwnerUserId || state.user.id,
    provider: defaultProviderId,
    name: '',
    email: '',
    username: '',
    password: '',
    imapHost: fallbackPreset.imapHost || '',
    imapPort: Number(fallbackPreset.imapPort || 993),
    syncIntervalSeconds: 5,
    sortOrder: 100,
    isPinned: false,
    secure: Boolean(fallbackPreset.secure),
  };
  const isEditingMailbox = Boolean(draft.mailboxId);
  const activeMailbox = draft.mailboxId
    ? state.mailboxes.find((mailbox) => mailbox.id === draft.mailboxId) || null
    : null;
  const selectedOwnerUserId = draft.ownerUserId || state.selectedOwnerUserId || state.user.id;
  const selectedProvider =
    state.providers.find((provider) => provider.id === draft.provider) || fallbackPreset;
  const selectedProviderMeta = mailboxProviderMeta(draft.provider, state.providers);
  const isGmailProvider = draft.provider === 'gmail';
  const isOutlookProvider = draft.provider === 'outlook';
  const isGmailOauth = isGmailProvider && draft.authType !== 'password';
  const isMicrosoftOauth = isOutlookProvider;
  const usesOauth = isGmailOauth || isMicrosoftOauth;
  const mailboxPasswordVisible = Boolean(state.mailboxPasswordVisible);
  const oauthConfigured = Boolean(draft.oauthConfigured);
  const oauthGraphReady = Boolean(draft.oauthGraphReady);
  const oauthImapReady = Boolean(draft.oauthImapReady);
  const microsoftProtocolMode = String(draft.microsoftProtocolMode || 'graph_imap_dual').trim() || 'graph_imap_dual';
  const simplifiedOutlookProtocolMode = 'graph_only';
  const isOutlookOauthMode = isMicrosoftOauth && microsoftProtocolMode !== simplifiedOutlookProtocolMode;
  const isOutlookGraphMode = isMicrosoftOauth && !isOutlookOauthMode;
  const hasManualMicrosoftRefreshToken = Boolean(
    String(draft.microsoftRefreshToken || draft.microsoftGraphRefreshToken || draft.microsoftImapRefreshToken || '').trim(),
  );
  const systemSettings = normalizeSystemSettings(state.systemSettings);
  const systemMicrosoftClientIdValue = String(systemSettings.microsoftClientId || '').trim();
  const systemMicrosoftConfigured = Boolean(systemSettings.microsoftAppConfigured && systemMicrosoftClientIdValue);
  const systemMicrosoftTenantId = String(systemSettings.microsoftTenantId || 'common').trim() || 'common';
  const manualMicrosoftClientId = String(draft.microsoftClientId || '').trim();
  const canStartMicrosoftOauth = systemMicrosoftConfigured || Boolean(manualMicrosoftClientId);
  const effectiveOauthEmail = draft.oauthEmail || draft.email || '';
  const outlookRefreshTokenPlaceholder = isEditingMailbox
    ? '留空则继续使用当前已保存的 Refresh Token；要更换时再粘贴新令牌'
    : '粘贴 Microsoft Graph Refresh Token';
  const providerNote = selectedProvider?.note || '';
  const oauthTitle = isGmailProvider ? 'Gmail 登录方式' : isOutlookProvider ? 'Outlook 登录方式' : '';
  const oauthRecommendedTag = isOutlookProvider ? 'Graph 方式' : usesOauth ? '推荐 OAuth2' : '应用专用密码';
  const oauthPrimaryLabel = isGmailProvider ? 'Google OAuth2' : 'Microsoft OAuth2';
  const oauthSecondaryLabel = isGmailProvider ? '应用专用密码' : 'IMAP 密码 / 应用密码';
  const oauthActionLabel = isGmailProvider ? 'Google' : 'Microsoft';
  const oauthClientIdName = isGmailProvider ? 'googleClientId' : 'microsoftClientId';
  const oauthClientSecretName = isGmailProvider ? 'googleClientSecret' : 'microsoftClientSecret';
  const oauthClientIdValue = isGmailProvider ? draft.googleClientId || '' : draft.microsoftClientId || '';
  const oauthClientSecretValue = isGmailProvider ? draft.googleClientSecret || '' : draft.microsoftClientSecret || '';
  const oauthClientIdLabel = isGmailProvider ? 'Google Client ID' : 'Microsoft Client ID';
  const oauthClientSecretLabel = isGmailProvider ? 'Google Client Secret' : 'Microsoft Client Secret';
  const oauthConnectAction = isGmailProvider ? 'start-google-oauth' : 'start-microsoft-oauth';
  const oauthAddressLabel = isGmailProvider ? 'Gmail 地址（可留空，授权后自动识别）' : 'Outlook 邮箱地址（建议填写）';
  const oauthAddressPlaceholder = isGmailProvider ? '例如：yourname@gmail.com' : '例如：name@outlook.com';
  const oauthIntroText = isGmailProvider
    ? 'Gmail 当前默认使用应用专用密码 / IMAP 方式；如果账号不支持应用专用密码，再切到 Google OAuth2。'
    : isOutlookOauthMode
      ? systemMicrosoftConfigured
        ? 'Outlook / Microsoft 365 的 OAuth2 登录会直接调用“系统设置”里已保存的 Microsoft 应用配置，不再单独要求你在这里重复填写。'
        : '当前系统还没有保存 Microsoft 应用配置，请先到“系统设置”完成配置，随后再回来点击“连接 Microsoft”。'
      : 'Outlook / Microsoft 365 在这里直接按 Graph 参数接入即可，不再显示应用密码那套字段。';
  const providerOptions = state.providers
    .map(
      (provider) => `
        <option value="${escapeHtml(provider.id)}" ${provider.id === draft.provider ? 'selected' : ''}>
          ${escapeHtml(mailboxProviderMeta(provider.id, state.providers).label)}
        </option>
      `,
    )
    .join('');
  const mailboxOwnerSearchTokens = tokenizeSearchQuery(state.mailboxOwnerSearch);
  const mailboxOwnerCandidates = Array.isArray(state.usersForAssignment) ? state.usersForAssignment : [];
  const selectedMailboxOwner =
    mailboxOwnerCandidates.find((user) => user.id === selectedOwnerUserId) || mailboxOwnerCandidates[0] || null;
  const resolvedOwnerUserId = selectedMailboxOwner?.id || selectedOwnerUserId || state.user.id;
  const mailboxOwnerMatches = mailboxOwnerCandidates.filter((user) => {
    if (!mailboxOwnerSearchTokens.length) {
      return true;
    }

    const haystack = [
      user.name,
      user.username,
      user.email,
      formatUserHandle(user),
      formatUserContact(user),
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();

    return mailboxOwnerSearchTokens.every((token) => haystack.includes(token));
  });
  const mailboxOwnerOptions = mergeSelectedSearchOption(
    mailboxOwnerMatches,
    selectedMailboxOwner,
    mailboxOwnerSearchTokens,
  );
  const ownerField =
    state.user.role === 'admin'
      ? `
          <label class="mailbox-grid-field mailbox-owner-field">
            <span>归属用户</span>
            <input type="hidden" name="ownerUserId" value="${escapeHtml(resolvedOwnerUserId)}" />
            <div class="inbox-mailbox-filter mailbox-owner-picker ${state.mailboxOwnerFilterOpen ? 'is-open' : ''}" data-mailbox-owner-filter>
              <button
                class="inbox-mailbox-trigger"
                type="button"
                data-action="toggle-mailbox-owner-filter"
                aria-expanded="${state.mailboxOwnerFilterOpen ? 'true' : 'false'}"
                ${mailboxOwnerCandidates.length ? '' : 'disabled'}
              >
                <span class="inbox-mailbox-trigger-main">
                  ${
                    selectedMailboxOwner
                      ? renderAvatar(
                          selectedMailboxOwner.avatarUrl,
                          userInitials(selectedMailboxOwner),
                          'filter-user-avatar',
                          selectedMailboxOwner.name || selectedMailboxOwner.username || 'user',
                        )
                      : renderAvatar('', '未', 'filter-user-avatar', 'owner user')
                  }
                  <span class="inbox-mailbox-trigger-copy">
                    <strong>${escapeHtml(selectedMailboxOwner?.name || selectedMailboxOwner?.username || '请选择用户')}</strong>
                  </span>
                </span>
                <span class="inbox-mailbox-trigger-side">
                  <span class="inbox-mailbox-trigger-meta">${escapeHtml(
                    selectedMailboxOwner
                      ? formatUserHandle(selectedMailboxOwner)
                      : mailboxOwnerCandidates.length
                        ? `${mailboxOwnerCandidates.length} 个用户`
                        : '暂无可分配用户',
                  )}</span>
                  <span class="inbox-mailbox-trigger-caret" aria-hidden="true"></span>
                </span>
              </button>
              ${
                state.mailboxOwnerFilterOpen
                  ? `
                      <div class="inbox-mailbox-panel">
                        <label class="inbox-mailbox-search-shell">
                          <span class="inbox-mailbox-search-icon" aria-hidden="true">&#8981;</span>
                          <input
                            data-action="mailbox-owner-search"
                            value="${escapeHtml(state.mailboxOwnerSearch || '')}"
                            placeholder="${escapeHtml('搜索昵称、用户名、邮箱')}"
                            autocomplete="off"
                          />
                        </label>
                        <div class="inbox-mailbox-option-list">
                          ${
                            mailboxOwnerOptions.length
                              ? mailboxOwnerOptions
                                  .map(
                                    (user) => `
                                      <button
                                        class="inbox-mailbox-option ${user.id === resolvedOwnerUserId ? 'is-active' : ''}"
                                        type="button"
                                        data-action="select-mailbox-owner"
                                        data-user-id="${escapeHtml(user.id)}"
                                      >
                                        <span class="inbox-mailbox-option-main">
                                          ${renderAvatar(
                                            user.avatarUrl,
                                            userInitials(user),
                                            'filter-user-avatar',
                                            user.name || user.username || 'user',
                                          )}
                                          <span class="inbox-mailbox-option-copy">
                                            <strong>${escapeHtml(user.name || user.username || '未命名用户')}</strong>
                                            <small>${escapeHtml(formatUserHandle(user))}</small>
                                          </span>
                                        </span>
                                        <span class="inbox-mailbox-option-meta">${escapeHtml(
                                          user.role === 'admin' ? '管理员' : '用户',
                                        )}</span>
                                      </button>
                                    `,
                                  )
                                  .join('')
                              : `<div class="inbox-mailbox-empty">${escapeHtml('没有匹配的用户')}</div>`
                          }
                        </div>
                      </div>
                    `
                  : ''
              }
            </div>
          </label>
        `
      : `<input type="hidden" name="ownerUserId" value="${escapeHtml(resolvedOwnerUserId)}" />`;
  const displayOrderHint = draft.isPinned
    ? `已置顶显示，排序值 ${Number(draft.sortOrder ?? 100)}。`
    : `排序值越小越靠前，0 会排在最前；常规邮箱建议保持 100。`;
  const providerCounts = state.mailboxes.reduce((counts, mailbox) => {
    const providerId = mailbox.provider || 'generic';
    counts.set(providerId, (counts.get(providerId) || 0) + 1);
    return counts;
  }, new Map());
  const providerFilters = [
    {
      id: 'all',
      count: state.mailboxes.length,
      ...mailboxProviderMeta('all', state.providers),
    },
    ...Array.from(providerCounts.entries()).map(([providerId, count]) => ({
      count,
      ...mailboxProviderMeta(providerId, state.providers),
    })),
  ];
  const filteredMailboxes = state.mailboxes.filter((mailbox) => {
    const providerMatched =
      !state.mailboxProviderFilter ||
      state.mailboxProviderFilter === 'all' ||
      mailbox.provider === state.mailboxProviderFilter;
    const searchMatched = mailboxMatchesQuery(mailbox, state.mailboxSearch, state.providers);
    return providerMatched && searchMatched;
  });
  const mailboxPageSize = PAGE_SIZE_OPTIONS.includes(Number(state.mailboxPageSize))
    ? Number(state.mailboxPageSize)
    : 10;
  const mailboxTotalItems = filteredMailboxes.length;
  const mailboxTotalPages = Math.max(1, Math.ceil(mailboxTotalItems / mailboxPageSize));
  const mailboxPage = Math.min(Math.max(Number(state.mailboxPage || 1), 1), mailboxTotalPages);
  const mailboxPageItems = filteredMailboxes.slice(
    (mailboxPage - 1) * mailboxPageSize,
    (mailboxPage - 1) * mailboxPageSize + mailboxPageSize,
  );
  const selectedMailboxIds = new Set(state.selectedMailboxIds || []);
  const allVisibleMailboxesSelected =
    Boolean(mailboxPageItems.length) && mailboxPageItems.every((mailbox) => selectedMailboxIds.has(mailbox.id));
  const mailboxSelectionCount = selectedMailboxIds.size;
  const mailboxBulkDisabled = mailboxSelectionCount ? '' : 'disabled';
  const visibleFieldIds = Array.isArray(state.mailboxVisibleFields) ? state.mailboxVisibleFields : [];
  const guideModalMarkup =
    state.mailboxModalOpen && state.mailboxGuideOpen ? renderMailboxGuideModal(state, draft.provider) : '';
  const importDraft = state.mailboxImportDraft || {
    ownerUserId: state.selectedOwnerUserId || state.user.id,
    importText: '',
    microsoftClientSecret: '',
    microsoftTenantId: systemMicrosoftTenantId,
    microsoftProtocolMode: 'graph_imap_dual',
    imapHost: 'outlook.office365.com',
    imapPort: 993,
    secure: true,
    syncIntervalSeconds: 5,
    sortOrder: 100,
    isPinned: false,
  };
  const importModalMarkup = state.mailboxImportModalOpen
    ? `
        <div class="modal-shell">
          <div class="modal-backdrop" data-mailbox-import-overlay></div>
          <section class="modal-panel mailbox-modal mailbox-import-modal">
            <div class="panel-header">
              ${renderSectionTitle(
                'outlook',
                `
                  <h3>批量导入 Outlook / Graph</h3>
                  <p>支持固定格式文本或文件批量导入。你既可以手动逐个填写 Outlook OAuth 参数，也可以在这里一次性导入多组 Graph / OAuth 邮箱。</p>
                `,
                'mailbox-modal-title',
              )}
              <button class="button ghost" type="button" data-action="close-mailbox-import-modal">关闭</button>
            </div>
            ${state.mailboxImportNotice ? renderNotice(state.mailboxImportNotice) : ''}
            <form data-form="mailbox-import" class="stack mailbox-form mailbox-modal-form">
              <div class="mailbox-config-grid mailbox-config-grid-top">
                <label class="mailbox-grid-field">
                  <span>归属用户</span>
                  <select name="ownerUserId">
                    ${(Array.isArray(state.usersForAssignment) ? state.usersForAssignment : [])
                      .map(
                        (user) => `
                          <option value="${escapeHtml(user.id)}" ${user.id === (importDraft.ownerUserId || state.user.id) ? 'selected' : ''}>
                            ${escapeHtml(user.name || user.username || user.email || '用户')}
                          </option>
                        `,
                      )
                      .join('')}
                  </select>
                </label>
                <label class="mailbox-grid-field">
                  <span>目录（租户）ID / Tenant</span>
                  <input value="${escapeHtml(importDraft.microsoftTenantId || systemMicrosoftTenantId)}" disabled />
                  <input name="microsoftTenantId" type="hidden" value="${escapeHtml(importDraft.microsoftTenantId || systemMicrosoftTenantId)}" />
                </label>
                <label class="mailbox-grid-field">
                  <span>协议模式</span>
                  <select name="microsoftProtocolMode">
                    <option value="graph_imap_dual" ${String(importDraft.microsoftProtocolMode || '') === 'graph_imap_dual' ? 'selected' : ''}>Graph API + IMAP</option>
                    <option value="graph_only" ${String(importDraft.microsoftProtocolMode || '') === 'graph_only' ? 'selected' : ''}>仅 Graph API</option>
                    <option value="imap_only" ${String(importDraft.microsoftProtocolMode || '') === 'imap_only' ? 'selected' : ''}>仅 IMAP</option>
                  </select>
                </label>
              </div>
              <div class="mailbox-config-grid mailbox-config-grid-compact">
                <label class="mailbox-grid-field">
                  <span>默认 IMAP Host</span>
                  <input name="imapHost" value="${escapeHtml(importDraft.imapHost || 'outlook.office365.com')}" />
                </label>
                <label class="mailbox-grid-field">
                  <span>端口</span>
                  <input name="imapPort" type="number" value="${escapeHtml(importDraft.imapPort || 993)}" />
                </label>
                <label class="mailbox-grid-field">
                  <span>同步频率</span>
                  <select name="syncIntervalSeconds">${syncIntervalOptions(importDraft.syncIntervalSeconds || 5)}</select>
                </label>
                <label class="mailbox-grid-field">
                  <span>排序值</span>
                  <input name="sortOrder" type="number" min="0" step="1" value="${escapeHtml(importDraft.sortOrder ?? 100)}" />
                </label>
              </div>
              <div class="mailbox-toggle-strip">
                <label class="check-field mailbox-toggle-card">
                  <input name="secure" type="checkbox" ${importDraft.secure ? 'checked' : ''} />
                  <span>启用 TLS / SSL</span>
                </label>
                <label class="check-field mailbox-toggle-card">
                  <input name="isPinned" type="checkbox" ${importDraft.isPinned ? 'checked' : ''} />
                  <span>导入后置顶</span>
                </label>
              </div>
              <label class="mailbox-grid-field mailbox-grid-field-full">
                <span>导入文件</span>
                <input name="importFile" type="file" accept=".txt,.csv" />
              </label>
              <label class="mailbox-grid-field mailbox-grid-field-full">
                <span>或直接粘贴配置</span>
                <textarea
                  name="importText"
                  rows="9"
                  placeholder="每行一个账号，支持以下格式：&#10;邮箱----ClientId----RefreshToken&#10;邮箱----密码----ClientId----RefreshToken&#10;邮箱----密码----ClientId----RefreshToken----Tenant----graph_only"
                >${escapeHtml(importDraft.importText || '')}</textarea>
              </label>
              <div class="mailbox-oauth-note">
                <span class="tag subtle">Graph 示例：邮箱----密码占位----ClientId----RefreshToken----common----graph_only</span>
                <span class="tag subtle">支持 3 / 4 / 5 / 6 / 7 段格式</span>
                <span class="tag subtle">额外字段可继续补 Tenant / 协议 / Client Secret</span>
              </div>
              <div class="form-actions mailbox-modal-actions">
                <div class="mailbox-modal-actions-left">
                  <span class="note">如果文本里已经写了 <code>graph</code> / <code>graph_only</code>，系统会自动识别为 Graph 模式；没写协议时则按上面所选协议批量导入。</span>
                </div>
                <div class="mailbox-modal-actions-right">
                  <button class="button ghost" type="button" data-action="close-mailbox-import-modal">取消</button>
                  <button class="button" type="submit">开始导入</button>
                </div>
              </div>
            </form>
          </section>
        </div>
      `
    : '';
  const modalMarkup = state.mailboxModalOpen
    ? `
        <div class="modal-shell">
          <div class="modal-backdrop" data-mailbox-overlay></div>
          <section class="modal-panel mailbox-modal">
            <div class="panel-header">
              ${renderSectionTitle(
                'mailboxes',
                `
                  <h3>${isEditingMailbox ? '邮箱详情与编辑' : '新增邮箱'}</h3>
                  <p>${isEditingMailbox ? '在这里直接修改邮箱参数、排序和置顶状态。' : '填写邮箱参数后即可接入系统，所有字段会按更紧凑的方式排列。'}</p>
                `,
                'mailbox-modal-title',
              )}
              <button class="button ghost" type="button" data-action="close-mailbox-modal">关闭</button>
            </div>
            ${state.mailboxNotice ? renderNotice(state.mailboxNotice) : ''}
            ${
              activeMailbox
                ? `
                  <div class="mailbox-modal-summary">
                    <div class="mailbox-summary-card">
                      <span>邮箱地址</span>
                      <strong>${escapeHtml(activeMailbox.email)}</strong>
                    </div>
                    <div class="mailbox-summary-card">
                      <span>邮箱厂商</span>
                      <strong class="mailbox-summary-provider">
                        ${renderMailboxProviderIcon(activeMailbox.provider, state.providers, 'provider-icon-inline provider-icon-summary')}
                        <span>${escapeHtml(mailboxProviderMeta(activeMailbox.provider, state.providers).label)}</span>
                      </strong>
                    </div>
                    <div class="mailbox-summary-card">
                      <span>未读邮件</span>
                      <strong>${escapeHtml(activeMailbox.unreadCount)}</strong>
                    </div>
                    <div class="mailbox-summary-card">
                      <span>显示顺序</span>
                      <strong>${activeMailbox.isPinned ? '置顶' : '普通'} / ${escapeHtml(activeMailbox.sortOrder ?? 100)}</strong>
                    </div>
                  </div>
                `
                : ''
            }
            <form data-form="mailbox" class="stack mailbox-form mailbox-modal-form">
              <input type="hidden" name="mailboxId" value="${escapeHtml(draft.mailboxId || '')}" />
              <input type="hidden" name="oauthConfigured" value="${oauthConfigured ? 'true' : 'false'}" />
              <input type="hidden" name="oauthGraphReady" value="${oauthGraphReady ? 'true' : 'false'}" />
              <input type="hidden" name="oauthImapReady" value="${oauthImapReady ? 'true' : 'false'}" />
              <input type="hidden" name="oauthEmail" value="${escapeHtml(effectiveOauthEmail)}" />
              <div class="mailbox-config-grid mailbox-config-grid-top">
                <label class="mailbox-grid-field">
                  <span>邮箱类型</span>
                  <select name="provider" data-action="provider-change">${providerOptions}</select>
                </label>
                ${ownerField}
                <div class="mailbox-guide-slot">
                  <span class="mailbox-guide-slot-label" aria-hidden="true">接入说明</span>
                  <div class="mailbox-guide-inline mailbox-grid-card">
                    <div class="mailbox-guide-inline-meta">
                      ${renderMailboxProviderIcon(draft.provider, state.providers, 'provider-icon-inline')}
                      <span>${escapeHtml(selectedProviderMeta.label)}</span>
                    </div>
                    <button class="mailbox-guide-chip" type="button" data-action="open-mailbox-guide">接入说明</button>
                  </div>
                </div>
              </div>
              ${
                isGmailProvider || isOutlookProvider
                  ? `
                    <div class="mailbox-auth-card">
                      <div class="mailbox-auth-head">
                        <strong>${oauthTitle}</strong>
                        <span class="tag ${isOutlookProvider || usesOauth ? '' : 'subtle'}">${oauthRecommendedTag}</span>
                      </div>
                      ${
                        isGmailProvider
                          ? `
                            <div class="auth-mode-strip">
                              <label class="auth-mode-option ${!usesOauth ? 'active' : ''}">
                                <input
                                  name="authType"
                                  type="radio"
                                  value="password"
                                  ${!usesOauth ? 'checked' : ''}
                                  data-action="auth-type-change"
                                />
                                <span>${oauthSecondaryLabel}</span>
                              </label>
                              <label class="auth-mode-option ${usesOauth ? 'active' : ''}">
                                <input
                                  name="authType"
                                  type="radio"
                                  value="gmail_oauth"
                                  ${usesOauth ? 'checked' : ''}
                                  data-action="auth-type-change"
                                />
                                <span>${oauthPrimaryLabel}</span>
                              </label>
                            </div>
                          `
                          : `
                            <input type="hidden" name="authType" value="microsoft_oauth" />
                            <input type="hidden" name="microsoftTenantId" value="${escapeHtml(draft.microsoftTenantId || systemMicrosoftTenantId || 'common')}" />
                            <input
                              type="hidden"
                              name="microsoftProtocolMode"
                              value="${escapeHtml(isOutlookOauthMode ? 'graph_imap_dual' : simplifiedOutlookProtocolMode)}"
                            />
                            <div class="auth-mode-strip">
                              <button
                                class="auth-mode-option ${isOutlookGraphMode ? 'active' : ''}"
                                type="button"
                                data-action="set-outlook-entry-mode"
                                data-mode="${simplifiedOutlookProtocolMode}"
                              >
                                <span>Graph 参数</span>
                              </button>
                              <button
                                class="auth-mode-option ${isOutlookOauthMode ? 'active' : ''}"
                                type="button"
                                data-action="set-outlook-entry-mode"
                                data-mode="graph_imap_dual"
                              >
                                <span>OAuth2 登录</span>
                              </button>
                            </div>
                          `
                      }
                      <p class="mailbox-auth-tip">${oauthIntroText}</p>
                    </div>
                  `
                  : '<input type="hidden" name="authType" value="password" />'
              }
              ${
                isMicrosoftOauth
                  ? `
                    <div class="mailbox-oauth-grid mailbox-oauth-grid-single">
                      <label>
                        <span>邮箱地址</span>
                        <input
                          name="email"
                          type="email"
                          value="${escapeHtml(draft.email || '')}"
                          required
                          placeholder="例如：name@outlook.com"
                        />
                      </label>
                    </div>
                  `
                  : `
                    <div class="mailbox-config-grid">
                      <label class="mailbox-grid-field">
                        <span>显示名称</span>
                        <input name="name" value="${escapeHtml(draft.name || '')}" placeholder="例如：工作邮箱" />
                      </label>
                      <label class="mailbox-grid-field">
                        <span>${usesOauth ? oauthAddressLabel : '邮箱地址'}</span>
                        <input
                          name="email"
                          type="email"
                          value="${escapeHtml(draft.email || '')}"
                          ${usesOauth ? '' : 'required'}
                          placeholder="${usesOauth ? oauthAddressPlaceholder : '例如：name@example.com'}"
                        />
                      </label>
                      <label class="mailbox-grid-field">
                        <span>登录用户名</span>
                        <input
                          name="username"
                          value="${escapeHtml(draft.username || '')}"
                          placeholder="${usesOauth ? '留空则自动使用授权邮箱' : '默认等于邮箱地址'}"
                        />
                      </label>
                    </div>
                  `
              }
              ${
                usesOauth
                  ? `
                    <div class="mailbox-oauth-card">
                      ${
                        isMicrosoftOauth
                          ? `
                            ${
                              isOutlookGraphMode
                                ? `
                                  <div class="mailbox-oauth-grid">
                                    <label>
                                      <span>密码</span>
                                      <div class="password-field">
                                        <input
                                          name="password"
                                          type="${mailboxPasswordVisible ? 'text' : 'password'}"
                                          value="${escapeHtml(draft.password || '')}"
                                          placeholder="${isEditingMailbox ? '留空则继续使用当前已保存的密码' : '密码'}"
                                        />
                                        <button
                                          class="password-toggle-button ${mailboxPasswordVisible ? 'is-active' : ''}"
                                          type="button"
                                          data-action="toggle-mailbox-password"
                                          aria-label="${mailboxPasswordVisible ? '隐藏密码' : '显示密码'}"
                                        >
                                          ${mailboxPasswordVisible ? '隐藏' : '显示'}
                                        </button>
                                      </div>
                                    </label>
                                    <label>
                                      <span>客户端 ID</span>
                                      <input
                                        name="microsoftClientId"
                                        value="${escapeHtml(draft.microsoftClientId || '')}"
                                        ${systemMicrosoftConfigured ? '' : 'required'}
                                        placeholder="Azure App Client ID"
                                      />
                                    </label>
                                  </div>
                                  <div class="mailbox-oauth-grid mailbox-oauth-grid-single">
                                    <label>
                                      <span>刷新令牌</span>
                                      <textarea
                                        name="microsoftRefreshToken"
                                        rows="4"
                                        ${isEditingMailbox ? '' : 'required'}
                                        placeholder="${outlookRefreshTokenPlaceholder}"
                                      >${escapeHtml(draft.microsoftRefreshToken || '')}</textarea>
                                    </label>
                                  </div>
                                  <div class="mailbox-oauth-grid mailbox-oauth-grid-single">
                                    <label>
                                      <span>备注</span>
                                      <input
                                        name="name"
                                        value="${escapeHtml(draft.name || '')}"
                                        placeholder="可选备注信息"
                                      />
                                    </label>
                                  </div>
                                  <div class="mailbox-oauth-note">
                                    <span class="tag subtle">接入方式固定为 Graph</span>
                                    <span class="tag subtle">Tenant 默认使用 ${escapeHtml(draft.microsoftTenantId || systemMicrosoftTenantId || 'common')}</span>
                                    <span class="tag subtle">${hasManualMicrosoftRefreshToken ? '已填写 Refresh Token，可直接保存' : '填写 Client ID 与 Refresh Token 后即可接入'}</span>
                                  </div>
                                `
                                : `
                                  <input type="hidden" name="password" value="" />
                                  <input type="hidden" name="microsoftRefreshToken" value="" />
                                  <div class="mailbox-oauth-grid mailbox-oauth-grid-single">
                                    <label>
                                      <span>备注</span>
                                      <input
                                        name="name"
                                        value="${escapeHtml(draft.name || '')}"
                                        placeholder="可选备注信息"
                                      />
                                    </label>
                                  </div>
                                  ${
                                    systemMicrosoftConfigured
                                      ? `
                                        <input type="hidden" name="microsoftClientId" value="${escapeHtml(systemMicrosoftClientIdValue)}" />
                                      `
                                      : `
                                        <div class="mailbox-oauth-grid mailbox-oauth-grid-single">
                                          <label>
                                            <span>客户端 ID</span>
                                            <input
                                              name="microsoftClientId"
                                              value="${escapeHtml(draft.microsoftClientId || '')}"
                                              required
                                              placeholder="Azure App Client ID"
                                            />
                                          </label>
                                        </div>
                                      `
                                  }
                                  <div class="mailbox-oauth-note">
                                    <span class="tag subtle">接入方式为 OAuth2 授权</span>
                                    <span class="tag subtle">不需要手动填写 Refresh Token</span>
                                    <span class="tag subtle">${
                                      systemMicrosoftConfigured
                                        ? '已自动读取系统设置里的 Microsoft 应用配置'
                                        : canStartMicrosoftOauth
                                          ? '点击下方即可跳转 Microsoft 登录授权'
                                          : '请先配置系统 Microsoft 应用或填写 Client ID'
                                    }</span>
                                  </div>
                                `
                            }
                          `
                          : `
                            <div class="mailbox-oauth-grid">
                              <label>
                                <span>${oauthClientIdLabel}</span>
                                <input
                                  name="${oauthClientIdName}"
                                  value="${escapeHtml(oauthClientIdValue)}"
                                  placeholder="来自 Google Cloud OAuth 2.0 Client"
                                />
                              </label>
                              <label>
                                <span>${oauthClientSecretLabel}</span>
                                <input
                                  name="${oauthClientSecretName}"
                                  type="password"
                                  value="${escapeHtml(oauthClientSecretValue)}"
                                  placeholder="${oauthConfigured ? '留空则继续使用当前已保存的 Secret' : '首次接入时需要填写'}"
                                />
                              </label>
                            </div>
                          `
                      }
                      ${
                        isMicrosoftOauth
                          ? `
                            <div class="mailbox-oauth-status ${oauthConfigured ? 'is-ready' : ''}">
                              <strong>${oauthConfigured ? '当前已接入' : isOutlookOauthMode ? '等待 OAuth2 授权' : '等待保存接入'}</strong>
                              <span>${escapeHtml(
                                oauthConfigured
                                  ? effectiveOauthEmail || '当前 Outlook 账号'
                                  : isOutlookOauthMode
                                    ? canStartMicrosoftOauth
                                      ? '当前为 OAuth2 登录模式，点击下方按钮即可完成 Microsoft 授权接入。'
                                      : '请先配置系统 Microsoft 应用，或填写当前邮箱专用的 Client ID。'
                                    : hasManualMicrosoftRefreshToken
                                      ? '已填写 Graph 参数，保存后会直接接入 Outlook。'
                                      : '当前表单仅保留 Graph 直连需要的几个值，不再显示应用密码或 IMAP 登录字段。',
                              )}</span>
                            </div>
                            ${
                              isOutlookOauthMode
                                ? `
                                  <div class="mailbox-oauth-actions">
                                    <button
                                      class="button ghost"
                                      type="button"
                                      data-action="${oauthConnectAction}"
                                      ${!canStartMicrosoftOauth ? 'disabled' : ''}
                                    >${oauthConfigured ? `重新连接 ${oauthActionLabel}` : `连接 ${oauthActionLabel}`}</button>
                                  </div>
                                `
                                : !isEditingMailbox
                                ? `
                                  <div class="mailbox-oauth-actions">
                                    <button
                                      class="button ghost"
                                      type="button"
                                      data-action="open-microsoft-mailbox-import"
                                    >批量导入 Graph</button>
                                  </div>
                                `
                                : ''
                            }
                          `
                          : `
                            <div class="mailbox-oauth-status ${oauthConfigured ? 'is-ready' : ''}">
                              <strong>${oauthConfigured ? '当前已授权' : '尚未完成授权'}</strong>
                              <span>${escapeHtml(
                                oauthConfigured
                                  ? effectiveOauthEmail || `这个${isGmailProvider ? ' Gmail' : ' Outlook'} 账号`
                                  : `填写 Client 后点击下方“连接 ${oauthActionLabel}”完成授权`,
                              )}</span>
                            </div>
                            <div class="mailbox-oauth-actions">
                              <button
                                class="button ghost"
                                type="button"
                                data-action="${oauthConnectAction}"
                              >${oauthConfigured ? `重新连接 ${oauthActionLabel}` : `连接 ${oauthActionLabel}`}</button>
                            </div>
                          `
                      }
                    </div>
                  `
                  : `
                    <label class="mailbox-grid-field mailbox-grid-field-full">
                      <span>IMAP 密码 / 授权码</span>
                      <div class="password-field">
                        <input
                          name="password"
                          type="${mailboxPasswordVisible ? 'text' : 'password'}"
                          value="${escapeHtml(draft.password || '')}"
                          ${isEditingMailbox ? '' : 'required'}
                          placeholder="${isEditingMailbox ? '留空则继续使用当前已保存的密码' : ''}"
                        />
                        <button
                          class="password-toggle-button ${mailboxPasswordVisible ? 'is-active' : ''}"
                          type="button"
                          data-action="toggle-mailbox-password"
                          aria-label="${mailboxPasswordVisible ? '隐藏 IMAP 密码' : '显示 IMAP 密码'}"
                        >
                          ${mailboxPasswordVisible ? '隐藏' : '显示'}
                        </button>
                      </div>
                    </label>
                  `
              }
              ${
                isMicrosoftOauth
                  ? `
                    <input type="hidden" name="imapHost" value="${escapeHtml(draft.imapHost || 'outlook.office365.com')}" />
                    <input type="hidden" name="imapPort" value="${escapeHtml(draft.imapPort || 993)}" />
                    <input type="hidden" name="secure" value="on" />
                    <div class="mailbox-config-grid mailbox-config-grid-compact">
                      <label class="mailbox-grid-field">
                        <span>同步频率</span>
                        <select name="syncIntervalSeconds">${syncIntervalOptions(draft.syncIntervalSeconds || 5)}</select>
                      </label>
                      <label class="mailbox-grid-field">
                        <span>排序值</span>
                        <input name="sortOrder" type="number" min="0" step="1" value="${escapeHtml(draft.sortOrder ?? 100)}" />
                      </label>
                    </div>
                    <div class="mailbox-toggle-strip">
                      <label class="check-field mailbox-toggle-card">
                        <input name="isPinned" type="checkbox" ${draft.isPinned ? 'checked' : ''} />
                        <span>置顶显示</span>
                      </label>
                    </div>
                  `
                  : `
                    <div class="mailbox-config-grid mailbox-config-grid-compact">
                      <label class="mailbox-grid-field">
                        <span>IMAP 主机</span>
                        <input name="imapHost" value="${escapeHtml(draft.imapHost || '')}" required />
                      </label>
                      <label class="mailbox-grid-field">
                        <span>端口</span>
                        <input name="imapPort" type="number" value="${escapeHtml(draft.imapPort || 993)}" required />
                      </label>
                      <label class="mailbox-grid-field">
                        <span>同步频率</span>
                        <select name="syncIntervalSeconds">${syncIntervalOptions(draft.syncIntervalSeconds || 5)}</select>
                      </label>
                      <label class="mailbox-grid-field">
                        <span>排序值</span>
                        <input name="sortOrder" type="number" min="0" step="1" value="${escapeHtml(draft.sortOrder ?? 100)}" />
                      </label>
                    </div>
                    <div class="mailbox-toggle-strip">
                      <label class="check-field mailbox-toggle-card">
                        <input name="secure" type="checkbox" ${draft.secure ? 'checked' : ''} />
                        <span>启用 TLS / SSL</span>
                      </label>
                      <label class="check-field mailbox-toggle-card">
                        <input name="isPinned" type="checkbox" ${draft.isPinned ? 'checked' : ''} />
                        <span>置顶显示</span>
                      </label>
                    </div>
                  `
              }
              <div class="mailbox-sync-settings">
                <label class="settings-switch-row mailbox-settings-switch">
                  <span class="settings-switch-copy">
                    <strong>附件同步</strong>
                    <small>勾选后，该邮箱会纳入系统设置里的手动本地附件同步范围；普通收信时只保留元数据，不会自动保存附件实体。</small>
                  </span>
                  <span class="settings-switch-control">
                    <input name="syncAttachments" type="checkbox" ${draft.syncAttachments ? 'checked' : ''} />
                    <span class="settings-switch-slider" aria-hidden="true"></span>
                  </span>
                </label>
              </div>
              <div class="mailbox-order-note">${escapeHtml(displayOrderHint)}</div>
              <div class="note" data-provider-note>${escapeHtml(providerNote)}</div>
              <div class="form-actions mailbox-modal-actions">
                <div class="mailbox-modal-actions-left">
                  ${
                    isMicrosoftOauth && !isEditingMailbox && !isOutlookOauthMode
                      ? ''
                      : usesOauth && !oauthConfigured && !isMicrosoftOauth
                      ? ''
                      : '<button class="button ghost" type="button" data-action="test-mailbox">测试连接</button>'
                  }
                  ${
                    isEditingMailbox
                      ? `<button class="button ghost" type="button" data-action="sync-mailbox" data-mailbox-id="${escapeHtml(draft.mailboxId)}">立即同步</button>`
                      : ''
                  }
                </div>
                <div class="mailbox-modal-actions-right">
                  ${
                    isEditingMailbox
                      ? `<button class="tiny-button danger" type="button" data-action="delete-mailbox" data-mailbox-id="${escapeHtml(draft.mailboxId)}">删除</button>`
                      : ''
                  }
                  <button class="button" type="submit">${
                    isMicrosoftOauth
                      ? isOutlookOauthMode && !oauthConfigured
                        ? isEditingMailbox
                          ? `连接 ${oauthActionLabel} 并更新`
                          : `连接 ${oauthActionLabel} 并接入`
                        : isEditingMailbox
                          ? '保存修改'
                          : '保存并接入'
                      : usesOauth && !oauthConfigured
                      ? isEditingMailbox
                        ? `连接 ${oauthActionLabel} 并更新`
                        : `连接 ${oauthActionLabel} 并接入`
                      : isEditingMailbox
                        ? '保存修改'
                        : '保存并接入'
                  }</button>
                </div>
              </div>
            </form>
          </section>
        </div>
      `
    : '';

  return `
    <section class="view-grid view-grid-mailboxes mailbox-layout">
      <article class="panel">
        <div class="mailbox-head-strip">
          <div class="mailbox-head-title">
            ${renderAutoIcon('mailboxes', 'mailboxes', 'mailbox-head-icon')}
            <h3>邮箱账户</h3>
          </div>
          <div class="mailbox-head-controls">
            <div class="mailbox-provider-strip mailbox-provider-strip-compact">
              ${providerFilters
                .map(
                  (provider) => `
                    <button
                      class="provider-filter-chip ${state.mailboxProviderFilter === provider.id ? 'active' : ''}"
                      type="button"
                      data-action="set-mailbox-provider-filter"
                      data-provider="${escapeHtml(provider.id)}"
                    >
                      ${renderMailboxProviderIcon(provider.id, state.providers, 'provider-icon-inline')}
                      <span>${escapeHtml(provider.label)}</span>
                      <strong>${escapeHtml(provider.count)}</strong>
                    </button>
                  `,
                )
                .join('')}
            </div>
            ${ownerFilterCompact(state)}
            <div class="mailbox-column-settings" data-mailbox-columns>
              <button
                class="button ghost mailbox-column-settings-trigger"
                type="button"
                data-action="toggle-mailbox-column-menu"
                aria-expanded="${state.mailboxColumnMenuOpen ? 'true' : 'false'}"
              >
                ${renderAutoIcon('mail', 'columns', 'button-icon')}
                <span>列设置</span>
              </button>
              ${
                state.mailboxColumnMenuOpen
                  ? `
                    <div class="mailbox-column-settings-menu">
                      ${MAILBOX_VISIBLE_FIELD_OPTIONS.map(
                        (item) => `
                          <label class="mailbox-column-settings-item">
                            <span>${escapeHtml(item.label)}</span>
                            <input
                              type="checkbox"
                              data-action="toggle-mailbox-visible-field"
                              data-field="${escapeHtml(item.id)}"
                              ${visibleFieldIds.includes(item.id) ? 'checked' : ''}
                            />
                          </label>
                        `,
                      ).join('')}
                    </div>
                  `
                  : ''
              }
            </div>
            <button class="button" type="button" data-action="create-mailbox">新增邮箱</button>
          </div>
        </div>
        <div class="message-bulk-toolbar mailbox-bulk-toolbar">
          <label class="message-select-all">
            <input
              type="checkbox"
              data-action="toggle-select-all-visible-mailboxes"
              ${allVisibleMailboxesSelected ? 'checked' : ''}
              ${mailboxPageItems.length ? '' : 'disabled'}
            />
            <span>${mailboxSelectionCount ? `已选 ${mailboxSelectionCount} 个邮箱` : '全选当前页邮箱'}</span>
          </label>
          <div class="message-bulk-actions">
            <button class="tiny-button danger" type="button" data-action="bulk-delete-mailboxes" ${mailboxBulkDisabled}>批量删除</button>
          </div>
        </div>
        <div class="mailbox-list">
          ${
            mailboxPageItems.length
              ? mailboxPageItems
                  .map(
                    (mailbox) => `
                      <article class="mailbox-row-card ${mailbox.id === state.editingMailboxId && state.mailboxModalOpen ? 'active' : ''}" data-mailbox-id="${escapeHtml(mailbox.id)}">
                        <label class="mailbox-row-select">
                          <input
                            type="checkbox"
                            data-action="toggle-mailbox-select"
                            data-mailbox-id="${escapeHtml(mailbox.id)}"
                            ${selectedMailboxIds.has(mailbox.id) ? 'checked' : ''}
                          />
                        </label>
                        <div class="mailbox-row-body">
                          <button class="mailbox-row-main" type="button" data-action="open-mailbox-modal" data-mailbox-id="${escapeHtml(mailbox.id)}">
                            <div class="mailbox-row-top">
                              <div class="mailbox-row-title">
                                ${renderMailboxProviderIcon(mailbox.provider, state.providers, 'provider-icon-mailbox-row')}
                                <div class="mailbox-row-title-copy">
                                  <div class="mailbox-row-title-line">
                                    <strong>${escapeHtml(mailbox.name)}</strong>
                                    <div class="mailbox-row-title-meta">
                                      ${mailbox.isPinned ? '<span class="tag tag-pin">置顶</span>' : ''}
                                      <span class="tag">${escapeHtml(mailboxProviderMeta(mailbox.provider, state.providers).label)}</span>
                                    </div>
                                  </div>
                                  ${renderMailboxVisibleFieldChips(mailbox, visibleFieldIds, state)}
                                </div>
                              </div>
                              <span class="mailbox-row-open">点击查看</span>
                            </div>
                            <div class="mailbox-row-chips">
                            </div>
                          </button>
                        </div>
                        <div class="mailbox-row-actions">
                          <button class="tiny-button" type="button" data-action="sync-mailbox" data-mailbox-id="${escapeHtml(mailbox.id)}">同步</button>
                          <button
                            class="tiny-button ${mailbox.isPinned ? 'is-highlighted' : ''}"
                            type="button"
                            data-action="toggle-mailbox-pin"
                            data-mailbox-id="${escapeHtml(mailbox.id)}"
                            data-next-pinned="${mailbox.isPinned ? 'false' : 'true'}"
                          >
                            ${mailbox.isPinned ? '取消置顶' : '置顶'}
                          </button>
                          <button class="tiny-button danger" type="button" data-action="delete-mailbox" data-mailbox-id="${escapeHtml(mailbox.id)}">删除</button>
                        </div>
                        ${mailbox.lastError ? `<div class="notice error">${escapeHtml(mailbox.lastError)}</div>` : ''}
                      </article>
                    `,
                  )
                  .join('')
              : '<div class="empty-card">当前筛选条件下没有匹配的邮箱账户。</div>'
          }
        </div>
        ${renderPaginationBar({
          type: 'mailbox',
          page: mailboxPage,
          pageSize: mailboxPageSize,
          totalItems: mailboxTotalItems,
          totalPages: mailboxTotalPages,
          currentCount: mailboxPageItems.length,
          pageSizeAction: 'mailbox-page-size',
          pageAction: 'go-mailbox-page',
          jumpAction: 'jump-mailbox-page',
        })}
      </article>
      ${modalMarkup}
      ${importModalMarkup}
      ${guideModalMarkup}
    </section>
  `;
}

function renderUsersLegacy(state) {
  const editingUser = state.users.find((user) => user.id === state.editingUserId) || null;
  const editingUserEmail =
    editingUser && !isInternalUserEmail(editingUser.email) ? editingUser.email : '';
  const modalMarkup = state.userModalOpen
    ? `
        <div class="modal-shell">
          <div class="modal-backdrop" data-user-overlay></div>
          <section class="modal-panel user-modal">
            <div class="user-modal-header">
              <div>
                <p class="eyebrow">User</p>
                <h3>${editingUser ? '编辑用户' : '创建用户'}</h3>
                <p>${editingUser ? '在这里修改用户资料、权限和启用状态。' : '创建一个新的后台账号，权限和启用状态可由管理员控制。'}</p>
              </div>
              <button class="modal-close" type="button" data-action="close-user-modal" aria-label="关闭">&times;</button>
            </div>
            <form data-form="user" class="stack user-modal-form">
              <input type="hidden" name="userId" value="${escapeHtml(editingUser?.id || '')}" />
              <label><span>昵称</span><input name="name" value="${escapeHtml(editingUser?.name || '')}" placeholder="请输入用户昵称" required /></label>
              <label><span>登录用户名</span><input name="username" value="${escapeHtml(editingUser?.username || '')}" placeholder="例如：admin 或 zhangsan" required /></label>
              <label><span>联系邮箱（可选）</span><input name="email" type="email" value="${escapeHtml(editingUserEmail || '')}" placeholder="留空则自动生成系统内部邮箱" /></label>
              <label><span>头像链接（可选）</span><input name="avatarUrl" type="url" value="${escapeHtml(editingUser?.avatarUrl || '')}" placeholder="https://example.com/avatar.png" /></label>
              <div class="inline-grid">
                <label><span>角色</span><select name="role"><option value="user" ${editingUser?.role !== 'admin' ? 'selected' : ''}>普通用户</option><option value="admin" ${editingUser?.role === 'admin' ? 'selected' : ''}>管理员</option></select></label>
                <label><span>状态</span><select name="status"><option value="active" ${editingUser?.status !== 'inactive' ? 'selected' : ''}>启用</option><option value="inactive" ${editingUser?.status === 'inactive' ? 'selected' : ''}>停用</option></select></label>
              </div>
              <label><span>${editingUser ? '重置密码（可留空）' : '初始密码'}</span><input name="password" type="password" placeholder="${editingUser ? '不修改可留空' : '至少 4 位'}" ${editingUser ? '' : 'required'} /></label>
              <div class="notice info">支持普通用户名登录，也支持通过头像链接配置头像；普通用户注册后是否启用由管理员控制。</div>
              <div class="form-actions user-modal-actions">
                <button class="button ghost" type="button" data-action="close-user-modal">取消</button>
                <button class="button" type="submit">${editingUser ? '保存修改' : '创建用户'}</button>
              </div>
            </form>
          </section>
        </div>
      `
    : '';

  return `
    <section class="view-grid view-grid-users">
      <article class="panel">
        <div class="panel-header user-list-toolbar">
          <div>
            <h3>用户列表</h3>
            <p>${state.users.length} 个账户，支持管理员与普通用户分级管理。</p>
          </div>
          <div class="user-list-toolbar-actions">
            <span class="tag subtle">${state.users.length} 个账户</span>
            <button class="button" type="button" data-action="create-user">创建用户</button>
          </div>
        </div>
        <div class="user-table">
          ${
            state.users.length
              ? state.users
                  .map(
                    (user) => `
                      <div class="user-row ${state.userModalOpen && state.editingUserId === user.id ? 'active' : ''}">
                        <div class="user-row-main">
                          ${renderAvatar(
                            user.avatarUrl,
                            userInitials(user),
                            'user-row-avatar',
                            user.name || user.username || '用户头像',
                          )}
                          <div class="user-row-copy">
                            <div class="user-row-heading">
                              <strong>${escapeHtml(user.name)}</strong>
                              <span class="tag subtle">${escapeHtml(formatUserHandle(user))}</span>
                            </div>
                            <p>${escapeHtml(formatUserContact(user))}</p>
                          </div>
                        </div>
                        <div class="user-row-meta">
                          <span class="tag">${escapeHtml(user.role === 'admin' ? '管理员' : '普通用户')}</span>
                          <span class="tag subtle">${escapeHtml(user.status === 'active' ? '启用' : '停用')}</span>
                          <span>${escapeHtml(user.mailboxCount || 0)} 个邮箱</span>
                          <button class="tiny-button" type="button" data-action="edit-user" data-user-id="${escapeHtml(user.id)}">编辑</button>
                        </div>
                      </div>
                    `,
                  )
                  .join('')
              : '<div class="empty-card">还没有创建任何用户。</div>'
          }
        </div>
      </article>
      ${modalMarkup}
    </section>
  `;
}

function renderUsers(state) {
  const editingUser = state.users.find((user) => user.id === state.editingUserId) || null;
  const editingUserEmail =
    editingUser && !isInternalUserEmail(editingUser.email) ? editingUser.email : '';
  const modalMarkup = state.userModalOpen
    ? `
        <div class="modal-shell">
          <div class="modal-backdrop" data-user-overlay></div>
          <section class="modal-panel user-modal">
            <div class="user-modal-header">
              <div>
                <p class="eyebrow">User</p>
                <h3>${editingUser ? '编辑用户' : '创建用户'}</h3>
                <p>${editingUser ? '在这里修改用户资料、权限和启用状态。' : '创建一个新的后台账号，权限和启用状态可由管理员控制。'}</p>
              </div>
              <button class="modal-close" type="button" data-action="close-user-modal" aria-label="关闭">&times;</button>
            </div>
            <form data-form="user" class="stack user-modal-form">
              <input type="hidden" name="userId" value="${escapeHtml(editingUser?.id || '')}" />
              <label><span>昵称</span><input name="name" value="${escapeHtml(editingUser?.name || '')}" placeholder="请输入用户昵称" required /></label>
              <label><span>登录用户名</span><input name="username" value="${escapeHtml(editingUser?.username || '')}" placeholder="例如：admin 或 zhangsan" required /></label>
              <label><span>联系邮箱（可选）</span><input name="email" type="email" value="${escapeHtml(editingUserEmail || '')}" placeholder="留空则自动生成系统内部邮箱" /></label>
              <label><span>头像链接（可选）</span><input name="avatarUrl" type="url" value="${escapeHtml(editingUser?.avatarUrl || '')}" placeholder="https://example.com/avatar.png" /></label>
              <div class="inline-grid">
                <label><span>角色</span><select name="role"><option value="user" ${editingUser?.role !== 'admin' ? 'selected' : ''}>普通用户</option><option value="admin" ${editingUser?.role === 'admin' ? 'selected' : ''}>管理员</option></select></label>
                <label><span>状态</span><select name="status"><option value="active" ${editingUser?.status !== 'inactive' ? 'selected' : ''}>启用</option><option value="inactive" ${editingUser?.status === 'inactive' ? 'selected' : ''}>停用</option></select></label>
              </div>
              <label><span>${editingUser ? '重置密码（可留空）' : '初始密码'}</span><input name="password" type="password" placeholder="${editingUser ? '不修改可留空' : '至少 4 位'}" ${editingUser ? '' : 'required'} /></label>
              <div class="notice info">支持普通用户名登录，也支持通过头像链接配置头像；普通用户注册后是否启用由管理员控制。</div>
              <div class="form-actions user-modal-actions">
                <button class="button ghost" type="button" data-action="close-user-modal">取消</button>
                <button class="button" type="submit">${editingUser ? '保存修改' : '创建用户'}</button>
              </div>
            </form>
          </section>
        </div>
      `
    : '';

  return `
    <section class="view-grid view-grid-users">
      <article class="panel">
        <div class="panel-header user-list-toolbar">
          <div>
            <h3>用户列表</h3>
            <p>${state.users.length} 个账户，支持管理员与普通用户分级管理。</p>
          </div>
          <div class="user-list-toolbar-actions">
            <span class="tag subtle">${state.users.length} 个账户</span>
            <button class="button" type="button" data-action="create-user">创建用户</button>
          </div>
        </div>
        <div class="user-table user-table-modern">
          ${
            state.users.length
              ? `
                  <div class="user-table-head">
                    <span>用户</span>
                    <span>用户名</span>
                    <span>角色</span>
                    <span>状态</span>
                    <span>邮箱数</span>
                    <span>创建时间</span>
                    <span>操作</span>
                  </div>
                  <div class="user-table-body">
                    ${state.users
                      .map(
                        (user) => `
                          <div class="user-row ${state.userModalOpen && state.editingUserId === user.id ? 'active' : ''}">
                            <div class="user-cell user-cell-primary" data-label="用户">
                              ${renderAvatar(
                                user.avatarUrl,
                                userInitials(user),
                                'user-row-avatar',
                                user.name || user.username || '用户头像',
                              )}
                              <div class="user-row-copy">
                                <strong>${escapeHtml(user.name)}</strong>
                                <p>${escapeHtml(formatUserContact(user))}</p>
                              </div>
                            </div>
                            <div class="user-cell" data-label="用户名">
                              <span class="user-handle-text">${escapeHtml(formatUserHandle(user))}</span>
                            </div>
                            <div class="user-cell" data-label="角色">
                              <span class="user-role-pill ${user.role === 'admin' ? 'admin' : 'user'}">${escapeHtml(user.role === 'admin' ? '管理员' : '普通用户')}</span>
                            </div>
                            <div class="user-cell" data-label="状态">
                              <span class="user-status-pill ${user.status === 'active' ? 'active' : 'inactive'}">
                                <span class="user-status-dot" aria-hidden="true"></span>
                                ${escapeHtml(user.status === 'active' ? '启用' : '停用')}
                              </span>
                            </div>
                            <div class="user-cell" data-label="邮箱数">
                              <span class="user-metric-text">${escapeHtml(user.mailboxCount || 0)} 个邮箱</span>
                            </div>
                            <div class="user-cell" data-label="创建时间">
                              <span class="user-date-text">${escapeHtml(formatDate(user.createdAt))}</span>
                            </div>
                            <div class="user-cell user-cell-actions" data-label="操作">
                              <button class="tiny-button" type="button" data-action="edit-user" data-user-id="${escapeHtml(user.id)}">编辑</button>
                            </div>
                          </div>
                        `,
                      )
                      .join('')}
                  </div>
                `
              : '<div class="empty-card">还没有创建任何用户。</div>'
          }
        </div>
      </article>
      ${modalMarkup}
    </section>
  `;
}

function renderProfile(state) {
  const contactEmail = formatUserContact(state.user);

  return `
    <section class="view-grid view-grid-profile">
      <article class="panel">
        <div class="panel-header"><div><h3>个人资料</h3><p>支持修改昵称、登录用户名、头像链接和登录密码。</p></div></div>
        <div class="profile-hero">
          ${renderAvatar(
            state.user.avatarUrl,
            userInitials(state.user),
            'profile-avatar',
            state.user.name || state.user.username || '用户头像',
          )}
          <div class="profile-hero-copy">
            <strong>${escapeHtml(state.user.name)}</strong>
            <p>${escapeHtml(formatUserHandle(state.user))}</p>
          </div>
        </div>
        <form data-form="profile" class="stack">
          <label><span>昵称</span><input name="name" value="${escapeHtml(state.user.name)}" required /></label>
          <label><span>登录用户名</span><input name="username" value="${escapeHtml(state.user.username || '')}" required /></label>
          <label><span>头像链接（可选）</span><input name="avatarUrl" type="url" value="${escapeHtml(state.user.avatarUrl || '')}" placeholder="https://example.com/avatar.png" /></label>
          <div class="profile-password-grid">
            <label><span>当前密码</span><input name="currentPassword" type="password" /></label>
            <label><span>新密码</span><input name="newPassword" type="password" placeholder="不修改可留空" /></label>
          </div>
          <button class="button" type="submit">保存资料</button>
        </form>
      </article>
      <article class="panel">
        <div class="panel-header"><div><h3>账号信息</h3><p>当前登录账户的身份与权限状态。</p></div></div>
        <div class="info-list">
          <div class="info-row"><span>登录用户名</span><strong>${escapeHtml(formatUserHandle(state.user))}</strong></div>
          <div class="info-row"><span>联系邮箱</span><strong>${escapeHtml(contactEmail)}</strong></div>
          <div class="info-row"><span>角色</span><strong>${escapeHtml(state.user.role === 'admin' ? '管理员' : '普通用户')}</strong></div>
          <div class="info-row"><span>状态</span><strong>${escapeHtml(state.user.status === 'active' ? '启用' : '停用')}</strong></div>
          <div class="info-row"><span>最近登录</span><strong>${escapeHtml(state.user.lastLoginAt ? formatFullDate(state.user.lastLoginAt) : '首次登录')}</strong></div>
          <div class="info-row"><span>创建时间</span><strong>${escapeHtml(formatFullDate(state.user.createdAt))}</strong></div>
        </div>
      </article>
    </section>
  `;
}


function resolveNotificationTemplatePreviewText(template, channel) {
  const activePreset =
    (template?.presets || []).find((preset) => preset.id === template?.presetId) ||
    template?.presets?.[0] || {
      templates: {},
    };
  const currentValue = String(template?.templates?.[channel] || '');
  const presetValue = String(activePreset.templates?.[channel] || '');
  const source =
    !currentValue.trim() || currentValue.replace(/\r\n?/g, '\n') === presetValue.replace(/\r\n?/g, '\n')
      ? presetValue
      : currentValue;
  const sample = template?.sample || {};

  return String(source || '')
    .replaceAll('{subject}', sample.subject || '')
    .replaceAll('{from}', sample.from || '')
    .replaceAll('{mailbox}', sample.mailbox || '')
    .replaceAll('{time}', sample.time || '')
    .replaceAll('{summary}', sample.summary || '');
}

function renderNotificationTemplatePresetCards(template) {
  const presets = Array.isArray(template?.presets) ? template.presets : [];
  const activePresetId = String(template?.presetId || presets[0]?.id || 'default');

  return presets
    .map((preset) => {
      const isActive = preset.id === activePresetId;
      return `
        <button
          class="template-preset-card ${isActive ? 'active' : ''}"
          type="button"
          data-action="select-template-preset"
          data-preset-id="${escapeHtml(preset.id || '')}"
        >
          <div class="template-preset-head">
            <strong>${escapeHtml(preset.name || '未命名预设')}</strong>
            <span class="tag subtle">${escapeHtml(preset.accent || 'Preset')}</span>
          </div>
          <p>${escapeHtml(preset.description || '使用这一套默认通知模板。')}</p>
        </button>
      `;
    })
    .join('');
}

function renderNotificationTemplateTokenChips(template) {
  const tokens = Array.isArray(template?.tokens) ? template.tokens : [];

  return tokens
    .map(
      (item) => `
        <span class="template-token-chip" title="${escapeHtml(item.description || '')}">
          <code>${escapeHtml(item.token || '')}</code>
          <small>${escapeHtml(item.label || '')}</small>
        </span>
      `,
    )
    .join('');
}

function renderNotificationTemplateEditor(template, channel, title, description, modeHint) {
  const activePreset =
    (template?.presets || []).find((preset) => preset.id === template?.presetId) ||
    template?.presets?.[0] || {
      templates: {},
    };
  const value = String(template?.templates?.[channel] || '');
  const isPresetDefault =
    !value.trim()
    || value.replace(/\r\n?/g, '\n') === String(activePreset.templates?.[channel] || '').replace(/\r\n?/g, '\n');

  return `
    <article class="template-editor-card">
      <div class="template-editor-head">
        <div>
          <strong>${escapeHtml(title)}</strong>
          <p>${escapeHtml(description)}</p>
        </div>
        <span class="tag subtle" data-template-state="${escapeHtml(channel)}">${isPresetDefault ? '使用预设默认' : '已自定义'}</span>
      </div>
      <p class="template-editor-mode">${escapeHtml(modeHint)}</p>
      <textarea
        name="${escapeHtml(channel)}"
        rows="9"
        spellcheck="false"
        data-template-input="${escapeHtml(channel)}"
        placeholder="留空时自动使用当前预设的默认模板。"
      >${escapeHtml(value)}</textarea>
    </article>
  `;
}

function renderNotificationTemplatePreviewCard(template, channel, title) {
  const activePreset =
    (template?.presets || []).find((preset) => preset.id === template?.presetId) ||
    template?.presets?.[0] || {
      templates: {},
    };
  const currentValue = String(template?.templates?.[channel] || '');
  const isPresetDefault =
    !currentValue.trim()
    || currentValue.replace(/\r\n?/g, '\n') === String(activePreset.templates?.[channel] || '').replace(/\r\n?/g, '\n');

  return `
    <article class="template-preview-card">
      <div class="template-preview-head">
        <strong>${escapeHtml(title)}</strong>
        <span class="tag subtle">${isPresetDefault ? '预览预设默认' : '预览自定义文案'}</span>
      </div>
      <pre data-template-preview="${escapeHtml(channel)}">${escapeHtml(resolveNotificationTemplatePreviewText(template, channel))}</pre>
    </article>
  `;
}
const NOTIFICATION_COVER_CATEGORY_META = [
  {
    id: 'verification',
    title: '验证码邮件封面',
    description: '识别到验证码、登录校验、安全验证这类邮件时，会优先套用这一类封面。',
    previewTitle: '验证码 / 安全验证',
    previewText: '突出验证码、高优先级安全提醒',
  },
  {
    id: 'order',
    title: '订单通知封面',
    description: '识别到订单生成、订单确认、物流跟踪、发货配送这类邮件时，会优先套用订单通知封面。',
    previewTitle: '订单通知 / 物流状态',
    previewText: '适合订单确认、发货、物流、交易进度提醒',
  },
  {
    id: 'subscription',
    title: '订阅提醒封面',
    description: '识别到订阅更新、会员续费、账期提醒、服务到期这类邮件时，会优先套用订阅提醒封面。',
    previewTitle: '订阅提醒 / 续费通知',
    previewText: '适合订阅、会员、续费、服务到期提醒',
  },
  {
    id: 'marketing',
    title: '广告邮件封面',
    description: '促销、优惠、活动、上新、营销邮件，会自动切换到这一类封面风格。',
    previewTitle: '营销 / 活动推送',
    previewText: '适合优惠、促销、广告、活动类邮件',
  },
  {
    id: 'junk',
    title: '垃圾邮件封面',
    description: '如果原邮箱目录已经判定为垃圾/垃圾箱，或内容明显像垃圾邮件，就会应用这一类封面。',
    previewTitle: '垃圾邮件 / 风险提醒',
    previewText: '用于垃圾、可疑、风险较高的邮件',
  },
  {
    id: 'standard',
    title: '普通邮件封面',
    description: '默认兜底封面。普通通知、业务往来、系统邮件，都会落到这一类。',
    previewTitle: '普通邮件 / 日常通知',
    previewText: '适合日常收件、系统通知、普通往来邮件',
  },
];

const NOTIFICATION_COVER_MODE_META = [
  { id: 'builtin', label: '系统内置' },
  { id: 'upload', label: '本地上传' },
  { id: 'url', label: '图片直链' },
  { id: 'none', label: '关闭封面' },
];

const NOTIFICATION_COVER_CHANNEL_META = [
  {
    id: 'telegram',
    title: 'Telegram 通知样式',
    description: '可以单独决定 Telegram 是发带图片封面的卡片，还是保留原来的默认摘要通知。',
    helpText: '带封面时会优先发送图片 + 摘要 + 查看完整内容按钮；默认摘要模式则继续使用原来的文字通知。',
  },
  {
    id: 'wecomApp',
    title: '企业微信应用通知样式',
    description: '只影响企业微信应用模式，不影响企业微信机器人。你可以随时切回默认摘要通知。',
    helpText: '带封面时发送企业微信应用图文消息；默认摘要模式则回到原来的 textcard 样式。',
  },
];

const NOTIFICATION_COVER_DELIVERY_MODE_META = [
  { id: 'cover', label: '带封面通知' },
  { id: 'plain', label: '默认摘要通知' },
];

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
  return NOTIFICATION_COVER_MODE_META.some((item) => item.id === normalized) ? normalized : 'builtin';
}

function normalizeNotificationTemplateCoverOption(cover = {}) {
  const mode = normalizeNotificationCoverMode(cover?.mode || 'builtin');
  return {
    mode,
    url: String(cover?.url || '').trim(),
    assetPath: String(cover?.assetPath || '').trim(),
    assetUrl: String(cover?.assetUrl || '').trim(),
    assetLocalPath: String(cover?.assetLocalPath || '').trim(),
    uploadFilename: String(cover?.uploadFilename || '').trim(),
  };
}

function normalizeNotificationCoverDeliveryMode(mode = 'cover') {
  const normalized = String(mode || 'cover').trim().toLowerCase();
  return NOTIFICATION_COVER_DELIVERY_MODE_META.some((item) => item.id === normalized) ? normalized : 'cover';
}

function normalizeNotificationEnhancementOptions(template = {}) {
  const baseOptions = template?.options || {};
  const coverChannels =
    baseOptions?.coverChannels && typeof baseOptions.coverChannels === 'object'
      ? baseOptions.coverChannels
      : {};
  return {
    translateToChinese: Boolean(baseOptions.translateToChinese),
    previewBaseUrl: String(
      baseOptions.previewBaseUrl || (typeof window !== 'undefined' ? window.location.origin : ''),
    ).trim(),
    coverEnabled: baseOptions.coverEnabled === undefined ? true : Boolean(baseOptions.coverEnabled),
    coverChannels: Object.fromEntries(
      NOTIFICATION_COVER_CHANNEL_META.map((item) => [
        item.id,
        normalizeNotificationCoverDeliveryMode(coverChannels[item.id] || 'cover'),
      ]),
    ),
    covers: Object.fromEntries(
      NOTIFICATION_COVER_CATEGORY_META.map((item) => [
        item.id,
        normalizeNotificationTemplateCoverOption(baseOptions?.covers?.[item.id]),
      ]),
    ),
  };
}

function notificationCoverModeLabel(mode = 'builtin') {
  return NOTIFICATION_COVER_MODE_META.find((item) => item.id === normalizeNotificationCoverMode(mode))?.label || '系统内置';
}

function notificationCoverDeliveryModeLabel(mode = 'cover') {
  return NOTIFICATION_COVER_DELIVERY_MODE_META.find((item) => item.id === String(mode || '').trim().toLowerCase())?.label || '带封面通知';
}

function notificationCoverPreviewSource(cover = {}) {
  if (cover.mode === 'none') {
    return '';
  }
  if (cover.assetUrl) {
    return cover.assetUrl;
  }
  if (cover.mode === 'url' && cover.url) {
    return cover.url;
  }
  return '';
}

function renderNotificationCoverOptionCard(categoryMeta, cover = {}) {
  const prefix = notificationCoverFieldPrefix(categoryMeta.id);
  const previewSource = notificationCoverPreviewSource(cover);
  const helperText =
    cover.mode === 'builtin'
      ? '当前使用系统内置默认封面。即使后续清空数据库或首次部署项目，这张默认图也会随系统一起存在。'
      : cover.assetLocalPath
      ? `当前已保存到本地：${cover.assetLocalPath}`
      : cover.uploadFilename
        ? `当前图片：${cover.uploadFilename}`
        : cover.mode === 'url' && cover.url
          ? `当前直链：${cover.url}`
          : '当前未选择自定义封面，保存后会继续使用系统内置默认封面。';

  return `
    <article class="notification-cover-card">
      <div class="template-preview-head">
        <div>
          <strong>${escapeHtml(categoryMeta.title)}</strong>
          <p>${escapeHtml(categoryMeta.description)}</p>
        </div>
        <span class="tag subtle">${escapeHtml(notificationCoverModeLabel(cover.mode))}</span>
      </div>
      <div class="notification-cover-preview is-${escapeHtml(categoryMeta.id)} ${previewSource ? 'has-image' : ''}">
        <img
          src="${previewSource ? escapeHtml(previewSource) : ''}"
          alt="${escapeHtmlAttribute(categoryMeta.title)}"
          data-cover-preview-image="${escapeHtmlAttribute(categoryMeta.id)}"
          ${previewSource ? '' : 'hidden'}
        />
        <div
          class="notification-cover-preview-fallback"
          data-cover-preview-fallback="${escapeHtmlAttribute(categoryMeta.id)}"
          ${previewSource ? 'hidden' : ''}
        >
          <strong>${escapeHtml(categoryMeta.previewTitle)}</strong>
          <p>${escapeHtml(categoryMeta.previewText)}</p>
        </div>
      </div>
      <div class="notification-cover-spec">
        <strong>推荐封面分辨率</strong>
        <span>建议使用 1200×630（19:10），最低建议 600×315，上传文件尽量不超过 2 MB，这样 TG 和企业微信应用卡片显示会更清晰。</span>
      </div>
      <div class="stack notification-cover-card-stack">
        <label>
          <span>封面模式</span>
          <select name="${escapeHtml(prefix)}Mode">
            ${NOTIFICATION_COVER_MODE_META.map(
              (item) => `
                <option value="${escapeHtml(item.id)}" ${item.id === cover.mode ? 'selected' : ''}>
                  ${escapeHtml(item.label)}
                </option>
              `,
            ).join('')}
          </select>
        </label>
        <label>
          <span>图片直链（Image URL）</span>
          <input
            name="${escapeHtml(prefix)}Url"
            type="url"
            value="${escapeHtml(cover.url)}"
            placeholder="例如 https://example.com/cover.png"
            spellcheck="false"
            autocomplete="off"
          />
        </label>
        <label class="notification-cover-upload-field">
          <span>本地图片上传</span>
          <input
            name="${escapeHtml(prefix)}UploadFile"
            type="file"
            accept="image/*"
            data-cover-category="${escapeHtmlAttribute(categoryMeta.id)}"
          />
          <small data-cover-upload-filename="${escapeHtmlAttribute(categoryMeta.id)}">
            ${escapeHtml(cover.uploadFilename ? `当前图片：${cover.uploadFilename}` : '支持 PNG / JPG / WEBP / GIF / SVG，建议 1200×630，大小不超过 2 MB。')}
          </small>
        </label>
        <input type="hidden" name="${escapeHtml(prefix)}UploadDataUrl" value="" />
        <input type="hidden" name="${escapeHtml(prefix)}UploadFilename" value="${escapeHtmlAttribute(cover.uploadFilename)}" />
        <input type="hidden" name="${escapeHtml(prefix)}AssetPath" value="${escapeHtmlAttribute(cover.assetPath)}" />
        <div class="notice info notification-cover-card-note">${escapeHtml(helperText)}</div>
      </div>
    </article>
  `;
}

function renderNotificationCoverSummaryItem(categoryMeta, cover = {}, activeCategoryId = '') {
  const previewSource = notificationCoverPreviewSource(cover);
  const sourceLabel =
    cover.mode === 'builtin'
      ? '系统内置默认封面'
      : cover.assetLocalPath
      ? '已保存本地图片'
      : cover.uploadFilename
        ? '已选上传图片'
      : cover.mode === 'url' && cover.url
          ? '使用图片直链'
          : cover.mode === 'none'
            ? '当前关闭封面'
            : '系统内置默认封面';

  return `
    <article class="notification-cover-summary-item ${activeCategoryId === categoryMeta.id ? 'is-active' : ''}">
      <div class="notification-cover-summary-copy">
        <div>
          <strong>${escapeHtml(categoryMeta.title)}</strong>
          <p>${escapeHtml(categoryMeta.previewText)}</p>
        </div>
        <div class="notification-cover-summary-meta">
          <span class="tag subtle">${escapeHtml(notificationCoverModeLabel(cover.mode))}</span>
          <span class="tag subtle">${escapeHtml(sourceLabel)}</span>
        </div>
      </div>
      <div class="notification-cover-summary-actions">
        <button
          class="tiny-button"
          type="button"
          data-action="open-notification-cover-editor"
          data-category="${escapeHtmlAttribute(categoryMeta.id)}"
        >
          编辑
        </button>
      </div>
    </article>
  `;
}

function renderNotificationCoverEditorModal(options = {}, activeCategoryId = '') {
  const categoryMeta = NOTIFICATION_COVER_CATEGORY_META.find((item) => item.id === String(activeCategoryId || '').trim());
  if (!categoryMeta) {
    return '';
  }

  const cover = options?.covers?.[categoryMeta.id] || normalizeNotificationTemplateCoverOption();

  return `
    <div class="modal-shell notification-cover-editor-shell">
      <div class="modal-backdrop" data-notification-cover-editor-overlay></div>
      <section class="modal-panel notification-cover-editor-modal">
        <div class="notification-cover-editor-head">
          <div class="notification-cover-editor-copy">
            <p class="eyebrow">Cover Editor</p>
            <h3>${escapeHtml(categoryMeta.title)}</h3>
            <p>${escapeHtml(categoryMeta.description)}</p>
          </div>
          <button class="modal-close" type="button" data-action="close-notification-cover-editor" aria-label="关闭封面编辑">×</button>
        </div>
        <div class="notification-cover-editor-body">
          ${renderNotificationCoverOptionCard(categoryMeta, cover)}
        </div>
        <div class="form-actions notification-cover-editor-actions">
          <button class="button ghost" type="button" data-action="close-notification-cover-editor">返回总览</button>
          <button class="button" type="submit">保存通知增强</button>
        </div>
      </section>
    </div>
  `;
}

function renderNotificationCoverChannelCard(channelMeta, selectedMode = 'cover', coverEnabled = true) {
  const fieldName = notificationCoverChannelFieldName(channelMeta.id);
  const helperText = coverEnabled
    ? channelMeta.helpText
    : '总封面开关关闭后，这里即使保留“带封面通知”，实际发送时也会自动回退为默认摘要通知。';

  return `
    <article class="notification-cover-channel-card">
      <div class="template-preview-head">
        <div>
          <strong>${escapeHtml(channelMeta.title)}</strong>
          <p>${escapeHtml(channelMeta.description)}</p>
        </div>
        <span class="tag subtle">${escapeHtml(notificationCoverDeliveryModeLabel(selectedMode))}</span>
      </div>
      <label>
        <span>通知样式（Notification Style）</span>
        <select name="${escapeHtml(fieldName)}">
          ${NOTIFICATION_COVER_DELIVERY_MODE_META.map(
            (item) => `
              <option value="${escapeHtml(item.id)}" ${item.id === selectedMode ? 'selected' : ''}>
                ${escapeHtml(item.label)}
              </option>
            `,
          ).join('')}
        </select>
      </label>
      <div class="notice info notification-cover-card-note">${escapeHtml(helperText)}</div>
    </article>
  `;
}

function renderNotificationEnhancementPanel(state, template) {
  const options = normalizeNotificationEnhancementOptions(template);
  const hasCoverDeliveryChannel = options.coverEnabled
    && Object.values(options.coverChannels || {}).some((mode) => mode === 'cover');

  return `
    <article class="panel notification-enhancement-panel">
      <div class="panel-header">
        <div>
          <p class="eyebrow">Enhance</p>
          <h3>通知增强</h3>
          <p>这里控制通知的显示行为，不影响上面的渠道密钥，也不会覆盖下面的模板文案。</p>
        </div>
        <span class="tag">${hasCoverDeliveryChannel ? '封面卡片' : options.translateToChinese ? '自动翻译' : '摘要通知'}</span>
      </div>
      <div class="notification-enhancement-stack">
        <form
          data-form="notification-template-options"
          data-channel="template"
          data-template-options-merge="saved"
          data-template-options-label="通知基础设置"
          class="stack notification-enhancement-section-card"
        >
          <div class="notification-enhancement-section-head">
            <div class="notification-enhancement-section-copy">
              <strong>通知基础设置</strong>
              <p>这里统一控制自动翻译、总封面开关和完整内容预览地址，保存后会立即作用到通知摘要和落地页入口。</p>
            </div>
            <span class="tag subtle">${options.coverEnabled ? '封面开启' : '封面关闭'}</span>
          </div>
          <div class="notification-enhancement-grid">
            <label class="notification-enhancement-card">
              <input name="translateToChinese" type="checkbox" ${options.translateToChinese ? 'checked' : ''} />
              <span>
                <strong>自动翻译成中文</strong>
                <small>自动复用系统设置里的翻译引擎，把英文邮件转成中文后再推送；链接会保留成可点击的“网址”，不会被翻译坏。</small>
              </span>
            </label>
            <label class="notification-enhancement-card">
              <input name="coverEnabled" type="checkbox" ${options.coverEnabled ? 'checked' : ''} />
              <span>
                <strong>启用通知封面</strong>
                <small>Telegram 与企业微信应用通知会优先带图片封面；企业微信机器人和飞书依旧保持摘要文本，不会影响原有排版策略。</small>
              </span>
            </label>
            <div class="notification-enhancement-card static-card">
              <span>
                <strong>完整内容预览页</strong>
                <small>所有通知默认只发送摘要内容；点击“查看完整内容”后，会跳到下方地址生成的加密预览页，尽量保持原邮件 HTML 排版。</small>
              </span>
            </div>
          </div>
          <label>
            <span>完整内容预览地址</span>
            <input
              name="previewBaseUrl"
              value="${escapeHtml(options.previewBaseUrl)}"
              placeholder="例如 https://mail.example.com"
              spellcheck="false"
              autocomplete="off"
            />
          </label>
          <div class="form-actions notification-enhancement-section-actions">
            <button class="button" type="submit">保存基础设置</button>
          </div>
        </form>

        <form
          data-form="notification-template-options"
          data-channel="template"
          data-template-options-merge="saved"
          data-template-options-label="渠道通知样式切换"
          class="stack notification-enhancement-section-card notification-cover-channel-settings"
        >
          <div class="notification-enhancement-section-head">
            <div class="notification-enhancement-section-copy">
              <strong>渠道通知样式切换</strong>
              <p>这里可以分别控制 Telegram 和企业微信应用通知，是走带封面的卡片通知，还是回到默认摘要通知。</p>
            </div>
            <span class="tag subtle">${hasCoverDeliveryChannel ? '支持混搭' : '当前全是默认摘要'}</span>
          </div>
          <div class="notification-cover-channel-grid">
            ${NOTIFICATION_COVER_CHANNEL_META.map(
              (item) => renderNotificationCoverChannelCard(item, options.coverChannels[item.id], options.coverEnabled),
            ).join('')}
          </div>
          <div class="notice info">如果总封面开关关闭，这里即使保留“带封面通知”，实际发送时也会自动回退成默认摘要通知。</div>
          <div class="form-actions notification-enhancement-section-actions">
            <button class="button" type="submit">保存渠道样式</button>
          </div>
        </form>

        <form
          data-form="notification-template-options"
          data-channel="template"
          data-template-options-merge="saved"
          data-template-options-label="邮件封面策略"
          class="stack notification-enhancement-section-card notification-cover-settings"
        >
          <div class="notification-enhancement-section-head">
            <div class="notification-enhancement-section-copy">
              <strong>邮件封面策略</strong>
              <p>系统会按标题和正文关键词自动识别验证码 / 订单 / 订阅 / 广告 / 垃圾 / 普通邮件，多关键词命中时优先使用匹配度最高的封面。</p>
            </div>
            <span class="tag subtle">6 类封面</span>
          </div>
          <article class="notification-cover-hub-card">
            <div class="notification-cover-spec notification-cover-hub-spec">
              <strong>推荐封面分辨率</strong>
              <span>建议使用 1200×630（19:10），最低建议 600×315，上传文件尽量不超过 2 MB，这样 TG 和企业微信应用卡片显示会更清晰。</span>
            </div>
            <div class="notification-cover-hub-grid">
              ${NOTIFICATION_COVER_CATEGORY_META.map((item) => renderNotificationCoverSummaryItem(item, options.covers[item.id], state.notificationCoverEditorCategory)).join('')}
            </div>
          </article>
          <div class="notice info">系统内置模式会直接使用项目自带默认封面；图片直链会同步保存到系统本地。若某个渠道切到“默认摘要通知”，它会忽略封面配置，继续发送原来的默认通知样式。</div>
          <div class="form-actions notification-enhancement-section-actions">
            <button class="button" type="submit">保存封面策略</button>
          </div>
          ${renderNotificationCoverEditorModal(options, state.notificationCoverEditorCategory)}
        </form>
      </div>
    </article>
  `;
}


function renderNotifications(state) {
  return renderNotificationsV2(state);
}

function renderNotificationsV2(state) {
  const notificationDrafts = state.notificationDrafts || {};
  const telegramDraft = notificationDrafts.telegram || {};
  const wecomDraft = notificationDrafts.wecom || {};
  const feishuDraft = notificationDrafts.feishu || {};
  const telegram = {
    enabled: false,
    configured: false,
    chatId: '',
    ...(state.notifications?.telegram || {}),
    ...telegramDraft,
  };
  const wecom = {
    enabled: false,
    configured: false,
    botConfigured: false,
    botSecretConfigured: false,
    appConfigured: false,
    appSecretConfigured: false,
    mode: 'bot',
    botId: '',
    targetId: '',
    botReady: false,
    corpId: '',
    agentId: '',
    receiverType: 'user',
    receiverId: '',
    appBaseUrl: '',
    callbackToken: '',
    encodingAesKey: '',
    callbackUrl: '',
    ...(state.notifications?.wecom || {}),
    ...wecomDraft,
  };
  const feishu = {
    enabled: false,
    configured: false,
    webhookHint: '',
    signatureEnabled: false,
    ...(state.notifications?.feishu || {}),
    ...feishuDraft,
  };
  const template = state.notifications?.template || {
    presetId: 'default',
    templates: {
      telegram: '',
      wecom: '',
      feishu: '',
    },
    options: {
      translateToChinese: false,
      previewBaseUrl: '',
    },
    presets: [],
    tokens: [],
    sample: {},
  };
  const templateWithDraftOptions = {
    ...template,
    options:
      state.notificationTemplateOptionsDraft && typeof state.notificationTemplateOptionsDraft === 'object'
        ? state.notificationTemplateOptionsDraft
        : template.options,
  };
  const activePreset =
    templateWithDraftOptions.presets?.find((preset) => preset.id === templateWithDraftOptions.presetId) ||
    templateWithDraftOptions.presets?.[0] || null;
  const wecomDiscovery = state.wecomDiscovery || {
    available: false,
    connected: false,
    botId: '',
    currentTargetId: '',
    lastError: '',
    recentTargets: [],
  };
  const notificationVisibility = state.notificationConfigVisibility || {};
  const notificationLoading = state.notificationConfigLoading || {};
  const notificationValues = state.notificationConfigValues || {};
  const guideModalMarkup = state.notificationGuideChannel ? renderNotificationGuideModal(state.notificationGuideChannel) : '';
  const emojiModalMarkup = state.notificationEmojiGuideOpen ? renderNotificationEmojiGuideModal() : '';
  const wecomMode = String(wecom.mode || 'bot').trim().toLowerCase() === 'app' ? 'app' : 'bot';
  const botEnabled = Boolean(wecom.enabled) && wecomMode === 'bot';
  const appEnabled = Boolean(wecom.enabled) && wecomMode === 'app';
  const getNotificationDraftValue = (channel, field) => {
    const draft = notificationDrafts?.[channel];
    if (!draft) {
      return undefined;
    }

    return Object.prototype.hasOwnProperty.call(draft, field) ? draft[field] : undefined;
  };
  const isNotificationConfigVisible = (channel, field, configured) =>
    !configured || Boolean(notificationVisibility?.[channel]?.[field]);
  const getNotificationConfigValue = (channel, field, fallback = '') => {
    const draftValue = getNotificationDraftValue(channel, field);
    if (draftValue !== undefined) {
      return draftValue == null ? fallback : draftValue;
    }

    const value = notificationValues?.[channel]?.[field];
    return value == null ? fallback : value;
  };
  const renderNotificationVisibilityToggle = (channel, field, configured) => {
    if (!configured) {
      return '';
    }

    const loading = Boolean(notificationLoading?.[channel]?.[field]);
    const visible = Boolean(notificationVisibility?.[channel]?.[field]);
    const label = loading ? '读取中...' : visible ? '隐藏' : '显示';
    return `
      <button
        class="password-toggle-button ${visible ? 'is-active' : ''}"
        type="button"
        data-action="toggle-notification-config-visibility"
        data-channel="${escapeHtml(channel)}"
        data-field="${escapeHtml(field)}"
        ${loading ? 'disabled' : ''}
      >
        ${escapeHtml(label)}
      </button>
    `;
  };
  const renderNotificationInput = ({
    channel,
    configured,
    field,
    label,
    value = '',
    placeholder = '',
    hiddenPlaceholder = '已隐藏，点击右侧显示查看',
    fieldClassName = '',
  }) => {
    const visible = isNotificationConfigVisible(channel, field, configured);
    const resolvedValue = visible ? getNotificationConfigValue(channel, field, value) : '';
    const classes = ['notification-config-field', fieldClassName, visible ? '' : 'is-hidden']
      .filter(Boolean)
      .join(' ');

    return `
      <label class="${escapeHtml(classes)}">
        <span>${escapeHtml(label)}</span>
        <div class="password-field">
          <input
            name="${escapeHtml(field)}"
            value="${escapeHtml(resolvedValue)}"
            placeholder="${escapeHtml(visible ? placeholder : hiddenPlaceholder)}"
            ${visible ? '' : 'readonly'}
            spellcheck="false"
            autocomplete="off"
          />
          ${configured ? renderNotificationVisibilityToggle(channel, field, configured) : ''}
        </div>
      </label>
    `;
  };
  const renderNotificationReadonlyField = ({
    label,
    value = '',
    placeholder = '',
    fieldClassName = '',
  }) => `
    <label class="${escapeHtml(['notification-config-field', fieldClassName].filter(Boolean).join(' '))}">
      <span>${escapeHtml(label)}</span>
      <div class="password-field">
        <input
          value="${escapeHtml(value)}"
          placeholder="${escapeHtml(placeholder)}"
          readonly
          spellcheck="false"
          autocomplete="off"
        />
      </div>
    </label>
  `;

  const appSecretDraft = String(getNotificationConfigValue('wecom', 'appSecret', wecomDraft.appSecret || '')).trim();
  const wecomAppMissingFields = [];
  if (!String(wecom.corpId || '').trim()) {
    wecomAppMissingFields.push('Corp ID（企业 ID）');
  }
  if (!String(wecom.agentId || '').trim()) {
    wecomAppMissingFields.push('Agent ID（应用 ID）');
  }
  if (!String(wecom.receiverId || '').trim()) {
    wecomAppMissingFields.push('Receiver ID（接收对象 ID）');
  }
  if (!String(wecom.appBaseUrl || '').trim()) {
    wecomAppMissingFields.push('Public Base URL（系统公网地址）');
  }
  if (!wecom.appSecretConfigured && !appSecretDraft) {
    wecomAppMissingFields.push('App Secret（应用密钥）');
  }
  const wecomAppSetupNotice = wecomAppMissingFields.length
    ? `<div class="notice warning">应用卡片模式还缺少：${escapeHtml(wecomAppMissingFields.join('、'))}。如果你现在只是先拿 Callback URL（接收消息 URL）/ Callback Token（回调令牌）/ EncodingAESKey（消息加解密密钥），请先不要勾选启用，先保存一次基础配置。</div>`
    : !String(wecom.callbackUrl || '').trim()
      ? '<div class="notice info">基础配置已经齐了，点击一次“保存企业微信应用配置”后，下面会自动生成 Callback URL（接收消息 URL）/ Callback Token（回调令牌）/ EncodingAESKey（消息加解密密钥）。</div>'
      : '';
  const summarizeNotificationValue = (
    value = '',
    { empty = '未填写', max = 34, head = 12, tail = 8, type = 'plain' } = {},
  ) => {
    const normalized = String(value || '').trim();
    if (!normalized) {
      return empty;
    }

    let displayValue = normalized;
    if (type === 'host') {
      try {
        displayValue = new URL(normalized).host || normalized;
      } catch {
        displayValue = normalized.replace(/^https?:\/\//i, '');
      }
    }

    if (displayValue.length <= max) {
      return displayValue;
    }

    return `${displayValue.slice(0, head)}...${displayValue.slice(-tail)}`;
  };
  const renderNotificationSummaryFacts = (items = []) => `
    <div class="notification-channel-stat-grid">
      ${items
        .filter((item) => item && item.label)
        .map(
          (item) => `
            <div class="notification-channel-stat">
              <span>${escapeHtml(item.label)}</span>
              <strong>${escapeHtml(item.value || '未填写')}</strong>
            </div>
          `,
        )
        .join('')}
    </div>
  `;
  const renderNotificationSummaryCard = ({
    icon,
    title,
    description,
    configured = false,
    enabled = false,
    editorKey = '',
    summaryItems = [],
    extraTags = [],
    note = '',
  }) => `
    <article class="panel notification-channel-card ${state.notificationChannelEditorKey === editorKey ? 'is-active' : ''}" data-icon="${escapeHtmlAttribute(icon)}">
      <div class="panel-header">
        <div>
          <h3>${escapeHtml(title)}</h3>
          <p>${escapeHtml(description)}</p>
        </div>
        <div class="notification-card-meta">
          <div class="notification-card-status">
            ${extraTags
              .map(
                (item) => `
                  <span class="tag subtle">${escapeHtml(item)}</span>
                `,
              )
              .join('')}
            <span class="tag ${configured ? '' : 'subtle'}">${configured ? '已配置' : '未配置'}</span>
            <span class="tag ${enabled ? '' : 'subtle'}">${enabled ? '当前启用' : '未启用'}</span>
          </div>
        </div>
      </div>
      <div class="notification-channel-card-body">
        ${renderNotificationSummaryFacts(summaryItems)}
        ${note ? `<p class="notification-channel-card-note">${escapeHtml(note)}</p>` : ''}
        <div class="notification-channel-card-actions">
          <button class="tiny-button" type="button" data-action="open-notification-channel-editor" data-editor="${escapeHtmlAttribute(editorKey)}">
            编辑
          </button>
        </div>
      </div>
    </article>
  `;
  const renderTelegramNotificationForm = () => `
    <form data-form="notification-telegram" data-channel="telegram" data-notification-channel-editor-form="true" class="stack notification-channel-editor-form">
      <div class="notification-toggle-row">
        <label class="check-field notification-toggle-field">
          <span>启用 Telegram 新邮件通知</span>
          <input name="enabled" type="checkbox" ${telegram.enabled ? 'checked' : ''} />
        </label>
        <button class="mailbox-guide-chip notification-guide-trigger" type="button" data-action="open-notification-guide" data-channel="telegram">配置说明</button>
      </div>
      <div class="notification-form-grid">
        ${renderNotificationInput({
          channel: 'telegram',
          configured: telegram.configured,
          field: 'botToken',
          label: 'Bot Token（机器人令牌）',
          value: telegram.botToken || '',
          placeholder: '123456:ABC...',
        })}
      </div>
      <div class="notification-form-grid">
        ${renderNotificationInput({
          channel: 'telegram',
          configured: telegram.configured,
          field: 'chatId',
          label: 'Chat ID（会话 ID）',
          value: telegram.chatId || '',
          placeholder: '-100xxxxxxxxxx 或 ChatID（群聊 ID）',
        })}
      </div>
      <div class="form-actions">
        <button class="button ghost" type="button" data-action="test-notification" data-channel="telegram">发送测试消息</button>
        <button class="button" type="submit">保存 Telegram 配置</button>
      </div>
    </form>
  `;
  const renderWecomBotNotificationForm = () => `
    <form data-form="notification-wecom-bot" data-channel="wecom" data-wecom-kind="bot" data-notification-channel-editor-form="true" class="stack notification-channel-editor-form">
      <input name="mode" type="hidden" value="bot" />
      <div class="notification-toggle-row">
        <label class="check-field notification-toggle-field">
          <span>启用企业微信机器人通知</span>
          <input name="enabled" type="checkbox" ${botEnabled ? 'checked' : ''} />
        </label>
        <button class="mailbox-guide-chip notification-guide-trigger" type="button" data-action="open-notification-guide" data-channel="wecom-bot">配置说明</button>
      </div>
      <div class="notification-form-grid">
        ${renderNotificationInput({
          channel: 'wecom',
          configured: wecom.botConfigured,
          field: 'botId',
          label: 'Bot ID（机器人 ID）',
          value: wecom.botId || '',
          placeholder: '填写企业微信后台创建的 Bot ID（机器人 ID）',
        })}
      </div>
      <div class="notification-form-grid">
        ${renderNotificationInput({
          channel: 'wecom',
          configured: wecom.botConfigured,
          field: 'botSecret',
          label: 'Bot Secret（机器人密钥）',
          value: wecomDraft.botSecret || '',
          placeholder: '填写企业微信后台生成的 Bot Secret（机器人密钥）',
        })}
      </div>
      <div class="notification-form-grid">
        ${renderNotificationInput({
          channel: 'wecom',
          configured: wecom.botConfigured,
          field: 'targetId',
          label: 'Target ID（目标 ID）',
          value: wecom.targetId || '',
          placeholder: '单聊填 UserID（成员 ID），群聊填 ChatID（群聊 ID）',
        })}
      </div>
      <div class="notice info">单聊使用 <code>UserID</code>（成员 ID），群聊使用 <code>ChatID</code>（群聊 ID）。现在可以先不填，等下面的会话助手自动捕获后再一键保存。</div>
      <div class="form-actions">
        <button class="button ghost" type="button" data-action="test-notification" data-channel="wecom">发送测试消息</button>
        <button class="button" type="submit">保存企业微信机器人配置</button>
      </div>
    </form>
  `;
  const renderWecomAppNotificationForm = () => `
    <form data-form="notification-wecom-app" data-channel="wecom" data-wecom-kind="app" data-notification-channel-editor-form="true" class="stack notification-channel-editor-form">
      <input name="mode" type="hidden" value="app" />
      <div class="notification-toggle-row">
        <label class="check-field notification-toggle-field">
          <span>启用企业微信应用通知</span>
          <input name="enabled" type="checkbox" ${appEnabled ? 'checked' : ''} />
        </label>
        <button class="mailbox-guide-chip notification-guide-trigger" type="button" data-action="open-notification-guide" data-channel="wecom-app">配置说明</button>
      </div>
      ${wecomAppSetupNotice}
      <div class="notification-form-cluster">
        <div class="notification-form-cluster-head">
          <strong>应用凭据</strong>
          <span>先把企业微信应用的基础参数填完整</span>
        </div>
        <div class="notification-form-grid compact-2">
          ${renderNotificationInput({
            channel: 'wecom',
            configured: wecom.appConfigured,
            field: 'corpId',
            label: 'Corp ID（企业 ID）',
            value: wecom.corpId || '',
            placeholder: '填写企业微信 Corp ID（企业 ID）',
          })}
          ${renderNotificationInput({
            channel: 'wecom',
            configured: wecom.appConfigured,
            field: 'agentId',
            label: 'Agent ID（应用 ID）',
            value: wecom.agentId || '',
            placeholder: '填写企业微信应用 Agent ID（应用 ID）',
          })}
        </div>
        <div class="notification-form-grid">
          ${renderNotificationInput({
            channel: 'wecom',
            configured: wecom.appConfigured,
            field: 'appSecret',
            label: 'App Secret（应用密钥）',
            value: wecomDraft.appSecret || '',
            placeholder: '填写企业微信应用 App Secret（应用密钥）',
          })}
        </div>
      </div>
      <div class="notification-form-cluster">
        <div class="notification-form-cluster-head">
          <strong>接收对象</strong>
          <span>决定应用卡片通知发给谁</span>
        </div>
        <div class="notification-form-grid compact-2">
          <label class="notification-config-field">
            <span>Receiver Type（接收对象类型）</span>
            <select name="receiverType">
              <option value="user" ${String(wecom.receiverType || 'user') === 'user' ? 'selected' : ''}>User（成员 UserID）</option>
              <option value="party" ${String(wecom.receiverType || '') === 'party' ? 'selected' : ''}>Party（部门 PartyID）</option>
              <option value="tag" ${String(wecom.receiverType || '') === 'tag' ? 'selected' : ''}>Tag（标签 TagID）</option>
            </select>
          </label>
          ${renderNotificationInput({
            channel: 'wecom',
            configured: wecom.appConfigured,
            field: 'receiverId',
            label: 'Receiver ID（接收对象 ID）',
            value: wecom.receiverId || '',
            placeholder: '例如 UserID、PartyID、TagID，多个成员可用 | 分隔',
          })}
        </div>
      </div>
      <div class="notification-form-cluster">
        <div class="notification-form-cluster-head">
          <strong>回调配置</strong>
          <span>公网入口和 URL 校验参数统一放在这里</span>
        </div>
        <div class="notification-form-grid">
          ${renderNotificationInput({
            channel: 'wecom',
            configured: wecom.appConfigured,
            field: 'appBaseUrl',
            label: 'Public Base URL（系统公网地址）',
            value: wecom.appBaseUrl || '',
            placeholder: '例如 https://mail.example.com',
          })}
        </div>
        <div class="notification-form-grid">
          ${renderNotificationReadonlyField({
            label: 'Callback URL（接收消息 URL）',
            value: wecom.callbackUrl || '',
            placeholder: '先填写 Public Base URL（系统公网地址）并保存一次，这里会自动生成',
          })}
        </div>
        <div class="notification-form-grid">
          ${renderNotificationInput({
            channel: 'wecom',
            configured: wecom.appConfigured,
            field: 'callbackToken',
            label: 'Callback Token（回调令牌）',
            value: wecom.callbackToken || '',
            placeholder: '留空则首次保存时自动生成',
          })}
        </div>
        <div class="notification-form-grid">
          ${renderNotificationInput({
            channel: 'wecom',
            configured: wecom.appConfigured,
            field: 'encodingAesKey',
            label: 'EncodingAESKey（消息加解密密钥）',
            value: wecom.encodingAesKey || '',
            placeholder: '留空则首次保存时自动生成',
          })}
        </div>
      </div>
      <div class="notice info">如果你要在企业微信后台开启“接收消息”，就把这里生成的 Callback URL（接收消息 URL）、Callback Token（回调令牌）和 EncodingAESKey（消息加解密密钥）填到应用的“API 接收消息”里；Public Base URL（系统公网地址）必须是企业微信外网能直接访问到的 HTTPS 地址。</div>
      <div class="form-actions">
        <button class="button ghost" type="button" data-action="test-notification" data-channel="wecom">发送测试消息</button>
        <button class="button" type="submit">保存企业微信应用配置</button>
      </div>
    </form>
  `;
  const renderFeishuNotificationForm = () => `
    <form data-form="notification-feishu" data-channel="feishu" data-notification-channel-editor-form="true" class="stack notification-channel-editor-form">
      <div class="notification-toggle-row">
        <label class="check-field notification-toggle-field">
          <span>启用飞书新邮件通知</span>
          <input name="enabled" type="checkbox" ${feishu.enabled ? 'checked' : ''} />
        </label>
        <button class="mailbox-guide-chip notification-guide-trigger" type="button" data-action="open-notification-guide" data-channel="feishu">配置说明</button>
      </div>
      <div class="notification-form-grid">
        ${renderNotificationInput({
          channel: 'feishu',
          configured: feishu.configured,
          field: 'webhookUrl',
          label: 'Webhook URL（机器人地址）',
          value: feishu.webhookUrl || '',
          placeholder: feishu.webhookHint || 'https://open.feishu.cn/open-apis/bot/v2/hook/...',
        })}
      </div>
      <div class="notification-form-grid">
        ${renderNotificationInput({
          channel: 'feishu',
          configured: feishu.configured,
          field: 'signSecret',
          label: 'Sign Secret（签名密钥，可选）',
          value: feishu.signSecret || '',
          placeholder: feishu.signatureEnabled ? '如需修改 Sign Secret（签名密钥），可直接在这里覆盖' : '如果飞书机器人开启签名校验，就填写这里',
        })}
      </div>
      <div class="notice info">如果机器人只开启了关键词或 IP 白名单，可以只填写 Webhook URL（机器人地址）；只有开启签名校验时才需要额外填写 Sign Secret（签名密钥）。</div>
      <div class="form-actions">
        <button class="button ghost" type="button" data-action="test-notification" data-channel="feishu">发送测试消息</button>
        <button class="button" type="submit">保存飞书配置</button>
      </div>
    </form>
  `;
  const notificationChannelEditorMarkup = (() => {
    const editorKey = String(state.notificationChannelEditorKey || '').trim();
    const editorMap = {
      telegram: {
        eyebrow: 'Telegram',
        title: 'Telegram 通知',
        description: '填写 Bot Token（机器人令牌）和 Chat ID（会话 ID）后，新邮件同步完成会自动推送到 Telegram 机器人。',
        badges: [telegram.configured ? '已配置' : '未配置', telegram.enabled ? '当前启用' : '未启用'],
        content: renderTelegramNotificationForm(),
      },
      'wecom-bot': {
        eyebrow: 'WeCom Bot',
        title: '企业微信机器人',
        description: '机器人模式会把新邮件推送到单聊或群聊，Target ID（目标 ID）可以在下面的工具区自动捕获并保存。',
        badges: ['机器人模式', wecom.botConfigured ? '已配置' : '未配置', botEnabled ? '当前启用' : '未启用'],
        content: renderWecomBotNotificationForm(),
      },
      'wecom-app': {
        eyebrow: 'WeCom App',
        title: '企业微信应用',
        description: '应用模式会发送卡片通知，点开后直接查看原邮件 HTML 预览页，并支持接收消息回调。',
        badges: ['应用卡片', wecom.appConfigured ? '已配置' : '未配置', appEnabled ? '当前启用' : '未启用'],
        content: renderWecomAppNotificationForm(),
      },
      feishu: {
        eyebrow: 'Feishu',
        title: '飞书机器人',
        description: '填写飞书机器人的 Webhook URL（机器人地址）即可推送新邮件；如果开启签名校验，也可以同时填写 Sign Secret（签名密钥）。',
        badges: [feishu.configured ? '已配置' : '未配置', feishu.enabled ? '当前启用' : '未启用'],
        content: renderFeishuNotificationForm(),
      },
    };
    const editor = editorMap[editorKey];
    if (!editor) {
      return '';
    }

    return `
      <div class="modal-shell notification-channel-editor-shell">
        <div class="modal-backdrop" data-notification-channel-editor-overlay></div>
        <section class="modal-panel notification-channel-editor-modal">
          <div class="notification-channel-editor-head">
            <div class="notification-channel-editor-copy">
              <p class="eyebrow">${escapeHtml(editor.eyebrow)}</p>
              <h3>${escapeHtml(editor.title)}</h3>
              <p>${escapeHtml(editor.description)}</p>
              <div class="notification-channel-editor-meta">
                ${editor.badges
                  .map(
                    (item) => `
                      <span class="tag subtle">${escapeHtml(item)}</span>
                    `,
                  )
                  .join('')}
              </div>
            </div>
            <button class="modal-close" type="button" data-action="close-notification-channel-editor" aria-label="关闭通知渠道编辑">×</button>
          </div>
          <div class="notification-channel-editor-body">
            ${editor.content}
          </div>
        </section>
      </div>
    `;
  })();
  const renderNotificationToolSummaryCard = ({
    toolKey,
    icon = 'notes',
    eyebrow = '',
    title,
    description,
    status = '',
    statusTone = 'subtle',
    facts = [],
    actionLabel = '查看',
    extraAction = '',
  }) => `
    <article class="notification-tool-summary-card ${state.notificationToolModalKey === toolKey ? 'is-active' : ''}">
      <div class="notification-tool-summary-head">
        ${renderAutoIcon(icon, title, 'notification-tool-summary-icon')}
        <div class="notification-tool-summary-copy">
          ${eyebrow ? `<p class="eyebrow">${escapeHtml(eyebrow)}</p>` : ''}
          <h3>${escapeHtml(title)}</h3>
          <p>${escapeHtml(description)}</p>
        </div>
        ${status ? `<span class="tag ${escapeHtml(statusTone)}">${escapeHtml(status)}</span>` : ''}
      </div>
      <div class="notification-tool-summary-facts">
        ${facts
          .filter((item) => item && item.label)
          .map(
            (item) => `
              <div class="notification-tool-summary-fact">
                <span>${escapeHtml(item.label)}</span>
                <strong>${escapeHtml(item.value || '未填写')}</strong>
              </div>
            `,
          )
          .join('')}
      </div>
      <div class="notification-tool-summary-actions">
        ${extraAction}
        <button
          class="tiny-button"
          type="button"
          data-action="open-notification-tool-modal"
          data-tool="${escapeHtmlAttribute(toolKey)}"
        >
          ${escapeHtml(actionLabel)}
        </button>
      </div>
    </article>
  `;
  const renderWecomDiscoveryToolContent = () => `
    <div class="tool-summary">
      <div class="tool-stat">
        <span>Bot ID（机器人 ID）</span>
        <strong>${escapeHtml(wecomDiscovery.botId || wecom.botId || '未填写')}</strong>
      </div>
      <div class="tool-stat">
        <span>Target ID（目标 ID）</span>
        <strong>${escapeHtml(wecomDiscovery.currentTargetId || wecom.targetId || '未选择')}</strong>
      </div>
      <div class="tool-stat">
        <span>连接状态</span>
        <strong>${wecomDiscovery.available ? (wecomDiscovery.connected ? '已连接，正在监听会话' : '凭据已保存，正在尝试连接') : '请先保存 Bot ID（机器人 ID）和 Bot Secret（机器人密钥）'}</strong>
      </div>
    </div>
    ${wecomDiscovery.lastError ? `<div class="notice error">${escapeHtml(wecomDiscovery.lastError)}</div>` : ''}
    <div class="tool-chip-grid">
      ${
        wecomDiscovery.recentTargets?.length
          ? wecomDiscovery.recentTargets
              .map(
                (entry) => `
                  <div class="tool-chip">
                    <div class="message-topline">
                      <strong>${entry.targetType === 'group' ? '群聊会话' : '单聊用户'}</strong>
                      <span>${escapeHtml(formatDate(entry.lastSeenAt))}</span>
                    </div>
                    <p>${escapeHtml(entry.targetType === 'group' ? '使用 ChatID（群聊 ID）作为目标 ID' : '使用 UserID（成员 ID）作为目标 ID')}</p>
                    <code>${escapeHtml(entry.targetId)}</code>
                    ${entry.actorUserId ? `<small>触发者：${escapeHtml(entry.actorUserId)}</small>` : ''}
                    ${entry.preview ? `<small>${escapeHtml(entry.preview)}</small>` : ''}
                    <div class="tool-chip-actions">
                      <button class="tiny-button" type="button" data-action="use-wecom-target" data-target-id="${escapeHtml(entry.targetId)}">直接使用这个 ID</button>
                    </div>
                  </div>
                `,
              )
              .join('')
          : '<div class="empty-card">还没有捕获到企业微信会话。先保存 Bot ID（机器人 ID）和 Bot Secret（机器人密钥），再让目标用户或群聊给机器人发一条消息，然后回来刷新这里。</div>'
      }
    </div>
  `;
  const renderNotificationNotesContent = () => `
    <div class="tool-note-grid">
      <div class="tool-note"><span>推送内容</span><strong>所有通知默认发送摘要；机器人模式走模板文案，应用模式走卡片通知并支持点击查看原邮件 HTML 预览页。</strong></div>
      <div class="tool-note"><span>触发范围</span><strong>只会推送当前登录用户归属的邮箱邮件，不会串号。</strong></div>
      <div class="tool-note"><span>模板回退</span><strong>任意渠道模板留空时，会自动使用当前预设的默认模板。</strong></div>
      <div class="tool-note"><span>企业微信目标</span><strong>机器人卡片填写 UserID（成员 ID）/ ChatID（群聊 ID），也可以直接用会话助手自动保存；应用卡片则填写成员、部门或标签对应的 Receiver ID（接收对象 ID）。</strong></div>
    </div>
  `;
  const renderWecomAppGuideContent = () => `
    <div class="tool-summary">
      <div class="tool-stat">
        <span>Corp ID（企业 ID）</span>
        <strong>${escapeHtml(wecom.corpId || '未填写')}</strong>
      </div>
      <div class="tool-stat">
        <span>Agent ID（应用 ID）</span>
        <strong>${escapeHtml(wecom.agentId || '未填写')}</strong>
      </div>
      <div class="tool-stat">
        <span>Receiver ID（接收对象 ID）</span>
        <strong>${escapeHtml(wecom.receiverId || '未填写')}</strong>
      </div>
      <div class="tool-stat">
        <span>Public Base URL（系统公网地址）</span>
        <strong>${escapeHtml(wecom.appBaseUrl || '未填写')}</strong>
      </div>
      <div class="tool-stat">
        <span>Callback URL（接收消息 URL）</span>
        <strong>${escapeHtml(wecom.callbackUrl || '未生成')}</strong>
      </div>
      <div class="tool-stat">
        <span>回调参数</span>
        <strong>${wecom.callbackToken && wecom.encodingAesKey ? 'Callback Token / EncodingAESKey 已就绪' : '待生成'}</strong>
      </div>
    </div>
    <div class="tool-note-grid">
      <div class="tool-note"><span>消息形态</span><strong>卡片里展示主题、发件人、邮箱、时间和摘要，主按钮直接跳转查看邮件原文。</strong></div>
      <div class="tool-note"><span>打开效果</span><strong>打开后的页面由 Mail Union 渲染，正文优先按原邮件 HTML 排版展示，不再退回成纯文本摘要。</strong></div>
      <div class="tool-note"><span>访问要求</span><strong>企业微信端必须能访问你填写的 Public Base URL（系统公网地址）；如果是本机 localhost，企业微信手机端无法打开。</strong></div>
      <div class="tool-note"><span>接收消息</span><strong>如果你开启企业微信应用的 API 接收消息，就把 Callback URL（接收消息 URL）、Callback Token（回调令牌）和 EncodingAESKey（消息加解密密钥）原样填进去，系统会自动完成 URL 有效性校验。</strong></div>
    </div>
  `;
  const notificationToolModalMarkup = (() => {
    const toolKey = String(state.notificationToolModalKey || '').trim();
    const toolMap = {
      'wecom-discovery': {
        eyebrow: 'Bot',
        icon: 'wecom',
        title: '企业微信会话 ID 助手',
        description: '保存 Bot ID（机器人 ID）和 Bot Secret（机器人密钥）后，让机器人先收到一条消息，再回来这里选择目标即可。',
        badges: [wecomDiscovery.connected ? '已连接' : '未连接'],
        actions: '<button class="button ghost" type="button" data-action="refresh-wecom-discovery">刷新会话列表</button>',
        content: renderWecomDiscoveryToolContent(),
      },
      notes: {
        eyebrow: 'Notes',
        icon: 'notes',
        title: '通知说明',
        description: '全局通知规则、触发范围、模板回退和企业微信目标说明统一放在这里。',
        badges: ['全局说明'],
        actions: '',
        content: renderNotificationNotesContent(),
      },
      'wecom-app-guide': {
        eyebrow: 'App',
        icon: 'wecom',
        title: '企业微信应用卡片说明',
        description: '应用模式会发送卡片通知，点击后直接打开 Mail Union 的邮件预览页，尽量保留原邮件 HTML 排版效果。',
        badges: [wecom.appConfigured ? '已就绪' : '待配置'],
        actions: '',
        content: renderWecomAppGuideContent(),
      },
    };
    const tool = toolMap[toolKey];
    if (!tool) {
      return '';
    }

    return `
      <div class="modal-shell notification-tool-modal-shell">
        <div class="modal-backdrop" data-notification-tool-overlay></div>
        <section class="modal-panel notification-tool-modal">
          <div class="notification-channel-editor-head">
            <div class="notification-channel-editor-copy">
              <p class="eyebrow">${escapeHtml(tool.eyebrow)}</p>
              <h3>${escapeHtml(tool.title)}</h3>
              <p>${escapeHtml(tool.description)}</p>
              <div class="notification-channel-editor-meta">
                ${tool.badges.map((item) => `<span class="tag subtle">${escapeHtml(item)}</span>`).join('')}
              </div>
            </div>
            <div class="notification-tool-modal-head-actions">
              ${tool.actions}
              <button class="modal-close" type="button" data-action="close-notification-tool-modal" aria-label="关闭详情">×</button>
            </div>
          </div>
          <div class="notification-tool-modal-body">
            ${tool.content}
          </div>
        </section>
      </div>
    `;
  })();

  return `
    <section class="view-grid view-grid-notifications">
      <div class="notification-card-grid">
        ${renderNotificationSummaryCard({
          icon: 'wecom',
          title: '企业微信应用',
          description: '适合卡片通知、落地页和回调接收。',
          configured: wecom.appConfigured,
          enabled: appEnabled,
          editorKey: 'wecom-app',
          extraTags: ['应用卡片'],
          summaryItems: [
            {
              label: 'Receiver ID（接收对象 ID）',
              value: summarizeNotificationValue(wecom.receiverId, { empty: '未填写', max: 28, head: 10, tail: 8 }),
            },
            {
              label: 'Callback URL（接收消息 URL）',
              value: wecom.callbackUrl ? '已生成' : '保存后自动生成',
            },
            {
              label: 'Public Base URL（系统公网地址）',
              value: summarizeNotificationValue(wecom.appBaseUrl, { empty: '未填写', type: 'host', max: 28, head: 14, tail: 10 }),
            },
            {
              label: 'App Secret（应用密钥）',
              value: wecom.appSecretConfigured || String(wecomDraft.appSecret || '').trim() ? '已填写' : '未填写',
            },
          ],
          note: '详细参数、回调地址和测试发送都统一在弹窗里处理。',
        })}
        ${renderNotificationSummaryCard({
          icon: 'telegram',
          title: 'Telegram 通知',
          description: '摘要通知会直接推送到 Telegram 会话。',
          configured: telegram.configured,
          enabled: telegram.enabled,
          editorKey: 'telegram',
          summaryItems: [
            {
              label: 'Chat ID（会话 ID）',
              value: summarizeNotificationValue(telegram.chatId, { empty: '未填写', max: 28, head: 10, tail: 8 }),
            },
            {
              label: 'Bot Token（机器人令牌）',
              value: telegram.configured || String(telegramDraft.botToken || '').trim() ? '已填写' : '未填写',
            },
          ],
          note: '主页只保留预览，详细配置放到弹窗里维护。',
        })}
        ${renderNotificationSummaryCard({
          icon: 'wecom',
          title: '企业微信机器人',
          description: '适合成员或群聊的机器人摘要推送。',
          configured: wecom.botConfigured,
          enabled: botEnabled,
          editorKey: 'wecom-bot',
          extraTags: ['机器人模式'],
          summaryItems: [
            {
              label: 'Target ID（目标 ID）',
              value: summarizeNotificationValue(wecom.targetId, { empty: '未填写', max: 28, head: 10, tail: 8 }),
            },
            {
              label: 'Bot ID（机器人 ID）',
              value: summarizeNotificationValue(wecom.botId, { empty: '未填写', max: 28, head: 10, tail: 8 }),
            },
            {
              label: 'Bot Secret（机器人密钥）',
              value: wecom.botSecretConfigured || String(wecomDraft.botSecret || '').trim() ? '已填写' : '未填写',
            },
            {
              label: '会话助手',
              value: wecomDiscovery.connected ? '已连接，可自动捕获' : '可在下方工具区捕获',
            },
          ],
          note: '目标 ID 助手仍然保留在下方工具区，和现在的使用方式一致。',
        })}
        ${renderNotificationSummaryCard({
          icon: 'feishu',
          title: '飞书机器人',
          description: '适合飞书群机器人接收简洁邮件摘要。',
          configured: feishu.configured,
          enabled: feishu.enabled,
          editorKey: 'feishu',
          summaryItems: [
            {
              label: 'Webhook URL（机器人地址）',
              value: summarizeNotificationValue(feishu.webhookUrl, { empty: '未填写', type: 'host', max: 28, head: 14, tail: 10 }),
            },
            {
              label: '签名校验',
              value: feishu.signatureEnabled ? '已开启' : '未开启',
            },
          ],
          note: '如果开启签名校验，也是在弹窗里继续维护 Sign Secret（签名密钥）。',
        })}
      </div>

      ${renderNotificationEnhancementPanel(state, templateWithDraftOptions)}

      <article class="panel template-panel">
        <div class="panel-header template-panel-head">
          <div>
            <p class="eyebrow">Templates</p>
            <h3>通知模板中心</h3>
            <p>先选一套默认模板，再决定是否为不同渠道单独 DIY。上面的“通知增强”负责自动翻译和完整预览入口；这里继续处理模板文案本身。</p>
          </div>
          <div class="template-panel-meta">
            <span class="tag">${escapeHtml(activePreset?.name || '默认简洁')}</span>
          </div>
        </div>
        <form data-form="notification-template" data-channel="template" class="stack template-form">
          <input name="presetId" type="hidden" value="${escapeHtml(template.presetId || 'default')}" />
          <div class="template-preset-grid">
            ${renderNotificationTemplatePresetCards(template)}
          </div>
          <div class="template-toolbar">
            <div class="template-toolbar-row">
              <div class="template-token-grid">
                ${renderNotificationTemplateTokenChips(template)}
              </div>
              <div class="template-toolbar-aside">
                <button class="mailbox-guide-chip notification-guide-trigger" type="button" data-action="open-notification-emoji-guide">表情文档</button>
              </div>
            </div>
            <div class="form-actions template-form-actions">
              <button class="button ghost" type="button" data-action="load-template-preset">载入当前预设文案</button>
              <button class="button" type="submit">保存模板设置</button>
            </div>
          </div>
          <div class="notice info">可修改除标签以外的任意文字、顺序和分段。Telegram 支持 HTML 标签，企业微信机器人模式支持 Markdown，企业微信应用模式会自动转换成卡片样式，并尽量保留模板里的标题、引用、分段与符号，飞书默认按纯文本发送。</div>
          <div class="template-editor-grid">
            ${renderNotificationTemplateEditor(template, 'telegram', 'Telegram 模板', '适合做重点高亮和结构分层。', '支持 HTML：<b> <i> <code>')}
            ${renderNotificationTemplateEditor(template, 'wecom', '企业微信模板', '机器人模式直接发送 Markdown，应用模式会继承同一套文案并自动转换成卡片排版。', '支持 Markdown：标题、引用、换行；应用模式自动转卡片排版')}
            ${renderNotificationTemplateEditor(template, 'feishu', '飞书模板', '更适合控制文案节奏和段落。', '按纯文本发送，建议多用换行提升层次')}
          </div>
          <div class="template-preview-grid">
            ${renderNotificationTemplatePreviewCard(template, 'telegram', 'Telegram 预览')}
            ${renderNotificationTemplatePreviewCard(template, 'wecom', '企业微信预览')}
            ${renderNotificationTemplatePreviewCard(template, 'feishu', '飞书预览')}
          </div>
        </form>
      </article>

      <div class="notification-tool-summary-grid">
        ${renderNotificationToolSummaryCard({
          toolKey: 'wecom-discovery',
          icon: 'wecom',
          eyebrow: 'Bot',
          title: '企业微信会话 ID 助手',
          description: '捕获单聊 UserID（成员 ID）或群聊 ChatID（群聊 ID），详情在弹窗里查看。',
          status: wecomDiscovery.connected ? '已连接' : '未连接',
          statusTone: wecomDiscovery.connected ? '' : 'subtle',
          facts: [
            { label: 'Target ID（目标 ID）', value: summarizeNotificationValue(wecomDiscovery.currentTargetId || wecom.targetId, { empty: '未选择', max: 24, head: 9, tail: 7 }) },
            { label: '捕获会话', value: `${Number(wecomDiscovery.recentTargets?.length || 0)} 个` },
          ],
          extraAction: '<button class="tiny-button ghost" type="button" data-action="refresh-wecom-discovery">刷新</button>',
        })}
        ${renderNotificationToolSummaryCard({
          toolKey: 'notes',
          icon: 'notes',
          eyebrow: 'Notes',
          title: '通知说明',
          description: '推送内容、触发范围、模板回退和目标 ID 规则都收在这里。',
          status: '全局说明',
          facts: [
            { label: '推送内容', value: '摘要 + 完整内容链接' },
            { label: '模板回退', value: '留空自动用默认模板' },
          ],
        })}
        ${renderNotificationToolSummaryCard({
          toolKey: 'wecom-app-guide',
          icon: 'wecom',
          eyebrow: 'App',
          title: '企业微信应用卡片说明',
          description: '应用卡片参数、回调地址、打开效果和访问要求都放到详情里。',
          status: wecom.appConfigured ? '已就绪' : '待配置',
          statusTone: wecom.appConfigured ? '' : 'subtle',
          facts: [
            { label: 'Public Base URL（系统公网地址）', value: summarizeNotificationValue(wecom.appBaseUrl, { empty: '未填写', type: 'host', max: 24, head: 12, tail: 8 }) },
            { label: 'Callback URL（接收消息 URL）', value: wecom.callbackUrl ? '已生成' : '未生成' },
          ],
        })}
      </div>
      ${notificationChannelEditorMarkup}
      ${notificationToolModalMarkup}
      ${guideModalMarkup}
      ${emojiModalMarkup}
    </section>
  `;
}
export function hydrateMailboxPreset(state) {
  const form = document.querySelector('[data-form="mailbox"]');
  if (!form) {
    return;
  }

  const providerId = form.querySelector('[name="provider"]').value;
  const preset = state.providers.find((provider) => provider.id === providerId) || state.providers[0];
  if (!preset) {
    return;
  }

  const hostInput = form.querySelector('[name="imapHost"]');
  const portInput = form.querySelector('[name="imapPort"]');
  const note = form.querySelector('[data-provider-note]');

  if (!hostInput.value) hostInput.value = preset.imapHost || '';
  if (!portInput.value) portInput.value = preset.imapPort || 993;
  note.textContent = preset.note || '';
}

export function render(root, state) {
  if (!state.ready) {
    root.innerHTML = `
      <div class="boot-screen">
        <div class="boot-screen-shell">
          <div class="boot-screen-spinner-wrap" aria-hidden="true">
            <div class="cyber-loader-container">
              <div class="plasma-vial">
                <div class="fluid-chamber">
                  <div class="plasma-pool bottom-pool"></div>
                  <div class="plasma-pool top-pool"></div>
                  <div class="droplet d-1"></div>
                  <div class="droplet d-2"></div>
                  <div class="droplet d-3"></div>
                  <div class="droplet d-4"></div>
                  <div class="droplet d-5"></div>
                </div>
              </div>
              <div class="vial-base"></div>
            </div>
          </div>
          <div class="boot-screen-copy">
            <strong>系统加载中</strong>
            <p>正在初始化首页资源与登录状态，请稍候片刻...</p>
          </div>
        </div>
      </div>
    `;
    return;
  }

  if (state.portalKind === 'public') {
    root.innerHTML = renderLogin(state);
    return;
  }

  if (!state.user) {
    root.innerHTML = renderAuthPortal(state);
    return;
  }

  const currentView =
    state.view === 'inbox'
      ? renderInboxWorkspaceV2(state)
      : state.view === 'mailboxes'
        ? renderMailboxesWorkspaceV2(state)
        : state.view === 'notifications'
          ? renderNotificationsV2(state)
          : state.view === 'backups' && state.user.role === 'admin'
            ? renderBackups(state)
        : state.view === 'users' && state.user.role === 'admin'
          ? renderUsers(state)
          : state.view === 'system' && state.user.role === 'admin'
            ? renderSystemSettings(state)
          : state.view === 'profile'
            ? renderProfile(state)
            : renderDashboard(state);

  const collapsed = Boolean(state.sidebarCollapsed);
  const displayMenuItems = getDisplayMenuItems(state);
  const currentViewLabel = escapeHtml(menuItems(state).find((item) => item.id === state.view)?.label || '仪表盘');
  const themeToggleLabel = state.theme === 'dark' ? '浅色模式' : '深色模式';
  const sidebarToggleLabel = collapsed ? '展开菜单' : '收起菜单';
  const displayName = state.user.name || state.user.username || '用户';
  const displayHandle = formatUserHandle(state.user);
  const roleLabel = state.user.role === 'admin' ? '管理员' : '用户';
  const systemSettings = normalizeSystemSettings(state.systemSettings);
  const siteName = systemSettings.siteName || 'Mail Union';
  const siteLogoSource = systemBrandLogoSource(systemSettings);
  const sidebarBrandMark = siteLogoSource
    ? renderBrandAvatar(systemSettings, 'brand-avatar', `${siteName} logo`)
    : renderAutoIcon('system', siteName, 'brand-avatar brand-avatar-icon');
  const userAvatar = renderAvatar(
    state.user.avatarUrl,
    userInitials(state.user),
    'topbar-account-avatar',
    displayName,
  );
  const topbarAccountMarkup = `
    <div class="topbar-account ${state.topbarAccountMenuOpen ? 'is-open' : ''}" data-topbar-account>
      <button
        class="topbar-account-trigger"
        type="button"
        data-action="toggle-topbar-account-menu"
        aria-expanded="${state.topbarAccountMenuOpen ? 'true' : 'false'}"
      >
        ${userAvatar}
        <div class="topbar-account-copy">
          <strong>${escapeHtml(displayName)}</strong>
          <span>${escapeHtml(roleLabel)}</span>
        </div>
        <span class="topbar-account-caret" aria-hidden="true">${state.topbarAccountMenuOpen ? '▴' : '▾'}</span>
      </button>
      ${
        state.topbarAccountMenuOpen
          ? `
            <div class="topbar-account-menu">
              <div class="topbar-account-menu-head">
                ${renderAvatar(
                  state.user.avatarUrl,
                  userInitials(state.user),
                  'topbar-account-menu-avatar',
                  displayName,
                )}
                <div class="topbar-account-menu-copy">
                  <strong>${escapeHtml(displayName)}</strong>
                  <span>${escapeHtml(displayHandle)}</span>
                  <span class="pill topbar-role-pill">${escapeHtml(roleLabel)}</span>
                </div>
              </div>
              <div class="topbar-account-menu-actions">
                <button class="topbar-account-menu-item" type="button" data-action="open-profile-from-account">
                  ${renderAutoIcon('users', '个人资料', 'topbar-account-menu-icon')}
                  <span>个人资料</span>
                </button>
                <button class="topbar-account-menu-item is-danger" type="button" data-action="logout">
                  ${renderAutoIcon('logout', '退出登录', 'topbar-account-menu-icon')}
                  <span>退出登录</span>
                </button>
              </div>
            </div>
          `
          : ''
      }
    </div>
  `;
  const attachmentPreviewMarkup = renderAttachmentPreviewModal(state);
  const confirmDialogMarkup = renderConfirmDialog(state);

  root.innerHTML = `
    <div class="app-shell ${collapsed ? 'sidebar-collapsed' : ''}">
      <aside class="sidebar">
        <div class="sidebar-top">
          <div class="sidebar-head">
            <div class="brand-block ${collapsed ? 'is-collapsed' : ''}">
              ${sidebarBrandMark}
              <div class="brand-copy">
                <h1>${escapeHtml(siteName)}</h1>
              </div>
            </div>
          </div>
          <nav class="nav-list">
            ${displayMenuItems
              .map((item) => {
                return `
                  <button class="nav-item ${item.id === state.view ? 'active' : ''}" data-view="${escapeHtml(item.id)}" title="${escapeHtml(item.label)}">
                    ${renderAutoIcon(item.icon || item.id, item.label, 'nav-item-mark')}
                    <span class="nav-item-label">${escapeHtml(item.label)}</span>
                  </button>
                `;
              })
              .join('')}
          </nav>
        </div>
        <div class="sidebar-footer">
          <div class="sidebar-footer-tools">
            <button class="sidebar-utility" type="button" data-action="toggle-theme" title="${themeToggleLabel}">
              ${renderAutoIcon(state.theme === 'dark' ? 'theme-light' : 'theme-dark', themeToggleLabel, 'sidebar-utility-icon')}
              <span class="sidebar-utility-label">${themeToggleLabel}</span>
            </button>
            <button class="sidebar-utility" type="button" data-action="toggle-sidebar" title="${sidebarToggleLabel}">
              ${renderAutoIcon(collapsed ? 'menu-expand' : 'menu-collapse', sidebarToggleLabel, 'sidebar-utility-icon')}
              <span class="sidebar-utility-label">${sidebarToggleLabel}</span>
            </button>
          </div>
        </div>
      </aside>
      ${renderGlobalNotice(state.notice)}
      <main class="main-shell">
        <header class="topbar">
          <div class="topbar-title">
            ${renderSectionTitle(
              displayMenuItems.find((item) => item.id === state.view)?.icon || state.view,
              `<h2 class="topbar-view-label">${displayMenuItems.find((item) => item.id === state.view)?.label || currentViewLabel}</h2>`,
              'topbar-title-main',
            )}
          </div>
          <div class="topbar-actions">
            <div class="topbar-meta">
              <span class="pill topbar-role-pill">${escapeHtml(roleLabel)}</span>
            </div>
            ${topbarAccountMarkup}
          </div>
        </header>
        ${currentView}
      </main>
    </div>
    ${attachmentPreviewMarkup}
    ${confirmDialogMarkup}
  `;

  hydrateAutoIcons(root);
  hydrateMailboxPreset(state);
}

