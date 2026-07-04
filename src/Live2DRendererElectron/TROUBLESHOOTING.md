# Live2D 桌面宠物开发踩坑记录

## 坑 1：改了代码但不生效（app.asar 缓存）

### 现象

修改了 `windowManager.ts`，重新 `npm run build` 后运行，但行为和之前一模一样。

### 原因

`npm run build` 只输出到 `out/` 目录，不会更新 `app.asar`。打包后的应用从 `app.asar` 加载代码，所以改的代码根本没被加载。

### 解决

开发阶段直接用 `npm run dev` 跑 dev server（HMR），完全绕开 `app.asar`。用自定义的 `dev-launch.ps1` 脚本通过命名管道发送 `LoadModel` 命令，不需要 WPF 宿主就能测试。

---

## 坑 2：Cubism Core 初始化失败

### 现象

```
ENOENT: no such file or directory: live2dcubismcore.min.js
```

### 原因

代码里判断 `app.isPackaged` 时用 `process.resourcesPath` 找 vendor 文件，但 dev 模式下路径不对。

### 解决

- 创建了一个 junction（目录符号链接），把 vendor 文件夹桥接到 Electron 期望的 `resources/` 路径
- 修复了 `.js` 文件的 MIME type，在 `getContentType` 里返回 `text/javascript; charset=utf-8`，否则浏览器拒绝执行

---

## 坑 3：PowerShell 路径乱码

### 现象

模型路径里的中文字符 `符玄` 变成乱码，导致文件找不到。

### 原因

PowerShell 5.1 用 GBK 解码非 ASCII 路径，硬编码的字符串 `"符玄"` 被错误解码。

### 解决

不再硬编码路径，改用 `Get-ChildItem -Recurse` 动态查找模型文件，拿到正确的 `FullName` 后再把 `\` 替换成 `/`。

```powershell
$modelFile = Get-ChildItem -LiteralPath $live2dRoot -Recurse -Filter "*.model3.json" | Select-Object -First 1
$modelPath = ($modelFile.FullName -replace '\\', '/')
```

---

## 坑 4：拖动角色后窗口持续变大（核心 Bug）

### 现象

拖动角色并松手后，角色继续自己移动和缩放。日志显示每次 `setPosition` 调用后窗口尺寸都在增长（688 → 984，一次拖动涨了近 300px）。

### 原因

Windows 高 DPI 缩放下，Electron 的 `setPosition(x, y)` 内部做了 DIP（逻辑像素）↔ 物理像素的转换，每次转换都有舍入误差。

例如 1.25x 缩放下：
- 689 物理像素 → DIP 551.2 → 舍入成 551
- 551 DIP → 物理像素 688.75 → 舍入成 689
- 每次调用掉 1px，拖动过程中调用了几十上百次，误差累积成几十甚至几百像素

### 尝试过的失败方案

1. `setMinimumSize` / `setMaximumSize` 锁尺寸 → **没用**，`setPosition` 内部绕过了限制
2. `setBounds` 带显式 width/height → **大幅缓解**（从每次涨 296px 降到涨 1-2px），但仍有舍入误差

### 最终解决方案（两层防护）

```typescript
// 第一层：拖动时用 setBounds 显式指定宽高，而非 setPosition
ipcMain.handle('pet:drag-move', () => {
  mainWindow.setBounds({
    x: nextX,
    y: nextY,
    width: petDragState.width,   // 锁死初始宽度
    height: petDragState.height   // 锁死初始高度
  }, false);
});

// 第二层：will-resize 事件兜底拦截
mainWindow.on('will-resize', (event, newBounds) => {
  if (petDragState) {
    newBounds.width = petDragState.width;
    newBounds.height = petDragState.height;
  }
});
```

`setBounds` 主动强制尺寸 + `will-resize` 被动拦截任何残余的尺寸变化，双保险把窗口尺寸锁死在拖动开始时的值。

---

## 经验教训

1. **先确认跑的是新代码** —— 改了没效果时，第一步检查是不是在跑缓存
2. **Windows 高 DPI 是 Electron 透明无边框窗口的重灾区** —— 任何涉及窗口位置/尺寸的 API 都可能有舍入误差
3. **`setPosition` 在高 DPI 下不可靠**，优先用 `setBounds` 显式带宽高
4. **`will-resize` 事件可以修改 `newBounds`**，是拦截非预期尺寸变化的最后防线
