# Live2D 模型显示问题排查报告

## 当前状态
- 模型加载成功，无致命错误
- 纹理加载成功（4-8张纹理，均为 valid）
- 但模型显示异常（白色/棕色矩形，脸部及其他部位显示错乱）
- 使用技术栈：Pixi v7.4.3 + pixi-live2d-display-lipsyncpatch v0.5.0-ls-8 + Cubism Core 6.0.1
- 模型版本：Cubism 3（符玄、huohuo 均出现相同问题）

## 相关代码位置

### 1. 模型加载入口
- 文件：[Live2DPlayer.ts](file:///c:/Users/49213/Desktop/A/codex/Live/src/Live2DRendererElectron/src/renderer/live2d/Live2DPlayer.ts#L86-L190)
- 方法：`loadModel()` - 模型加载主流程

### 2. Cubism Core 6 兼容性补丁
- 文件：[Live2DPlayer.ts](file:///c:/Users/49213/Desktop/A/codex/Live/src/Live2DRendererElectron/src/renderer/live2d/Live2DPlayer.ts#L249-L557)
- 方法：`applyCubismCore6Compat()` - 一次性补丁
  - 修复 renderOrders 全为 -1 的问题（从 drawOrders 生成连续整数）
  - 修复 opacities 全为 0 的问题（强制设为 1）
  - 修复 constantFlags 位布局问题（强制设为 0，使用 Normal 混合）
  - 禁用高精度遮罩和 clipping manager
  - 禁用背面剔除
  - 重写 `getDrawableOpacity` 方法（返回至少 1）
  - 重写 `getDrawableBlendMode` 方法（强制返回 Normal）
  - 重写 `getDrawableRenderOrders` 方法

### 3. 每帧补丁（补丁时机修复）
- 文件：[Live2DPlayer.ts](file:///c:/Users/49213/Desktop/A/codex/Live/src/Live2DRendererElectron/src/renderer/live2d/Live2DPlayer.ts#L530-L584)
- 方式：monkey-patch `internalModel.update()`，在 update 之后执行 `applyPerFrameCompatPatches()`
- 原因：Pixi ticker 阶段执行的补丁会被 `_render()` 中的 `internalModel.update()` 覆盖

### 4. 库的渲染流程
- 文件：[cubism4.js](file:///c:/Users/49213/Desktop/A/codex/Live/src/Live2DRendererElectron/node_modules/pixi-live2d-display-lipsyncpatch/dist/cubism4.js#L10575-L10615)
- 方法：`Live2DModel._render()`
  - 调用 `internalModel.update(deltaTime, elapsedTime)` → 内部调用 `coreModel.update()`
  - 调用 `internalModel.draw(gl)` → 渲染

### 5. 库的渲染器绘制流程
- 文件：[cubism4.js](file:///c:/Users/49213/Desktop/A/codex/Live/src/Live2DRendererElectron/node_modules/pixi-live2d-display-lipsyncpatch/dist/cubism4.js#L7399-L7558)
- 方法：`CubismRenderer_WebGL.doDrawModel()` 和 `drawMesh()`
- 使用的关键数据：
  - `getModel().getDrawableRenderOrders()` - 渲染顺序
  - `getModel().getDrawableOpacity()` - 透明度
  - `getModel().getDrawableBlendMode()` - 混合模式
  - `getModel().getDrawableVertices()` - 顶点坐标
  - `getModel().getDrawableVertexUvs()` - UV 坐标
  - `getModel().getDrawableTextureIndex()` - 纹理索引

### 6. 纹理绑定
- 文件：[cubism4.js](file:///c:/Users/49213/Desktop/A/codex/Live/src/Live2DRendererElectron/node_modules/pixi-live2d-display-lipsyncpatch/dist/cubism4.js#L10598-L10603)
- 位置：`_render()` 方法中
- 渲染器纹理存储：`renderer._textures[textureNo]`（通过 `bindTexture` 设置）

## 遇到的难点

### 难点 1：Cubism Core 6 与 Cubism 3 模型的兼容性
- **现象**：opacities 全为 0，renderOrders 全为 -1，constantFlags 位布局错误
- **原因**：Cubism Core 6.0.1 读取 Cubism 3 模型时，动态标志位（dynamicFlags）和常量标志位（constantFlags）的位布局不兼容
- **当前处理**：通过 monkey-patch 修复，但可能还有其他未发现的兼容性问题
- **相关代码**：[Live2DPlayer.ts](file:///c:/Users/49213/Desktop/A/codex/Live/src/Live2DRendererElectron/src/renderer/live2d/Live2DPlayer.ts#L249-L527) `applyCubismCore6Compat()`

### 难点 2：补丁时机难以掌握
- **现象**：在 Pixi ticker 中执行的补丁不生效
- **原因**：`coreModel.update()` 在 `_render()` 阶段才调用，会重置 drawables 数据
- **当前处理**：monkey-patch `internalModel.update()`，在 update 之后立即应用补丁
- **相关代码**：[Live2DPlayer.ts](file:///c:/Users/49213/Desktop/A/codex/Live/src/Live2DRendererElectron/src/renderer/live2d/Live2DPlayer.ts#L548-L556)

### 难点 3：白色/棕色矩形显示异常难以定位
- **现象**：模型加载成功但显示为白色/棕色矩形块，脸部及其他部位显示错乱
- **可能的原因（未确认）**：
  1. UV 坐标翻转问题（textureFlipY 不正确）
  2. 顶点坐标或顶点索引问题
  3. 纹理绑定不正确（纹理索引不匹配）
  4. 混合模式或着色器问题
  5. multiplyColors / screenColors 问题
  6. 遮罩（mask）问题
- **已排除的原因**：
  - 纹理未加载（texturesValid 均为 true）
  - opacity 全为 0（已强制设为 1）
  - renderOrders 全为 -1（已修复）
  - 混合模式错误（已强制设为 Normal）
  - 背面剔除（已禁用）
  - 遮罩管理器（已禁用）
- **缺少的诊断手段**：
  - 无法直接查看 WebGL 帧缓冲内容
  - 无法在渲染时断点调试顶点数据
  - 缺少可正常工作的参考实现做对比

### 难点 4：缺少正确版本的 Cubism Core
- **现象**：当前使用 Cubism Core 6.0.1，但模型是 Cubism 3 版本
- **理想方案**：使用与模型版本匹配的 Cubism Core 4 或 Core 3
- **当前限制**：项目中只有 Core 6.0.1，无法快速切换验证
- **相关代码**：[windowManager.ts](file:///c:/Users/49213/Desktop/A/codex/Live/src/Live2DRendererElectron/src/main/windowManager.ts#L170) `getCubismCoreUrl()`

### 难点 5：库的黑盒特性
- **现象**：pixi-live2d-display-lipsyncpatch 封装了大量 Cubism SDK 逻辑，内部状态难以追踪
- **具体表现**：
  - `coreModel.getModel().drawables` 的数据结构和生命周期不明确
  - `coreModel.update()` 具体修改了哪些数据不明确
  - 渲染器的 `_textures` 数组与模型的纹理索引对应关系不明确
- **相关文件**：[cubism4.js](file:///c:/Users/49213/Desktop/A/codex/Live/src/Live2DRendererElectron/node_modules/pixi-live2d-display-lipsyncpatch/dist/cubism4.js)（压缩后的库文件，难以阅读）

## 诊断日志中已确认的信息

1. **模型数据**：
   - drawableCount: 326（huohuo）/ 433（符玄）
   - visibleCount: 正常
   - textureCount: 4（huohuo）/ 8（符玄）
   - texturesValid: 全部为 true

2. **UV 坐标范围**（第一个 drawable）：
   - 有正常的 UV 范围（0-1 之间）
   - 不是全 0 或全 1

3. **顶点坐标范围**：
   - 有正常的坐标范围
   - 不是全部挤在一个点

4. **混合模式分布**：
   - Normal / Additive / Multiplicative 都有
   - 已强制全部改为 Normal

5. **遮罩使用情况**：
   - 部分 drawable 有 mask
   - 已禁用 clipping manager
