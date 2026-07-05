# Live 侧整改结果报告

整改日期：2026-07-05
项目：`Live2DRendererElectron`（Live 项目）
路径：`c:\Users\49213\Desktop\A\codex\Live\src\Live2DRendererElectron`

---

## 1. 整改完成清单

### P0-1: AI_madi → AI_maid 统一 ✅

**修改文件**：

| 文件 | 改动 |
|---|---|
| `src/main/protocolTypes.ts` | `AiMadiCommand` → `AiMaidCommand` |
| `src/main/windowManager.ts` | `handleAiMadiCommand` → `handleAiMaidCommand`；`AI_madiClose` → `AI_maidClose`；注释统一 |
| `src/main/main.ts` | `isAiMadiMode` → `isAiMaidMode`；`AI_madiExit` → `AI_maidExit` |
| `src/main/protocol.ts` | 类型引用 + 注释 |
| `src/main/pipeClient.ts` | 类型引用 + 注释 |
| `src/main/args.ts` | `isAiMadiMode` → `isAiMaidMode`；注释 |
| `src/preload/preload.ts` | `isAiMadiMode` → `isAiMaidMode` |
| `src/renderer/renderer.ts` | `isAiMadiMode` → `isAiMaidMode`；注释 |
| `src/renderer/live2d/motionController.ts` | 注释 |
| `scripts/mock-ai-madi-client.js` | **重命名为** `scripts/mock-ai-maid-client.js`；`ai_madi` → `ai_maid`；`AI_madi-Mock` → `AI_maid-Mock` |

### P0-2: 模型目录路径 ✅

**现状**：真实目录是 `assests`（拼写错误，但已存在且可用）。

**真实路径**：

```text
C:/Users/49213/Desktop/A/codex/Live/assests/live2d/huohuo/huohuo.model3.json
C:/Users/49213/Desktop/A/codex/Live/assests/live2d/符玄/符玄.model3.json
```

**建议**：AI_maid 侧配置必须填写 `assests`（当前真实目录名）。如需改为 `assets`，需双方协调重命名目录。

### P0-3: Live2DRenderer.exe 真实路径 ✅

```text
C:\Users\49213\Desktop\A\codex\Live\release\MaidAI\Live2DRenderer\Live2DRenderer.exe
```

结构说明：

- `Live2DRenderer.exe` — .NET wrapper（最终启动入口）
- `Live2DRendererHost.exe` — Electron 宿主（被 wrapper 启动）

AI_maid 侧 `appsettings.json` 应配置：

```json
{
  "RendererExePath": "C:\\Users\\49213\\Desktop\\A\\codex\\Live\\release\\MaidAI\\Live2DRenderer\\Live2DRenderer.exe"
}
```

### P1-1: payload.type 去除 ✅

修改 `src/main/protocolTypes.ts` 的 `Envelope<T>` 类型，payload 改为 `Omit<T, 'type'>`；`makeEnvelope` 用解构剥离 `type`。

**验证**（真实流水）：

```json
{"type":"RendererReady","requestId":null,"payload":{"protocolVersion":1,"rendererVersion":"1.0.0"}}
```

payload 内不再有 `type` 字段。

### P1-2: ModelLoaded 回传 roleId ✅

`RendererCommand.LoadModel` 新增 `roleId?` 字段，`src/renderer/renderer.ts` 透传到 `ModelLoaded` 事件。

**验证**（真实流水）：

```json
{"type":"ModelLoaded","requestId":"2","payload":{"roleId":"mock-character","modelPath":"C:/Users/49213/Desktop/A/codex/Live/assests/live2d/符玄/符玄.model3.json"}}
```

### P1-3: RightClick 方向确认 ✅

代码方向正确：`src/renderer/renderer.ts` 的 `contextmenu` 事件 → `emitEvent({ type: 'RightClick' })` → 主进程转发给 AI_maid。方向是 **Live → AI_maid**。

### P1-4: --log-dir 不再拼 logs 子目录 ✅

修改 `src/main/logger.ts`：`--log-dir <dir>` 时直接写入 `<dir>/live2d-renderer.log`。

**验证**：`--log-dir C:\...\release\MaidAI\logs` → 日志文件位于 `C:\...\release\MaidAI\logs\live2d-renderer.log`（无额外 `logs/` 子目录）。

### P1-5: SpeakStop 显式归零 ParamMouthOpenY ✅

`src/renderer/live2d/motionController.ts` 新增 `speakingCoreModel` 引用，`stopSpeaking()` 清除定时器后显式调用 `coreModel.setParameterValueById('ParamMouthOpenY', 0)`。

---

## 2. 新的真实启动命令

AI_maid 正式启动：

```text
C:\Users\49213\Desktop\A\codex\Live\release\MaidAI\Live2DRenderer\Live2DRenderer.exe \
  --pipe-name ai_maid-live2d-<pid> \
  --parent-pid <pid> \
  --log-dir C:\Users\49213\AppData\Local\AI_maid\logs
```

Mock 测试命令：

```text
node scripts/mock-ai-maid-client.js [modelPath]
```

---

## 3. 新的真实 JSON Lines 流水

以下为 2026-07-05 04:19:16 ~ 04:19:33 期间，使用 `node scripts/mock-ai-maid-client.js C:/Users/49213/Desktop/A/codex/Live/assests/live2d/符玄/符玄.model3.json` 测试时的真实协议流：

