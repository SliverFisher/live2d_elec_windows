// ============================================================
// BubbleManager — DOM overlay 气泡 (跟随 Live2D 模型)
//
// v6 最终版: 不再追求椭圆/SVG 一笔画.
//   - HTML/CSS 圆角矩形 + CSS 三角尾巴 (::before/::after + clip-path)
//   - 位置基于 Live2D model.getBounds() (Pixi stage coords == window CSS 像素)
//   - 气泡宽度固定, 文本只影响高度, 长文本向上增长
//   - 全文展示, 不分页, 不省略, 不截断
//   - bubbleLayer pointer-events:none, 气泡本体 pointer-events:auto
//   - 跟随模型: ShowBubble / 模型加载 / 拖动结束 / 缩放结束 / 窗口 resize 时重新定位
// ============================================================

const HEAD_GAP_DEFAULT = 0;           // 尾巴最低点到头顶的距离 (0 = 尾尖落在包围盒顶部)
const TAIL_HEIGHT_DEFAULT = 18;        // 尾巴高度 (与 CSS ::before bottom:-18px 对齐)
const MARGIN_DEFAULT = 12;            // 窗口边缘留白

const BASE_MODEL_HEIGHT = 720;        // 用于估算字体/宽度缩放
const SCALE_MIN = 0.82;
const SCALE_MAX = 1.18;

const DURATION_MIN_MS = 3600;
const DURATION_MAX_MS = 18000;
const DURATION_BASE_MS = 2600;
const DURATION_PER_CHAR_MS = 90;

const LEAVE_ANIMATION_MS = 120;

type VoiceStyle = 'normal' | 'soft' | 'lively' | 'close';

interface BubbleTask {
  requestId: string;
  text: string;
  voiceStyle: VoiceStyle;
  durationMs: number;
  priority: number;
  interrupt: boolean;
}

export interface BubbleCallbacks {
  onShown: (requestId: string) => void;
  onError: (requestId: string, error: string) => void;
  onHidden: (requestId: string, reason: string) => void;
}

/**
 * 模型 bounds 信息 (window CSS 像素坐标).
 *   bounds: Pixi model.getBounds() 的结果, 已是 CSS 像素 (autoDensity).
 *   scale:  Live2DPlayer 的 userScale.
 */
export interface ModelBoundsInfo {
  bounds: { x: number; y: number; width: number; height: number };
  scale: number;
}

export type GetModelBounds = () => ModelBoundsInfo | null;

// ============================================================
// 主题色表
// ============================================================

interface BubbleTheme {
  bg: string;
  border: string;
  textColor: string;
  tailBorder: string;   // ::before 边框色
  tailFill: string;     // ::after 填充色 (与气泡背景同色)
}

const THEMES: Record<VoiceStyle, BubbleTheme> = {
  normal: {
    bg: 'rgba(255, 250, 253, 0.97)',
    border: 'rgba(238, 138, 180, 0.82)',
    textColor: '#4b2735',
    tailBorder: 'rgba(238, 138, 180, 0.82)',
    tailFill: 'rgba(255, 250, 253, 0.97)'
  },
  soft: {
    bg: 'rgba(255, 251, 248, 0.97)',
    border: 'rgba(232, 157, 192, 0.84)',
    textColor: '#4a2b38',
    tailBorder: 'rgba(232, 157, 192, 0.84)',
    tailFill: 'rgba(255, 251, 248, 0.97)'
  },
  lively: {
    bg: 'rgba(255, 247, 238, 0.97)',
    border: 'rgba(255, 145, 188, 0.86)',
    textColor: '#532537',
    tailBorder: 'rgba(255, 145, 188, 0.86)',
    tailFill: 'rgba(255, 247, 238, 0.97)'
  },
  close: {
    bg: 'rgba(255, 244, 250, 0.98)',
    border: 'rgba(255, 118, 172, 0.9)',
    textColor: '#4f2034',
    tailBorder: 'rgba(255, 118, 172, 0.9)',
    tailFill: 'rgba(255, 244, 250, 0.98)'
  }
};

// ============================================================
// BubbleManager
// ============================================================

