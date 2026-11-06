// ==========================================================================
// Aimo 风格对话框动效控制器
// 1. 桌面端：打开微升微缩浮入，关闭放大淡出 (scale 1 -> 1.08, opacity 1 -> 0)
// 2. 移动端：底部抽屉形态，打开平滑上划展开，关闭抽屉顺滑下滑离场 (translateY 0 -> 100%)
// 3. 严格限定在 html[data-ui-preset="aimo"] 生效，其他主题完全不受影响
// ==========================================================================

import { Dialog } from 'mdui/components/dialog.js';
import { lockScreen, unlockScreen } from '@mdui/shared/helpers/scroll.js';
import { animateTo, stopAnimations } from '@mdui/shared/helpers/animate.js';

const isAimoActive = () => document.documentElement.getAttribute('data-ui-preset') === 'aimo';

let initialized = false;

export function initAimoDialogMotion() {
  if (initialized) return;
  initialized = true;

  const origOnOpenChange = Dialog.prototype.onOpenChange;

  Dialog.prototype.onOpenChange = async function(oldValue, newValue) {
    if (!isAimoActive()) {
      return origOnOpenChange.call(this, oldValue, newValue);
    }

    const hasUpdated = this.hasUpdated;
    if (!this.open && !hasUpdated) {
      return;
    }

    await this.definedController?.whenDefined?.();
    if (!hasUpdated) {
      await this.updateComplete;
    }

    const overlay = this.overlayRef?.value || this.shadowRoot?.querySelector('.overlay');
    const panel = this.panelRef?.value || this.shadowRoot?.querySelector('.panel');
    const children = Array.from(panel ? panel.querySelectorAll('.header, .body, .actions') : []);

    const stopAll = () => Promise.all([
      stopAnimations(overlay),
      stopAnimations(panel),
      ...children.map((child) => stopAnimations(child)),
    ]);

    const isMobile = window.innerWidth <= 860;

    if (this.open) {
      // ----------------- 打开动画 -----------------
      if (hasUpdated) {
        const eventProceeded = this.emit('open', { cancelable: true });
        if (!eventProceeded) {
          return;
        }
      }

      this.style.display = 'flex';

      const topAppBarElements = this.topAppBarElements ?? [];
      if (topAppBarElements.length) {
        const topAppBarElement = topAppBarElements[0];
        if (!topAppBarElement.scrollTarget && this.bodyRef?.value) {
          topAppBarElement.scrollTarget = this.bodyRef.value;
        }
        if (this.bodyRef?.value) {
          this.bodyRef.value.style.marginTop = '0';
        }
      }

      this.originalTrigger = document.activeElement;
      this.modalHelper?.activate();
      lockScreen(this);
      await stopAll();

      requestAnimationFrame(() => {
        const autoFocusTarget = this.querySelector('[autofocus]');
        if (autoFocusTarget) {
          autoFocusTarget.focus({ preventScroll: true });
        } else if (panel) {
          panel.focus({ preventScroll: true });
        }
      });

      const animPromises = [];

      if (overlay) {
        animPromises.push(animateTo(overlay, [
          { opacity: 0 },
          { opacity: 1 }
        ], {
          duration: hasUpdated ? (isMobile ? 240 : 200) : 0,
          easing: 'linear',
        }));
      }

      if (panel) {
        if (isMobile) {
          // 移动端：底部抽屉从下往上滑入
          animPromises.push(animateTo(panel, [
            { transform: 'translateY(100%)', opacity: 1 },
            { transform: 'translateY(0)', opacity: 1 }
          ], {
            duration: hasUpdated ? 280 : 0,
            easing: 'cubic-bezier(0.32, 0.72, 0.22, 1)',
          }));
        } else {
          // 桌面端：微升与微缩浮入
          animPromises.push(animateTo(panel, [
            { transform: 'translateY(12px) scale(0.96)', opacity: 0 },
            { transform: 'translateY(0) scale(1)', opacity: 1 }
          ], {
            duration: hasUpdated ? 220 : 0,
            easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
          }));
        }
      }

      children.forEach((child) => {
        animPromises.push(animateTo(child, [
          { opacity: 0 },
          { opacity: 1 },
        ], {
          duration: hasUpdated ? 180 : 0,
          easing: 'linear',
        }));
      });

      await Promise.all(animPromises);

      if (hasUpdated) {
        this.emit('opened');
      }
    } else {
      // ----------------- 关闭动画 -----------------
      if (this.__aimoClosing) return;
      this.__aimoClosing = true;

      try {
        const eventProceeded = this.emit('close', { cancelable: true });
        if (!eventProceeded) {
          return;
        }

        this.modalHelper?.deactivate();
        await stopAll();

        const animPromises = [];

        if (overlay) {
          animPromises.push(animateTo(overlay, [
            { opacity: 1 },
            { opacity: 0 }
          ], {
            duration: isMobile ? 220 : 180,
            easing: 'linear',
          }));
        }

        if (panel) {
          if (isMobile) {
            // 移动端：抽屉平滑顺畅向下滑出屏幕
            animPromises.push(animateTo(panel, [
              { transform: 'translateY(0)', opacity: 1 },
              { transform: 'translateY(100%)', opacity: 1 }
            ], {
              duration: 240,
              easing: 'cubic-bezier(0.32, 0.72, 0.22, 1)',
            }));
          } else {
            // 桌面端：模态框放大淡出 (scale 1 -> 1.08, opacity 1 -> 0)
            animPromises.push(animateTo(panel, [
              { transform: 'scale(1)', opacity: 1 },
              { transform: 'scale(1.08)', opacity: 0 }
            ], {
              duration: 180,
              easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
            }));
          }
        }

        await Promise.all(animPromises);

        this.style.display = 'none';
        unlockScreen(this);

        const trigger = this.originalTrigger;
        if (typeof trigger?.focus === 'function') {
          setTimeout(() => trigger.focus());
        }

        this.emit('closed');
      } finally {
        this.__aimoClosing = false;
      }
    }
  };
}
