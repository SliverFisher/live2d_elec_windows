export type PetPanelBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

/**
 * 管理固定虚拟桌面宿主中的局部桌宠 panel。
 * 所有值都是 BrowserWindow 内容区内的 CSS DIP，不触发原生窗口移动或缩放。
 */
export class PetPanelController {
  private x = 0;
  private y = 0;
  private width: number;
  private height: number;

  constructor(
    private readonly element: HTMLElement,
    initialWidth = 720,
    initialHeight = 900
  ) {
    this.width = initialWidth;
    this.height = initialHeight;
    this.x = (window.innerWidth - initialWidth) / 2;
    this.y = (window.innerHeight - initialHeight) / 2;
    this.apply();
  }

  get bounds(): PetPanelBounds {
    return {
      x: this.x,
      y: this.y,
      width: this.width,
      height: this.height
    };
  }

  setPosition(x: number, y: number): void {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    this.x = x;
    this.y = y;
    this.applyPosition();
  }

  moveBy(dx: number, dy: number): void {
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
    this.x += dx;
    this.y += dy;
    this.applyPosition();
  }

  /** 调整 panel 尺寸并保持屏幕中心不变。 */
  resizeAroundCenter(width: number, height: number): void {
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return;
    const centerX = this.x + this.width / 2;
    const centerY = this.y + this.height / 2;
    this.width = Math.max(160, Math.round(width));
    this.height = Math.max(160, Math.round(height));
    this.x = centerX - this.width / 2;
    this.y = centerY - this.height / 2;
    this.apply();
  }

  private apply(): void {
    this.applyPosition();
    this.element.style.width = `${this.width}px`;
    this.element.style.height = `${this.height}px`;
  }

  private applyPosition(): void {
    this.element.style.left = `${this.x}px`;
    this.element.style.top = `${this.y}px`;
  }
}
