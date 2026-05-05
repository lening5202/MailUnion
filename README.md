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

### 新手推荐：Docker 安装

推荐优先使用 Docker 方式部署。Docker 会把程序和运行环境打包在一起，后续迁移、升级、重启都更简单。系统数据默认保存在服务器的 `/opt/mailunion-docker`，容器重建不会删除数据库和附件。

在服务器 SSH 终端里复制下面命令执行：

```bash
curl -fsSL https://raw.githubusercontent.com/lening5202/MailUnion/main/scripts/install-docker.sh | sudo MAILUNION_BUILD_FROM_SOURCE=1 bash
```

这条命令每一段的意思：

| 命令片段 | 作用 |
| --- | --- |
| `curl` | 从网上下载安装脚本。 |
| `-fsSL` | 安静下载，失败时直接报错，并自动跟随跳转链接。 |
| `https://raw.githubusercontent.com/.../install-docker.sh` | Mail Union 的 Docker 安装脚本地址。 |
| `|` | 管道符，把前面下载到的脚本交给后面的 `bash` 执行。 |
| `sudo` | 用管理员权限执行安装，因为安装 Docker、创建目录、启动服务都需要权限。 |
| `MAILUNION_BUILD_FROM_SOURCE=1` | 强制从 GitHub 源码在服务器本机构建镜像，适合第一次部署，避免镜像仓库权限或未发布导致失败。 |
| `bash` | 使用 Linux 的 Bash 解释器运行脚本。 |

脚本会自动完成这些事：

| 自动操作 | 说明 |
| --- | --- |
| 检测 Docker | 如果服务器没有 Docker，会尝试自动安装 Docker 和 Docker Compose 插件。 |
| 创建部署目录 | 默认创建 `/opt/mailunion-docker`，系统数据、附件、日志都会放在这里。 |
| 生成配置文件 | 自动创建 `.env`，并生成随机 `APP_SECRET`。 |
| 下载源码 | 从 GitHub 下载 Mail Union 最新代码。 |
| 构建镜像 | 在服务器本机执行 Docker 构建。 |
| 启动容器 | 启动 `mailunion` 容器，并设置 Docker 自动重启。 |
| 监听端口 | 默认监听 `52080` 端口。 |

安装完成后访问：

```text
http://服务器公网IP:52080
```

默认后台账号：

| 项目 | 默认值 |
| --- | --- |
| 用户名 | `admin` |
| 密码 | `admin` |

首次登录后建议立刻修改后台密码。

### Docker 自动模式

如果后续 Docker 镜像已经公开发布，也可以使用自动模式。自动模式会优先拉取镜像，拉不到时再自动切换到源码构建：

```bash
curl -fsSL https://raw.githubusercontent.com/lening5202/MailUnion/main/scripts/install-docker.sh | sudo bash
```

这条命令和推荐命令的区别：

| 命令 | 适合场景 |
| --- | --- |
| `MAILUNION_BUILD_FROM_SOURCE=1 bash` | 最稳，直接源码构建，适合第一次部署和镜像拉取失败时使用。 |
| `bash` | 自动模式，适合 Docker 镜像已经发布并公开后使用。 |

### 自定义 Docker 安装参数

如果你想修改安装目录、端口或镜像，可以使用下面命令：

```bash
curl -fsSL https://raw.githubusercontent.com/lening5202/MailUnion/main/scripts/install-docker.sh | sudo MAILUNION_DOCKER_DIR=/opt/mailunion-docker PORT=52080 MAILUNION_IMAGE=ghcr.io/lening5202/mailunion:latest bash
```

参数说明：

| 参数 | 作用 |
| --- | --- |
| `MAILUNION_DOCKER_DIR=/opt/mailunion-docker` | Docker 版安装目录，数据库、附件、日志都会保存在这里。 |
| `PORT=52080` | 对外访问端口，Mail Union 默认永久使用 `52080`。 |
| `MAILUNION_IMAGE=ghcr.io/lening5202/mailunion:latest` | 指定要拉取或构建的 Docker 镜像名称。 |

### Docker 常用管理命令

先进入部署目录：

```bash
cd /opt/mailunion-docker
```

这条命令的意思：

| 命令片段 | 作用 |
| --- | --- |
| `cd` | 切换目录。 |
| `/opt/mailunion-docker` | Mail Union Docker 版默认安装目录。 |

查看容器是否正在运行：

```bash
sudo docker compose ps
```

| 命令片段 | 作用 |
| --- | --- |
| `sudo` | 用管理员权限执行 Docker 命令。 |
| `docker compose` | 使用 Docker Compose 管理本项目容器。 |
| `ps` | 查看容器状态。看到 `running` 或 `healthy` 一般代表正在运行。 |

