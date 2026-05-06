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

### Docker 安装

推荐优先使用 Docker 方式部署。Docker 会把程序和运行环境打包在一起，后续迁移、升级、重启都更简单。系统数据默认保存在服务器的 `/opt/mailunion-docker`，容器重建不会删除数据库和附件。

推荐使用 Docker Hub 镜像安装：

```bash
curl -fsSL https://raw.githubusercontent.com/lening5202/MailUnion/main/scripts/install-docker.sh | sudo bash
```

该命令会自动检测并安装 Docker，优先拉取 `lening5202/mailunion:latest` 镜像，生成 `.env`，启动服务，并监听 `52080` 端口。如果镜像暂时拉取失败，脚本会自动切换为源码构建安装。

安装完成后访问：

```text
http://服务器公网IP:52080
```

如果你想强制从 GitHub 源码构建，可以执行：

```bash
curl -fsSL https://raw.githubusercontent.com/lening5202/MailUnion/main/scripts/install-docker.sh | sudo MAILUNION_BUILD_FROM_SOURCE=1 bash
```

### 自定义 Docker 安装

修改安装目录、端口或镜像：

```bash
curl -fsSL https://raw.githubusercontent.com/lening5202/MailUnion/main/scripts/install-docker.sh | sudo MAILUNION_DOCKER_DIR=/opt/mailunion-docker PORT=52080 MAILUNION_IMAGE=lening5202/mailunion:latest bash
```

参数说明：

| 参数 | 作用 |
| --- | --- |
| `MAILUNION_DOCKER_DIR=/opt/mailunion-docker` | Docker 版安装目录，数据库、附件、日志都会保存在这里。 |
| `PORT=52080` | 对外访问端口，Mail Union 默认永久使用 `52080`。 |
| `MAILUNION_IMAGE=lening5202/mailunion:latest` | 指定要拉取或构建的 Docker 镜像名称。 |

### Docker 常用管理命令

```bash
cd /opt/mailunion-docker
```

查看容器状态：

```bash
sudo docker compose ps
```

查看实时日志：

```bash
sudo docker compose logs -f
```

重启服务：

```bash
sudo docker compose restart
```

更新并启动：

```bash
sudo docker compose pull
sudo docker compose up -d
```

停止服务：

```bash
sudo docker compose down
```

### 常见问题

如果出现 `denied`：

```text
Error response from daemon: error from registry: denied
```

原因通常是 Docker 镜像还没有发布成功，或者镜像仓库暂时无法访问。解决办法是强制源码构建：

```bash
curl -fsSL https://raw.githubusercontent.com/lening5202/MailUnion/main/scripts/install-docker.sh | sudo MAILUNION_BUILD_FROM_SOURCE=1 bash
```

安装中断后可以先停止旧容器再重新执行：

```bash
cd /opt/mailunion-docker
sudo docker compose down
cd ~
curl -fsSL https://raw.githubusercontent.com/lening5202/MailUnion/main/scripts/install-docker.sh | sudo MAILUNION_BUILD_FROM_SOURCE=1 bash
```

如果浏览器打不开 `http://服务器公网IP:52080`：

| 检查项 | 说明 |
| --- | --- |
| 服务器安全组 | 云服务器控制台需要放行 TCP `52080`。 |
| 系统防火墙 | 服务器本机防火墙也需要允许 TCP `52080`。 |
| 容器状态 | 执行 `cd /opt/mailunion-docker && sudo docker compose ps` 查看是否运行。 |
| 启动日志 | 执行 `cd /opt/mailunion-docker && sudo docker compose logs -f` 查看报错。 |

### Linux 服务器原生安装

如果不想使用 Docker，也可以使用原生安装。原生安装会直接在系统里安装 Node.js、下载代码并创建 systemd 服务。

执行：

```bash
curl -fsSL https://raw.githubusercontent.com/lening5202/MailUnion/main/scripts/install-linux.sh | sudo bash
```

自定义目录或端口：

```bash
curl -fsSL https://raw.githubusercontent.com/lening5202/MailUnion/main/scripts/install-linux.sh | sudo MAILUNION_INSTALL_DIR=/opt/mailunion PORT=52080 bash
```

参数说明：

| 参数 | 作用 |
| --- | --- |
| `MAILUNION_INSTALL_DIR=/opt/mailunion` | 原生安装目录。 |
| `PORT=52080` | 对外访问端口。 |

原生安装的服务管理命令：

```bash
sudo systemctl status mailunion
sudo systemctl restart mailunion
sudo journalctl -u mailunion -f
```

### Windows 安装

请用管理员身份打开 PowerShell，然后执行：

```powershell
iwr -UseBasicParsing https://raw.githubusercontent.com/lening5202/MailUnion/main/scripts/install-windows.ps1 | iex
```

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