export class BubbleManager {
  private bubbleLayer: HTMLDivElement | null = null;
  private bubbleEl: HTMLDivElement | null = null;
  private textEl: HTMLDivElement | null = null;
  private currentTask: BubbleTask | null = null;
  private queue: BubbleTask[] = [];
  private seenRequestIds = new Set<string>();
  private hideTimer: number | null = null;
  private isHovered = false;
  private callbacks: BubbleCallbacks;
  private getModelBounds: GetModelBounds;
  private isLeaving = false;
  // 缓存当前气泡宽度, 避免每次定位都重新计算
  private currentBubbleWidth = 420;

  constructor(callbacks: BubbleCallbacks, getModelBounds: GetModelBounds) {
    this.callbacks = callbacks;
    this.getModelBounds = getModelBounds;
    this.setupDom();
  }

  private setupDom(): void {
    // 复用 index.html 里已声明的 #bubbleLayer; 没有则创建
    this.bubbleLayer = document.querySelector<HTMLDivElement>('#bubbleLayer');
    if (!this.bubbleLayer) {
      this.bubbleLayer = document.createElement('div');
      this.bubbleLayer.id = 'bubbleLayer';
      this.bubbleLayer.className = 'bubble-layer';
      document.body.appendChild(this.bubbleLayer);
    }

    // 气泡本体 (圆角矩形 + CSS 三角尾巴)
    this.bubbleEl = document.createElement('div');
    this.bubbleEl.className = 'live2d-bubble live2d-bubble--normal is-hidden';

    this.textEl = document.createElement('div');
    this.textEl.className = 'live2d-bubble__text';

    this.bubbleEl.appendChild(this.textEl);
    this.bubbleLayer.appendChild(this.bubbleEl);

    // 鼠标交互
    this.bubbleEl.addEventListener('mouseenter', () => {
      this.isHovered = true;
      this.clearHideTimer();
    });
    this.bubbleEl.addEventListener('mouseleave', () => {
      this.isHovered = false;
      this.scheduleAutoHide();
    });
    // 点击 → 立即隐藏
    this.bubbleEl.addEventListener('click', () => {
      this.hide('user_clicked');
    });
  }

  show(
    requestId: string,
    text: string,
    voiceStyle: VoiceStyle = 'normal',
    durationMs = 0,
    priority = 50,
    interrupt = true
  ): void {
    if (!text || !text.trim()) {
      this.callbacks.onError(requestId, 'empty_text');
      return;
    }

    if (this.seenRequestIds.has(requestId)) {
      console.info('[Bubble] duplicate requestId ignored', requestId);
      return;
    }
    this.seenRequestIds.add(requestId);

    const task: BubbleTask = {
      requestId,
      text,
      voiceStyle,
      durationMs,
      priority,
      interrupt
    };

    if (this.currentTask === null) {
      this.displayTask(task);
      return;
    }

    const current = this.currentTask;
    const shouldInterrupt =
      interrupt || (priority >= 80 && priority > current.priority);

    if (shouldInterrupt) {
      this.clearHideTimer();
      const interruptedId = current.requestId;
      this.callbacks.onHidden(interruptedId, 'interrupted');
      this.displayTask(task);
    } else {
      this.queue.push(task);
    }
  }

  hide(reason = 'user_closed'): void {
    this.queue = [];
    if (this.currentTask === null) {
      return;
    }
    const requestId = this.currentTask.requestId;
    this.currentTask = null;
    this.clearHideTimer();
    this.startLeaveAnimation(() => {
      this.callbacks.onHidden(requestId, reason);
    });
  }

  private displayTask(task: BubbleTask): void {
    this.currentTask = task;
    this.renderContent();

    if (this.bubbleEl) {
      this.bubbleEl.classList.remove('is-leaving');
      this.bubbleEl.classList.add('is-entering');
    }

    // 先定位再显示 (placeBubble 内部会移除 is-hidden)
    this.placeBubble();

    this.callbacks.onShown(task.requestId);
    this.scheduleAutoHide();
  }

