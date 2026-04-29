# Midscene.js 项目指南

> **开发规范**: 请遵循 [AGENTS.md](./AGENTS.md) 中的开发指南和提交规范。

## 项目概述

Midscene.js 是一个 AI 驱动的视觉 UI 自动化工具，核心特性：
- **纯视觉定位**: 基于截图和 AI 理解元素，无需传统选择器
- **自然语言编程**: 用自然语言描述操作意图，AI 自动执行
- **跨平台支持**: Web、Android、iOS、Desktop、HarmonyOS
- **MCP 协议**: 暴露原子操作作为 MCP 工具

**版本**: 1.7.6 | **许可证**: MIT | **官网**: https://midscenejs.com/

## 架构设计

```
┌──────────────────────────────────────────────────────────────┐
│                      应用层 (Application)                     │
│   CLI  │  Playground  │  Chrome Extension  │  Visualizer    │
├──────────────────────────────────────────────────────────────┤
│                       Agent 层 (API)                          │
│   aiAct()  │  aiQuery()  │  aiAssert()  │  aiLocate()        │
├──────────────────────────────────────────────────────────────┤
│                       服务层 (Service)                         │
│   TaskExecutor  │  TaskCache  │  ExecutionSession            │
├──────────────────────────────────────────────────────────────┤
│                       AI 层 (Intelligence)                    │
│   Prompt Engineering  │  LLM Caller  │  Model Config Manager │
├──────────────────────────────────────────────────────────────┤
│                      设备抽象层 (Device)                       │
│   AbstractInterface  │  MouseAction  │  KeyboardAction        │
├──────────────────────────────────────────────────────────────┤
│                      平台实现层 (Platform)                     │
│    Web    │   Android   │    iOS    │   Computer   │ Harmony │
└──────────────────────────────────────────────────────────────┘
```

## 代码结构

```
packages/
├── core/                    # 核心引擎
│   ├── src/agent/           # Agent 类 (agent.ts, tasks.ts, task-cache.ts)
│   ├── src/ai-model/        # AI 模型集成 (prompt/, service-caller/)
│   ├── src/device/          # 设备抽象层
│   ├── src/task-runner.ts   # 任务执行器
│   └── src/yaml/            # YAML 脚本处理
│
├── shared/                  # 共享工具库 (图像处理、MCP、日志)
├── web-integration/         # Web 平台集成 (Playwright/Puppeteer)
├── android/                 # Android 自动化 (ADB, scrcpy)
├── ios/                     # iOS 自动化 (WebDriverAgent)
├── computer/                 # 桌面自动化 (libnut)
├── harmony/                  # 鸿蒙系统支持
├── cli/                      # 命令行工具
├── webdriver/                # WebDriver 协议
└── mcp/                      # MCP 核心

apps/
├── chrome-extension/         # Chrome 扩展 (录制器、桥接)
└── *-playground/             # 各平台演示应用
```

## 核心模块

### @midscene/core
核心 AI 自动化引擎，包含 Agent 类、任务执行器、提示工程、设备抽象。

### @midscene/web
Playwright/Puppeteer 集成，提供 `PlaywrightAgent` 和 `PuppeteerAgent`。

### @midscene/cli
命令行工具，运行 YAML 脚本：`midscene ./script.yaml`

### 平台包
| 包 | 平台 | 依赖技术 |
|---|------|---------|
| @midscene/android | Android | ADB, scrcpy |
| @midscene/ios | iOS | WebDriverAgent |
| @midscene/computer | Desktop | libnut |
| @midscene/harmony | HarmonyOS | hdc |

## 包间依赖

```
shared (基础工具)
    ↓
core (核心引擎)
    ↓
┌───┼───┬───────────┐
web cli android ios computer
```

关键外部依赖：puppeteer, playwright, openai, @modelcontextprotocol/sdk, zod, sharp

## API 使用

```typescript
import { PlaywrightAgent } from '@midscene/web/playwright';

const agent = new PlaywrightAgent(page);

// 交互
await agent.aiAct('在搜索框输入 "耳机" 并点击搜索');
await agent.aiTap('登录按钮');
await agent.aiInput('test@example.com', '邮箱输入框');

// 数据提取
const items = await agent.aiQuery('{name: string, price: number}[]');

// 断言
await agent.aiAssert('搜索结果不为空');
await agent.aiWaitFor('页面加载完成');

// 元素定位
const element = await agent.aiLocate('搜索按钮');
```

## YAML 脚本

```yaml
web:
  url: https://example.com

tasks:
  - name: 登录
    flow:
      - ai: 点击登录按钮
      - ai: 输入用户名 "test@example.com"
      - aiWaitFor: 登录成功
```

运行：`midscene ./script.yaml`

## 环境配置

```bash
# 必填 - 模型配置
MIDSCENE_MODEL_API_KEY="your-api-key"
MIDSCENE_MODEL_BASE_URL="https://api.openai.com/v1"
MIDSCENE_MODEL_NAME="gpt-4o"
MIDSCENE_MODEL_FAMILY="qwen2.5-vl"  # 根据模型选择正确的 family

# 可选
MIDSCENE_MODEL_TIMEOUT=180000
MIDSCENE_MODEL_RETRY_COUNT=1
MIDSCENE_RUN_DIR="./midscene_run"

# Android 开发需要
ANDROID_HOME="D:/AndroidSDK"
ANDROID_SDK_ROOT="D:/AndroidSDK"

# 调试
DEBUG=midscene:*              # 所有日志
DEBUG=midscene:ai:call        # AI 调用详情
```

### MIDSCENE_MODEL_FAMILY 支持值

