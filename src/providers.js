const PROVIDER_PRESETS = [
  {
    id: 'gmail',
    label: 'Gmail',
    imapHost: 'imap.gmail.com',
    imapPort: 993,
    secure: true,
    note: 'Gmail 仍支持 IMAP，但普通账号密码通常会被拦截。个人账号可用应用专用密码，更推荐直接使用 Google OAuth2 授权接入。',
  },
  {
    id: 'outlook',
    label: 'Outlook / Microsoft 365',
    imapHost: 'outlook.office365.com',
    imapPort: 993,
    secure: true,
    note: '更推荐使用 Microsoft OAuth2 / Modern Auth；Outlook.com 还需要先在网页版设置中开启 IMAP 访问。',
  },
  {
    id: 'qq',
    label: 'QQ 邮箱',
    imapHost: 'imap.qq.com',
    imapPort: 993,
    secure: true,
    note: '需要在网页版邮箱设置里开启 IMAP，并生成授权码。',
  },
  {
    id: 'netease163',
    label: '163 邮箱',
    imapHost: 'imap.163.com',
    imapPort: 993,
    secure: true,
    note: '需要先在邮箱设置中开启 IMAP，并使用客户端授权码。',
  },
  {
    id: 'aliyun',
    label: '阿里邮箱',
    imapHost: 'imap.aliyun.com',
    imapPort: 993,
    secure: true,
    note: '企业邮箱通常默认支持 IMAP，如被禁用需由管理员开启。',
  },
  {
    id: 'generic',
    label: '通用 IMAP',
    imapHost: '',
    imapPort: 993,
    secure: true,
    note: '适用于自建邮件服务器或其他支持 IMAP 的邮箱。',
  },
];

const PROVIDER_PRESET_MAP = Object.fromEntries(
  PROVIDER_PRESETS.map((provider) => [provider.id, provider]),
);

module.exports = {
  PROVIDER_PRESETS,
  PROVIDER_PRESET_MAP,
};