  private renderContent(): void {
    const task = this.currentTask;
    if (!task || !this.bubbleEl || !this.textEl) return;

    // 主题: 容器类名
    this.bubbleEl.className = `live2d-bubble live2d-bubble--${task.voiceStyle} is-hidden`;
    const theme = THEMES[task.voiceStyle] ?? THEMES.normal;

    // 主题色: 背景/边框/文字/尾巴
    this.bubbleEl.style.background = theme.bg;
    this.bubbleEl.style.borderColor = theme.border;
    this.bubbleEl.style.color = theme.textColor;
    this.bubbleEl.style.setProperty('--tail-border-color', theme.tailBorder);
    this.bubbleEl.style.setProperty('--tail-fill-color', theme.tailFill);

    // 完整文本一次性显示 (不分页, 无页码)
    this.textEl.textContent = task.text;
  }

  /**
   * 计算显示时长.
   *  - durationMs>0: 用指定时长 (上限 DURATION_MAX_MS)
   *  - 否则: clamp(2600 + 字数*90, 3600, 18000)
   */
  private computeDuration(task: BubbleTask): number {
    if (task.durationMs > 0) {
      return Math.min(task.durationMs, DURATION_MAX_MS);
    }
    const charCount = task.text.length;
    const duration = DURATION_BASE_MS + charCount * DURATION_PER_CHAR_MS;
    return Math.max(DURATION_MIN_MS, Math.min(DURATION_MAX_MS, duration));
  }

  private scheduleAutoHide(): void {
    if (this.isHovered) return;
    const task = this.currentTask;
    if (!task) return;

    this.clearHideTimer();
    const duration = this.computeDuration(task);
    this.hideTimer = window.setTimeout(() => {
      this.hideTimer = null;
      this.hide('timeout');
    }, duration);
  }

  private clearHideTimer(): void {
    if (this.hideTimer !== null) {
      window.clearTimeout(this.hideTimer);
      this.hideTimer = null;
    }
  }

  private startLeaveAnimation(onDone: () => void): void {
    if (!this.bubbleEl) {
      onDone();
      return;
    }
    if (this.isLeaving) {
      onDone();
      return;
    }
    this.isLeaving = true;
    this.bubbleEl.classList.remove('is-entering');
    this.bubbleEl.classList.add('is-leaving');
    window.setTimeout(() => {
      this.isLeaving = false;
      if (this.bubbleEl) {
        this.bubbleEl.classList.add('is-hidden');
        this.bubbleEl.classList.remove('is-leaving');
      }
      onDone();
      this.drainQueue();
    }, LEAVE_ANIMATION_MS);
  }

  private drainQueue(): void {
    if (this.currentTask !== null) return;
    if (this.queue.length === 0) return;
    const next = this.queue.shift()!;
    this.displayTask(next);
  }

  /**
   * 获取模型 bounds. 返回 null 时 (模型未加载) 用窗口比例兜底.
   */
  private resolveModelBounds(): ModelBoundsInfo | null {
    const fromModel = this.getModelBounds();
    if (fromModel &&
        Number.isFinite(fromModel.bounds.x) &&
        Number.isFinite(fromModel.bounds.y) &&
        fromModel.bounds.width > 0 &&
        fromModel.bounds.height > 0) {
      return fromModel;
    }
    return null;
  }