| Model Family | 说明 | 示例模型 |
|-------------|------|---------|
| `glm-v` | 智谱 GLM 视觉模型 | glm-4v, glm-4.6v |
| `auto-glm` | 智谱 Auto-GLM | auto-glm |
| `auto-glm-multilingual` | 智谱多语言版 | auto-glm-multilingual |
| `qwen2.5-vl` | 通义千问 2.5 VL | qwen2.5-vl |
| `qwen3-vl` | 通义千问 3 VL | qwen3-vl |
| `qwen3.5` | 通义千问 3.5 | qwen3.5 |
| `qwen3.6` | 通义千问 3.6 | qwen3.6 |
| `doubao-vision` | 豆包视觉模型 | doubao-vision |
| `doubao-seed` | 豆包 Seed 模型 | doubao-seed |
| `gemini` | Google Gemini | gemini-1.5-pro |
| `gpt-5` | OpenAI GPT-5 | gpt-5 |
| `vlm-ui-tars` | UI-Tars 模型 | vlm-ui-tars |

> ⚠️ **重要**: `MIDSCENE_MODEL_FAMILY` 决定坐标系统和提示格式，必须与模型匹配，否则会报错或执行失败。

## 本地开发

```bash
# 环境: Node >= 18.19.0, pnpm >= 9.3.0
pnpm install           # 安装依赖
pnpm build             # 构建所有包
pnpm dev               # watch 模式
pnpm test              # 运行测试
pnpm run lint          # 代码检查 (提交前必跑)

# 单包开发
cd packages/core && pnpm build && pnpm test

# 运行 AI 测试 (需要设置环境变量)
MIDSCENE_MODEL_BASE_URL=... pnpm test
```

## 调试技巧

```bash
# 可视化模式
midscene ./script.yaml --headed --keep-window

# 查看详细日志
DEBUG=midscene:* midscene ./script.yaml

# 性能统计
DEBUG=midscene:ai:profile:stats midscene ./script.yaml
```

## 提交规范

遵循 Conventional Commits，scope 取自 `apps/` 和 `packages/` 目录名：
- `feat(core): add new action type`
- `fix(web-integration): resolve element定位问题`
- `docs(site): update installation guide`

提交前必须运行：`pnpm run lint`

## 文档规范

- README.md 和 README.zh.md 需同步更新
- 英文文档 (`apps/site/docs/en/**`) 和中文文档 (`apps/site/docs/zh/**`) 需对照更新
- 参见 `apps/site/agents.md` 了解术语规则

---

**详细开发指南**: 参见 [AGENTS.md](./AGENTS.md)
**贡献指南**: 参见 [CONTRIBUTING.md](./CONTRIBUTING.md)

## 配置踩坑总结

### 1. 网络代理问题

从 GitHub 下载依赖文件（scrcpy-server, yadb）可能需要代理：

```bash
# 使用 SOCKS5 代理下载
curl -x socks5://127.0.0.1:1080 -L -o scrcpy-server https://github.com/...
```

### 2. Android SDK 环境变量

Playground 启动时必须设置 `ANDROID_HOME` 和 `ANDROID_SDK_ROOT`：

```bash
export ANDROID_HOME="D:/AndroidSDK"
export ANDROID_SDK_ROOT="D:/AndroidSDK"
```

否则会报错：`Neither ANDROID_HOME nor ANDROID_SDK_ROOT environment variable was exported`

### 3. Git Bash 路径转换问题

在 Git Bash 中使用 adb push 时，`/data/local/tmp` 会被错误转换为 Windows 路径：

```bash
# ❌ 错误 - 路径被转换
adb push scrcpy-server /data/local/tmp/scrcpy-server

# ✅ 正确 - 使用双斜杠避免转换
adb push scrcpy-server //data/local/tmp/scrcpy-server
```

### 4. MIDSCENE_MODEL_FAMILY 配置错误

不同模型有不同的坐标系统和提示格式，必须选择正确的 family：

```
❌ 错误: Invalid MIDSCENE_MODEL_FAMILY value: qwen
```

智谱 GLM 模型应使用 `glm-v`，而非 `qwen`。

### 5. Playground 前端静态文件

Android Playground 的前端需要单独构建：

```bash
# 构建前端应用
cd apps/android-playground && pnpm build

# 静态文件会自动复制到 packages/android-playground/static/
```

### 6. Playground 启动命令

启动 Playground 需要同时设置 Android SDK 和 AI 模型环境变量：

```bash
export ANDROID_HOME="D:/AndroidSDK" && \
export ANDROID_SDK_ROOT="D:/AndroidSDK" && \
export MIDSCENE_MODEL_API_KEY="your-key" && \
export MIDSCENE_MODEL_BASE_URL="https://open.bigmodel.cn/api/paas/v4/" && \
export MIDSCENE_MODEL_NAME="glm-4.6v" && \
export MIDSCENE_MODEL_FAMILY="glm-v" && \
cd packages/android-playground && node ./bin/android-playground
```

### 7. scrcpy 预览超时

如果 scrcpy 预览启动失败，可能需要手动推送 scrcpy-server 到设备：

```bash
# 推送 scrcpy server
adb push packages/android/bin/scrcpy-server //data/local/tmp/scrcpy-server

# 设置执行权限
adb shell "chmod +x /data/local/tmp/scrcpy-server"
```

即使 scrcpy 预览超时，AI 命令功能仍可通过 adb 截图正常工作。

### 8. pnpm 安装问题

如果 `pnpm install` 因 electron 等包下载失败，可跳过 postinstall scripts：

```bash
pnpm install --ignore-scripts
```

然后按需单独构建所需包：
```bash
npx nx run @midscene/core:build
npx nx run @midscene/android:build
```