查看实时日志：

```bash
sudo docker compose logs -f
```

| 命令片段 | 作用 |
| --- | --- |
| `logs` | 查看容器日志。 |
| `-f` | 持续跟随输出新日志，排查启动失败时很有用。 |

重启服务：

```bash
sudo docker compose restart
```

| 命令片段 | 作用 |
| --- | --- |
| `restart` | 重启 Mail Union 容器。修改配置后常用。 |

更新并重新启动：

```bash
sudo docker compose pull
sudo docker compose up -d
```

| 命令 | 作用 |
| --- | --- |
| `sudo docker compose pull` | 拉取最新 Docker 镜像。 |
| `sudo docker compose up -d` | 后台启动或更新容器。`-d` 表示后台运行，不占用当前终端。 |

停止服务：

```bash
sudo docker compose down
```

| 命令片段 | 作用 |
| --- | --- |
| `down` | 停止并删除容器，但不会删除默认挂载的数据目录。 |

### Docker 常见问题

如果出现 `denied`：

```text
Error response from daemon: error from registry: denied
```

原因通常是 Docker 镜像包还没有发布，或者 GitHub Container Registry 的 Package 没有设置为 Public。解决办法是强制源码构建：

```bash
curl -fsSL https://raw.githubusercontent.com/lening5202/MailUnion/main/scripts/install-docker.sh | sudo MAILUNION_BUILD_FROM_SOURCE=1 bash
```

如果安装中断后想重新安装：

```bash
cd /opt/mailunion-docker
sudo docker compose down
cd ~
curl -fsSL https://raw.githubusercontent.com/lening5202/MailUnion/main/scripts/install-docker.sh | sudo MAILUNION_BUILD_FROM_SOURCE=1 bash
```

这些命令的意思：

| 命令 | 作用 |
| --- | --- |
| `cd /opt/mailunion-docker` | 进入 Mail Union Docker 部署目录。 |
| `sudo docker compose down` | 停止上一次失败或旧的容器。 |
| `cd ~` | 回到当前用户的家目录。 |
| `curl ... MAILUNION_BUILD_FROM_SOURCE=1 bash` | 重新下载最新安装脚本，并从 GitHub 源码构建安装。 |

如果浏览器打不开 `http://服务器公网IP:52080`：

| 检查项 | 说明 |
| --- | --- |
| 服务器安全组 | 云服务器控制台需要放行 TCP `52080`。 |
| 系统防火墙 | 服务器本机防火墙也需要允许 TCP `52080`。 |
| 容器状态 | 执行 `cd /opt/mailunion-docker && sudo docker compose ps` 查看是否运行。 |
| 启动日志 | 执行 `cd /opt/mailunion-docker && sudo docker compose logs -f` 查看报错。 |

### Linux 服务器原生安装

如果你不想用 Docker，也可以使用原生安装。原生安装会直接在系统里安装 Node.js、下载代码并创建 systemd 服务。

在 Ubuntu / Debian / CentOS / Rocky / AlmaLinux 等服务器执行：

```bash
curl -fsSL https://raw.githubusercontent.com/lening5202/MailUnion/main/scripts/install-linux.sh | sudo bash
```

这条命令每一段的意思：

| 命令片段 | 作用 |
| --- | --- |
| `curl -fsSL` | 下载 Linux 原生安装脚本。 |
| `install-linux.sh` | 原生安装脚本，会安装 Node.js、下载源码、配置 systemd。 |
| `| sudo bash` | 用管理员权限执行脚本。 |

脚本会自动完成：

