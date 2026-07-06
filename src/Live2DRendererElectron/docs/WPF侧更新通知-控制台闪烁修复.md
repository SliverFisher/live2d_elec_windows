# Live2DRenderer 更新通知 — 启动控制台闪烁修复

**更新日期**：2026-07-05  
**更新类型**：体验优化（无协议变更，无接口变更）  
**影响范围**：仅 WPF 侧启动 Live2DRenderer 时的视觉体验

---

## 一、问题描述

WPF 侧启动 Live2DRenderer.exe 时，会有一个黑色控制台窗口闪一下后消失。

## 二、原因

Live2DRenderer 的 .NET wrapper 项目输出类型为 `Exe`（控制台应用），Windows 启动控制台应用时会自动创建并显示控制台窗口。虽然 wrapper 内部启动 Electron 时已设置 `CreateNoWindow = true`，但 wrapper 自身的控制台窗口仍会短暂显示。

## 三、修复内容

| 项 | 修改前 | 修改后 |
|----|--------|--------|
| wrapper 输出类型 | `OutputType=Exe`（控制台应用） | `OutputType=WinExe`（Windows 应用） |
| 启动时控制台窗口 | 闪烁出现后消失 | **不显示** |

**修改文件**：`wrapper/Live2DRenderer.Wrapper.csproj`

## 四、WPF 侧是否需要修改？

**不需要任何修改。**

- 协议、参数、命令、事件均无变化
- 启动方式不变（仍通过 `Live2DRenderer.exe --pipe-name ... --parent-pid ... --log-dir ...` 启动）
- 进程管理方式不变（仍然可以通过 PID 监控、通过 pipe 通信）
- 退出码行为不变

唯一变化：启动时不再有控制台窗口闪烁。

## 五、验证方法

1. WPF 侧正常启动 Live2DRenderer
2. 观察：**不再有黑色控制台窗口闪烁**
3. 验证模型加载、拖拽、缩放、点击、TTS 口型等功能均正常

## 六、更新文件

只需替换以下文件（1 个文件）：

| 文件 | 说明 |
|------|------|
| `Live2DRenderer.exe` | .NET wrapper（已改为 WinExe，无控制台窗口） |

`Live2DRendererHost.exe`、`resources/app.asar`、`resources/vendor/` 等其他文件本次无变更，可不必替换。

---

**备注**：本次同步还包含一项 TypeScript 类型修复（main.ts 中 Details 类型转换），不影响运行时行为，属于代码质量改进。