  /**
   * 放置气泡.
   *
   * 算法:
   *   1. 拿到 model bounds (CSS 像素, window-relative)
   *   2. 按 widthRatio 估算气泡宽度, clamp 到 [minWidth*scale, maxWidth*scale]
   *   3. headTop = bounds.top + bounds.height * headTopRatio
   *      headCenterX = bounds.left + bounds.width * headCenterXRatio
   *   4. left = headCenterX - width * 0.34 (气泡略偏右, 让左下尾巴指向头部)
   *   5. top = headTop - bubbleHeight - tailHeight - gap (长文本向上增长)
   *   6. 横向 clamp 到 [margin, layerWidth - width - margin]
   *   7. 纵向: 顶部空间不足时贴窗口顶 (不截断文本)
   *   8. 尾巴 left = headCenterX - bubbleLeft - 17, clamp 到 [42, width-76]
   *
   * 长文本处理: 气泡宽度固定, 文本只影响高度, 高度变化后重新测量
   * bubbleRect.height, 再用 headTop - bubbleHeight - tailHeight - gap 算 top,
   * 让气泡向上长. 这是本算法的关键.
   */
  placeBubble(): void {
    if (!this.bubbleEl || !this.bubbleLayer) return;
    const task = this.currentTask;
    if (!task) return;

    // 先移除 is-hidden 让浏览器能测量高度
    this.bubbleEl.classList.remove('is-hidden');
    // 临时设为不可见, 避免定位过程中闪烁
    this.bubbleEl.style.visibility = 'hidden';
    this.bubbleEl.style.left = '0px';
    this.bubbleEl.style.top = '0px';

    const layerWidth = this.bubbleLayer.clientWidth || window.innerWidth;
    const layerHeight = this.bubbleLayer.clientHeight || window.innerHeight;

    // 1. 模型 bounds (拿不到时用窗口比例兜底)
    const modelInfo = this.resolveModelBounds();
    let modelBounds: { x: number; y: number; width: number; height: number };
    let scale: number;
    if (modelInfo) {
      modelBounds = modelInfo.bounds;
      scale = clamp(modelInfo.scale, SCALE_MIN, SCALE_MAX);
    } else {
      // 兜底: 模型占窗口中间 60% 宽, 高度按窗口比例
      modelBounds = {
        x: layerWidth * 0.2,
        y: layerHeight * 0.1,
        width: layerWidth * 0.6,
        height: layerHeight * 0.8
      };
      scale = 1;
    }

    // 2. 气泡宽度 (固定, 不随文本变化)
    const widthRatio = 0.82;
    const minWidth = 300 * scale;
    const maxWidth = Math.min(520 * scale, layerWidth - MARGIN_DEFAULT * 2);
    const width = clamp(
      modelBounds.width * widthRatio,
      minWidth,
      Math.max(minWidth, maxWidth)
    );
    this.currentBubbleWidth = width;

    // 设置宽度和字体大小
    this.bubbleEl.style.setProperty('--bubble-width', `${width}px`);
    this.bubbleEl.style.setProperty('--bubble-font-size', `${16 * scale}px`);

    // 3. 头部锚点
    const headTopRatio = 0;
    const headCenterXRatio = 0.5;
    const headTop = modelBounds.y + modelBounds.height * headTopRatio;
    const headCenterX = modelBounds.x + modelBounds.width * headCenterXRatio;

    // 4. 测量气泡实际高度 (文本撑开后的高度)
    const bubbleRect = this.bubbleEl.getBoundingClientRect();
    const bubbleHeight = bubbleRect.height || 72;

    // 5. 横向: 气泡略偏右, 让左下尾巴指向头部中心
    let left = headCenterX - width * 0.34;
    left = clamp(left, MARGIN_DEFAULT, layerWidth - width - MARGIN_DEFAULT);

    // 6. 纵向: 长文本向上增长
    let top = headTop - bubbleHeight - TAIL_HEIGHT_DEFAULT - HEAD_GAP_DEFAULT;
    if (top < MARGIN_DEFAULT) {
      top = MARGIN_DEFAULT;
    }

    // 7. 尾巴 left (相对气泡左上角)
    const tailLeft = clamp(
      headCenterX - left - 17,
      42,
      Math.max(42, width - 76)
    );

    this.bubbleEl.style.left = `${left}px`;
    this.bubbleEl.style.top = `${top}px`;
    this.bubbleEl.style.setProperty('--tail-left', `${tailLeft}px`);
    this.bubbleEl.style.visibility = 'visible';
  }

  /**
   * 当模型加载/拖动结束/缩放结束/窗口 resize 时调用, 重新定位气泡.
   * 仅在气泡可见时才重新定位.
   */
  relayoutIfVisible(): void {
    if (!this.bubbleEl) return;
    if (this.bubbleEl.classList.contains('is-hidden')) return;
    this.placeBubble();
  }

  onResize(): void {
    this.relayoutIfVisible();
  }

  containsClientPoint(clientX: number, clientY: number): boolean {
    if (!this.bubbleEl || this.bubbleEl.classList.contains('is-hidden')) return false;
    const rect = this.bubbleEl.getBoundingClientRect();
    return clientX >= rect.left && clientX <= rect.right &&
      clientY >= rect.top && clientY <= rect.bottom;
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