| 自动操作 | 说明 |
| --- | --- |
| 安装 Node.js | 检测并安装 Node.js 22+。 |
| 下载代码 | 从 GitHub 下载最新 Mail Union 源码。 |
| 安装依赖 | 执行 npm 依赖安装。 |
| 创建 `.env` | 自动生成运行配置和随机 `APP_SECRET`。 |
| 创建 systemd 服务 | 服务名默认是 `mailunion`。 |
| 设置开机自启 | 服务器重启后自动启动 Mail Union。 |
| 监听端口 | 默认监听 `52080`。 |

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
```

| 命令片段 | 作用 |
| --- | --- |
| `systemctl` | Linux 系统服务管理工具。 |
| `status mailunion` | 查看 Mail Union 服务状态。 |

```bash
sudo systemctl restart mailunion
```

| 命令片段 | 作用 |
| --- | --- |
| `restart mailunion` | 重启 Mail Union 服务。 |

```bash
sudo journalctl -u mailunion -f
```

| 命令片段 | 作用 |
| --- | --- |
| `journalctl` | 查看 systemd 服务日志。 |
| `-u mailunion` | 只看 Mail Union 这个服务的日志。 |
| `-f` | 持续跟随最新日志。 |

### Windows 安装

请用管理员身份打开 PowerShell，然后执行：

```powershell
iwr -UseBasicParsing https://raw.githubusercontent.com/lening5202/MailUnion/main/scripts/install-windows.ps1 | iex
```

这条命令每一段的意思：

| 命令片段 | 作用 |
| --- | --- |
| `iwr` | PowerShell 里的 `Invoke-WebRequest` 简写，用来下载脚本。 |
| `-UseBasicParsing` | 使用基础解析方式下载内容，兼容性更好。 |
| `install-windows.ps1` | Windows 一键安装脚本。 |
| `| iex` | 把下载到的脚本交给 `Invoke-Expression` 执行。 |

脚本会自动完成：

| 自动操作 | 说明 |
| --- | --- |
| 安装 Node.js | 检测并通过 winget 安装 Node.js LTS。 |
| 下载代码 | 下载 GitHub 最新代码。 |
| 安装依赖 | 安装 npm 依赖。 |
| 生成 `.env` | 创建运行配置和随机 `APP_SECRET`。 |
| 设置开机自启 | 创建 Windows 计划任务。 |
| 放行防火墙 | 尝试添加 Windows 防火墙入站规则。 |
| 启动服务 | 启动后监听 `52080`。 |

如果想自定义安装目录或端口，可以先下载脚本再执行：

```powershell
iwr -UseBasicParsing https://raw.githubusercontent.com/lening5202/MailUnion/main/scripts/install-windows.ps1 -OutFile install-windows.ps1
.\install-windows.ps1 -InstallDir "D:\MailUnion" -Port 52080
```

命令说明：

| 命令 | 作用 |
| --- | --- |
| `-OutFile install-windows.ps1` | 把远程安装脚本保存成本地文件。 |
| `.\install-windows.ps1` | 执行当前目录下的安装脚本。 |
| `-InstallDir "D:\MailUnion"` | 指定安装目录。 |
| `-Port 52080` | 指定运行端口。 |

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

## 上传 Docker 仓库

推荐优先使用 GitHub Container Registry，和 GitHub 仓库绑定，后续每次推送 `main` 分支都会通过 GitHub Actions 自动构建镜像：

1. 把 GitHub 仓库设置为 Public。
2. 推送代码到 GitHub。
3. 打开 GitHub 仓库的 Actions，确认 `Docker Image` 工作流执行成功。
4. 镜像地址为 `ghcr.io/lening5202/mailunion:latest`。

也可以手动发布到 Docker Hub。先在 Docker Hub 创建仓库，例如 `你的DockerHub用户名/mailunion`，然后执行：

```bash
docker login
docker buildx create --use
docker buildx build --platform linux/amd64,linux/arm64 -t 你的DockerHub用户名/mailunion:latest --push .
```

发布后，服务器一条命令安装 Docker Hub 镜像：

```bash
curl -fsSL https://raw.githubusercontent.com/lening5202/MailUnion/main/scripts/install-docker.sh | sudo MAILUNION_IMAGE=你的DockerHub用户名/mailunion:latest bash
```

Windows 本地推送也可以使用内置脚本：

```powershell
.\scripts\docker-publish.ps1 -Image 你的DockerHub用户名/mailunion:latest
```

Linux / macOS 本地推送：

```bash
bash scripts/docker-publish.sh 你的DockerHub用户名/mailunion:latest
```

## 开发和发布目录规则

本项目本地开发固定使用以下目录规则：

- 开发目录：`C:\Users\Administrator\Desktop\开发\MailUnion`
- 轮转备份目录：`C:\Users\Administrator\Desktop\开发\backup`
- GitHub 发布目录：`C:\Users\Administrator\Desktop\开发\github\MailUnion`

备份规则为 `MailUnion1` 到 `MailUnion6`，其中 `MailUnion1` 是最新备份，超过 6 份自动覆盖最旧备份：

```powershell
.\scripts\backup-rotate.ps1
```

同步 GitHub 发布版会覆盖 `github\MailUnion` 目录，但会保留该目录内的 `.git`，并自动排除 `.env`、真实数据库、附件、日志、运行缓存和 `node_modules`：

```powershell
.\scripts\sync-github-release.ps1
```

## 开源发布说明

仓库默认不包含真实数据库、运行日志、附件、备份包和 `.env` 文件。系统首次启动时会自动创建默认管理员账号。
