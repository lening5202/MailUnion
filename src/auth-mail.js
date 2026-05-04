const nodemailer = require('nodemailer');
const { decrypt } = require('./crypto');

function trimString(value) {
  return String(value || '').trim();
}

function normalizeBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') {
    return Boolean(fallback);
  }

  if (typeof value === 'boolean') {
    return value;
  }

  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }

  return Boolean(fallback);
}

function resolveAuthMailSettings(settings = {}) {
  const smtpHost = trimString(settings.smtpHost);
  const smtpPort = Number(settings.smtpPort || 587) || 587;
  const smtpSecure = normalizeBoolean(settings.smtpSecure, smtpPort === 465);
  const smtpUsername = trimString(settings.smtpUsername);
  const encryptedPassword = trimString(settings.smtpPasswordEncrypted);
  const smtpPassword = encryptedPassword ? decrypt(encryptedPassword) : '';
  const smtpFromName =
    trimString(settings.smtpFromName || settings.siteName || 'Mail Union') || 'Mail Union';
  const smtpFromEmail = trimString(settings.smtpFromEmail);

  return {
    smtpHost,
    smtpPort,
    smtpSecure,
    smtpUsername,
    smtpPassword,
    smtpFromName,
    smtpFromEmail,
  };
}

function isAuthMailConfigured(settings = {}) {
  const resolved = resolveAuthMailSettings(settings);
  if (!resolved.smtpHost || !resolved.smtpFromEmail) {
    return false;
  }

  if (resolved.smtpUsername && !resolved.smtpPassword) {
    return false;
  }

  return true;
}

function createTransport(settings = {}) {
  const resolved = resolveAuthMailSettings(settings);

  if (!isAuthMailConfigured(settings)) {
    throw new Error('请先在系统设置里填写可用的 SMTP 发信配置。');
  }

  return nodemailer.createTransport({
    host: resolved.smtpHost,
    port: resolved.smtpPort,
    secure: resolved.smtpSecure,
    auth: resolved.smtpUsername
      ? {
          user: resolved.smtpUsername,
          pass: resolved.smtpPassword,
        }
      : undefined,
  });
}

function buildPurposeLabel(purpose) {
  return purpose === 'reset' ? '重置密码' : '注册验证';
}

function buildMailSubject(siteName, purpose) {
  return `${trimString(siteName || 'Mail Union')} ${buildPurposeLabel(purpose)}验证码`;
}

function buildMailText(siteName, purpose, code) {
  const label = buildPurposeLabel(purpose);
  return [
    `${trimString(siteName || 'Mail Union')} ${label}`,
    '',
    `本次${label}验证码：${trimString(code)}`,
    '验证码 10 分钟内有效，请勿泄露给他人。',
  ].join('\n');
}

function buildMailHtml(siteName, purpose, code) {
  const label = buildPurposeLabel(purpose);

  return `
    <div style="font-family:Segoe UI,Arial,PingFang SC,Microsoft YaHei,sans-serif;max-width:560px;margin:0 auto;padding:24px;background:#f6f8fb;color:#0f172a;">
      <div style="background:#ffffff;border:1px solid #dbe4ef;border-radius:20px;padding:28px 24px;box-shadow:0 18px 40px rgba(15,23,42,0.08);">
        <div style="font-size:12px;letter-spacing:0.16em;text-transform:uppercase;color:#64748b;font-weight:700;margin-bottom:12px;">${trimString(siteName || 'Mail Union')}</div>
        <h1 style="margin:0 0 12px;font-size:26px;line-height:1.15;">${label}验证码</h1>
        <p style="margin:0 0 18px;color:#475569;line-height:1.8;">你正在进行${label}操作，本次验证码如下：</p>
        <div style="display:inline-flex;align-items:center;justify-content:center;min-width:180px;height:60px;padding:0 24px;border-radius:18px;background:linear-gradient(135deg,#14b8a6,#2563eb);color:#ffffff;font-size:32px;font-weight:800;letter-spacing:0.18em;">
          ${trimString(code)}
        </div>
        <p style="margin:18px 0 0;color:#64748b;line-height:1.8;">验证码 10 分钟内有效，请勿泄露给他人。如果不是你本人操作，可以直接忽略这封邮件。</p>
      </div>
    </div>
  `;
}

async function sendAuthCodeMail(payload = {}, settings = {}) {
  const transport = createTransport(settings);
  const resolved = resolveAuthMailSettings(settings);

  await transport.sendMail({
    from: `"${resolved.smtpFromName}" <${resolved.smtpFromEmail}>`,
    to: trimString(payload.to),
    subject: buildMailSubject(settings.siteName, payload.purpose),
    text: buildMailText(settings.siteName, payload.purpose, payload.code),
    html: buildMailHtml(settings.siteName, payload.purpose, payload.code),
  });
}

async function verifyAuthMailConnection(settings = {}) {
  const transport = createTransport(settings);
  await transport.verify();
}

async function sendAuthMailTest(payload = {}, settings = {}) {
  const transport = createTransport(settings);
  const resolved = resolveAuthMailSettings(settings);
  const siteName = trimString(settings.siteName || 'Mail Union');

  await transport.verify();
  await transport.sendMail({
    from: `"${resolved.smtpFromName}" <${resolved.smtpFromEmail}>`,
    to: trimString(payload.to),
    subject: `${siteName} SMTP 测试邮件`,
    text: `${siteName} 的 SMTP 发信配置测试成功，这封邮件说明当前配置已经可以正常发送通知。`,
    html: `
      <div style="font-family:Segoe UI,Arial,PingFang SC,Microsoft YaHei,sans-serif;padding:24px;background:#f8fafc;color:#0f172a;">
        <div style="max-width:560px;margin:0 auto;padding:24px;border-radius:18px;border:1px solid #dbe4ef;background:#ffffff;box-shadow:0 18px 36px rgba(15,23,42,0.08);">
          <h2 style="margin:0 0 12px;">SMTP 测试成功</h2>
          <p style="margin:0;color:#475569;line-height:1.8;">这是一封系统测试邮件，说明当前 SMTP 配置已经可以正常发送注册验证码、找回密码邮件和后续通知。</p>
        </div>
      </div>
    `,
  });
}

module.exports = {
  isAuthMailConfigured,
  resolveAuthMailSettings,
  sendAuthCodeMail,
  sendAuthMailTest,
  verifyAuthMailConnection,
};