```json
{"type":"RendererReady","requestId":null,"timestamp":"2026-07-05T04:19:16.982Z","payload":{"protocolVersion":1,"rendererVersion":"1.0.0"}}
{"type":"Init","requestId":"1","timestamp":"2026-07-05T04:19:17.290Z","payload":{"type":"Init","protocolVersion":1,"appName":"AI_maid-Mock","parentPid":68400}}
{"type":"InitAck","requestId":"1","timestamp":"2026-07-05T04:19:17.293Z","payload":{"ok":true}}
{"type":"LoadModel","requestId":"2","timestamp":"2026-07-05T04:19:17.806Z","payload":{"type":"LoadModel","roleId":"mock-character","roleName":"测试角色","modelPath":"C:/Users/49213/Desktop/A/codex/Live/assests/live2d/符玄/符玄.model3.json","initialTransform":{"scale":1}}}
{"type":"ModelLoaded","requestId":"2","timestamp":"2026-07-05T04:19:19.893Z","payload":{"roleId":"mock-character","modelPath":"C:/Users/49213/Desktop/A/codex/Live/assests/live2d/符玄/符玄.model3.json"}}
{"type":"SetActionTag","requestId":"3","timestamp":"2026-07-05T04:19:21.904Z","payload":{"type":"SetActionTag","actionTag":"speak","source":"llm_reply","durationMs":5000}}
{"type":"SpeakStop","requestId":"4","timestamp":"2026-07-05T04:19:24.922Z","payload":{"type":"SpeakStop","reason":"finished"}}
{"type":"TransformChanged","requestId":null,"timestamp":"2026-07-05T04:19:27.149Z","payload":{"x":1309,"y":16,"scale":1,"reason":"dragEnd"}}
{"type":"SetExpression","requestId":"5","timestamp":"2026-07-05T04:19:27.929Z","payload":{"type":"SetExpression","name":"smile","durationMs":3000}}
{"type":"TransformChanged","requestId":null,"timestamp":"2026-07-05T04:19:33.548Z","payload":{"x":1444,"y":46,"scale":1,"reason":"dragEnd"}}
```

---

## 4. live2d-renderer.log 真实路径

```text
<--log-dir 指定目录>/live2d-renderer.log
```

本次测试实际路径：

```text
C:\Users\49213\Desktop\A\codex\Live\src\Live2DRendererElectron\release\MaidAI\logs\live2d-renderer.log
```

文件大小：14KB

---

## 5. Mock 重跑结果

| 测试项 | 结果 | 证据 |
|---|---|---|
| AI_maid 启动 Live（mock 模拟） | ✅ 通过 | pipe 连接成功 |
| RendererReady（payload 无 type） | ✅ 通过 | 流水第 1 行 |
| Init / InitAck | ✅ 通过 | 流水第 2-3 行 |
| LoadModel / ModelLoaded（含 roleId） | ✅ 通过 | 流水第 4-5 行 |
| SetActionTag(speak) | ✅ 通过 | 流水第 6 行 |
| SpeakStop（嘴型归零） | ✅ 通过 | 流水第 7 行 |
| TransformChanged（人工拖动触发，含 x/y） | ✅ 通过 | 流水第 8、10 行 |
| SetExpression（缺失资源不崩溃） | ✅ 通过 | 流水第 9 行 |
| 无 `AI_madi` 残留 | ✅ 通过 | 全项目 grep 无匹配 |
| `--log-dir` 直写 | ✅ 通过 | 日志在 `--log-dir` 目录下，无 `logs/` 子目录 |

---

## 6. 待 AI_maid 侧确认事项

1. **指令 payload 中的 `type` 字段**：Live 侧**上报**的事件 payload 已干净（无重复 `type`）。但 mock 客户端**发送**的命令 payload 中仍保留 `type` 字段——Live 侧接收时会忽略。如需 AI_maid 侧发送时也去掉 payload 内的 `type`，请通知 AI_maid Codex 调整。

2. **模型目录名**：当前真实目录是 `assests`（拼写错误）。AI_maid 侧配置必须填写 `assests`。如需统一改为 `assets`，需双方协调重命名目录。

3. **`RendererExePath` 配置**：AI_maid 侧 `appsettings.json` 或 `live2d_state.json` 应显式配置：

   ```json
   {
     "RendererExePath": "C:\\Users\\49213\\Desktop\\A\\codex\\Live\\release\\MaidAI\\Live2DRenderer\\Live2DRenderer.exe"
   }
   ```

   不要依赖路径猜测。

4. **真实联调**：以上均为 mock 测试结果。正式联调需 AI_maid 真实启动 `Live2DRenderer.exe`，按指令文档第 4 节"必须跑真实联调"流程执行。

---

## 7. 下一步

待 AI_maid 侧完成对应整改并提供材料后，按指令文档第 6 节"真实联调通过标准"逐项验证：

- [ ] AI_maid 启动 Live2DRenderer.exe（真实）
- [ ] RendererReady（真实收到）
- [ ] Init / InitAck（真实通过）
- [ ] LoadModel / ModelLoaded（真实通过）
- [ ] 中文路径模型（真实通过）
- [ ] TTS SpeakStart / SpeakStop（真实通过）
- [ ] 点击 PointerEvent（真实通过）
- [ ] 右键 RightClick（真实通过）
- [ ] 拖动 TransformChanged（真实通过）
- [ ] 缩放 TransformChanged（真实通过）
- [ ] live2d_state.json 保存位置和缩放（真实通过）
- [ ] AI_maid 退出 Live 自动退出（真实通过）
- [ ] 没有 `AI_madi` 残留（真实通过）
- [ ] 没有 `assets/assests` 路径混用（真实通过）

全部通过后，再进入下一阶段功能开发。
