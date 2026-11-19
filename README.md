# AI 超级应用（AI Super App）

一个跑在 Cloudflare 免费套餐上的个人 AI 助手网页应用：对话里直接记账、加待办、存长期记忆、建多步任务，还可以接自己的大模型 API key 做自由聊天问答。带用户注册/登录，数据存 Cloudflare D1 并按用户隔离，刷新不丢。

在线演示：https://ai-super-app.jeffreyning.workers.dev/ （需注册账号使用，演示站请勿填入隐私信息）

## 功能

- 用户注册/登录：用户名 + 密码（PBKDF2 加盐哈希存储），会话 cookie 30 天；每个账号的对话、待办、账本、记忆、任务和模型设置互相隔离。第一个注册的账号会继承部署前已有的无主数据

- 对话助手：规则识别四类指令并直接执行
  - 记账：「午餐花了32元」→ 存进账本
  - 待办：「待办：交水电费」→ 加进待办
  - 长期记忆：「记住：我的生日是1月1日」→ 存进记忆，之后问答时模型能引用
  - 任务：「任务：筹备新店开业」→ 自动拆成 4 步放进任务区
- 大模型聊天：在页面「模型设置」里选服务商、填 API key，四类指令之外的对话自动走大模型回复，并带上最近对话、待办、支出合计和长期记忆作上下文。内置 9 家预设，覆盖三种协议：
  - OpenAI 兼容：DeepSeek、通义千问、智谱 GLM、Kimi、硅基流动、OpenAI、OpenRouter，另可自定义任意兼容接口
  - Claude 原生接口（Anthropic）
  - Gemini 原生接口（Google）
- 四块面板：待办、账本、长期记忆、多步任务，都能手动增删
- 无构建、无框架：一个 HTML 文件 + 一个接口文件

## 部署（Cloudflare 免费套餐即可）

前置：一个 Cloudflare 账号。Pages 免费不限流量，Workers 免费 10 万次请求/天，D1 免费 5GB。

### 方式一：Pages + Functions（推荐）

```bash
npm i -g wrangler
wrangler login
wrangler d1 create ai-super-app-db
# 把返回的 database_id 填进 wrangler.toml
wrangler d1 execute ai-super-app-db --remote --file schema.sql
wrangler pages deploy public --project-name ai-super-app
```

Functions 在 `functions/` 目录会随 Pages 一起部署，D1 绑定名 `DB` 见 `wrangler.toml`。

### 方式二：单个 Worker

```bash
wrangler d1 create ai-super-app-db
wrangler d1 execute ai-super-app-db --remote --file schema.sql
node build-worker.mjs   # 生成 worker.js（页面内嵌 + 接口合并）
# 用 wrangler 或 Cloudflare 控制台/API 上传 worker.js，并给它绑定 D1（绑定名 DB）
```

## 配置大模型

部署完成后打开页面，在右侧「模型设置」里选服务商，接口地址和默认模型会自动填好，把 API key 粘进去保存即可（每个预设下方都写了 key 的申请地址）。key 只存在你自己的 D1 里，接口返回时只露尾号 4 位。想换模型，把模型名改成该服务商的任意模型即可；想接预设之外的 OpenAI 兼容服务，选「自定义」。

## 注意

- 登录只做基础防护：密码 PBKDF2 哈希、会话令牌只存哈希、cookie 为 HttpOnly。没有找回密码、没有验证码，公网部署时请用强密码，并清楚任何拿到你密码的人都能看到你的数据。
- API key 明文存在 D1 的 settings 表里（按用户隔离）。介意的话可以改用 Worker Secret 注入，自行调整 `getSettings` 的读取方式。
- 老版本升级：先在 D1 执行一次 `migration-auth.sql`，再部署新代码。

## 结构

```text
public/index.html        前端页面（原生 HTML/CSS/JS，含登录界面）
functions/api/[action].js  接口：注册/登录、对话、待办、账本、记忆、任务、模型设置
schema.sql               D1 建表脚本（9 张表，全新安装用）
migration-auth.sql       老库升级到带登录版本的迁移脚本
wrangler.toml            Pages 与 D1 绑定配置
build-worker.mjs         把页面和接口打包成单个 Worker 的脚本
```

## License

MIT
