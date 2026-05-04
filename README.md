# Mail Union

Mail Union 是一个自托管的多邮箱统一管理后台，可以把多个 Email 邮箱集中到一个系统里统一收信、阅读、翻译、通知、附件管理、备份和恢复。

## 功能特点

- 多邮箱统一管理，支持添加、测试、同步、排序和批量管理邮箱。
- 统一收件箱，集中查看所有邮箱邮件。
- 邮件详情支持 HTML 原文排版展示，尽量保持原邮箱阅读效果。
- 完整邮件落地页支持加密链接访问，不登录也能查看指定邮件内容。
- 支持一键翻译邮件，默认使用 Google 翻译引擎。
- 支持 Telegram、企业微信机器人、企业微信应用、飞书通知。
- 通知默认发送摘要，点击链接查看完整邮件。
- 通知支持普通模式和封面模式。
- 内置普通邮件、验证码邮件、垃圾邮件、广告邮件、订单通知、订阅提醒封面。
- 支持附件本地同步、分页查看、预览、下载、打开和批量删除。
- 支持系统备份和还原，可备份数据库、网站数据或全部数据。
- 支持用户管理、管理员权限、后台登录有效期设置。
- 默认运行端口为 `52080`。

## 技术栈

- Node.js 22+
- `node:sqlite`
- `imapflow`
- `mailparser`
- 原生 HTML / CSS / JavaScript

## 一键安装部署

### Linux 服务器

在 Ubuntu / Debian / CentOS / Rocky / AlmaLinux 等常见服务器上执行：

```bash
curl -fsSL https://raw.githubusercontent.com/lening5202/MailUnion/main/scripts/install-linux.sh | sudo bash
```

脚本会自动完成：

- 检测并安装 Node.js 22+
- 下载 GitHub 最新代码
- 安装 npm 依赖
- 生成 `.env` 并自动写入随机 `APP_SECRET`
- 创建运行目录 `data`、`runtime/files`、`logs`
- 创建 systemd 服务并设置开机自启
- 启动服务并监听 `52080`
- 尝试放行服务器防火墙端口

自定义安装目录或端口：

```bash
curl -fsSL https://raw.githubusercontent.com/lening5202/MailUnion/main/scripts/install-linux.sh | sudo MAILUNION_INSTALL_DIR=/opt/mailunion PORT=52080 bash
```

服务管理：

```bash
sudo systemctl status mailunion
sudo systemctl restart mailunion
sudo journalctl -u mailunion -f
```

### Windows

用管理员 PowerShell 执行：

```powershell
iwr -UseBasicParsing https://raw.githubusercontent.com/lening5202/MailUnion/main/scripts/install-windows.ps1 | iex
```

脚本会自动完成：

- 检测并通过 winget 安装 Node.js LTS
- 下载 GitHub 最新代码
- 安装 npm 依赖
- 生成 `.env` 并自动写入随机 `APP_SECRET`
- 创建 Windows 计划任务开机自启
- 启动服务并监听 `52080`
- 尝试添加 Windows 防火墙入站规则

自定义安装目录或端口：

```powershell
iwr -UseBasicParsing https://raw.githubusercontent.com/lening5202/MailUnion/main/scripts/install-windows.ps1 -OutFile install-windows.ps1
.\install-windows.ps1 -InstallDir "D:\MailUnion" -Port 52080
```

## 手动启动

```bash
npm install
npm start
```

启动后访问：

[http://localhost:52080](http://localhost:52080)

## 默认管理员账号

初始账号：

- 用户名：`admin`
- 密码：`admin`

首次部署到公网前，建议登录后台后立即修改管理员密码，并设置新的 `APP_SECRET`。

## 环境变量

可以复制 `.env.example` 为 `.env` 后按需修改：

```powershell
Copy-Item .env.example .env
```

常用配置：

- `PORT`：默认 `52080`
- `APP_SECRET`：应用加密密钥，正式部署必须修改
- `SYNC_INTERVAL_MS`：后台同步轮询间隔
- `INITIAL_SYNC_LIMIT`：首次同步邮件数量限制
- `SESSION_TTL_DAYS`：默认登录有效期
- `ADMIN_USERNAME`：初始化管理员用户名
- `ADMIN_PASSWORD`：初始化管理员密码

## 开源发布说明

仓库默认不包含真实数据库、运行日志、附件、备份包和 `.env` 文件。系统首次启动时会自动创建默认管理员账号。
