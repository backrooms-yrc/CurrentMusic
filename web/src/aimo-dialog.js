// Adapt MDUI's open/close lifecycle to Aimo's desktop dialog and mobile sheet.
import { Dialog } from 'mdui/components/dialog.js';
import { lockScreen, unlockScreen } from '@mdui/shared/helpers/scroll.js';
import { animateTo, stopAnimations } from '@mdui/shared/helpers/animate.js';

export function initAimoDialogMotion() {
  const onOpenChange = Dialog.prototype.onOpenChange;
  const transitions = new WeakMap();

  Dialog.prototype.onOpenChange = async function(...args) {
    const previous = transitions.get(this);
    if (!previous?.running && document.documentElement.getAttribute('data-ui-preset') !== 'aimo') {
      transitions.delete(this);
      return onOpenChange.apply(this, args);
    }

    const opening = this.open;
    const hasUpdated = this.hasUpdated;
    if (!opening && !hasUpdated) return;

    const transition = { running: true };
    transitions.set(this, transition);
    const isCurrent = () => this.isConnected && this.open === opening && transitions.get(this) === transition;

    try {
      await this.definedController.whenDefined();
      if (!hasUpdated) await this.updateComplete;
      if (!isCurrent()) return;

      const panel = this.panelRef.value;
      const overlay = this.overlayRef.value;
      const children = Array.from(panel.querySelectorAll('.header, .body, .actions'));
      const canAnimate = panel.animate && panel.getAnimations;
      const mobile = !this.fullscreen && matchMedia('(max-width: 860px)').matches;
      const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
      const phase = opening ? 'open' : 'close';
      if (hasUpdated && (!this.emit(phase, { cancelable: true }) || !isCurrent())) return;

      if (opening) {
        if (this.style.display !== 'flex') this.originalTrigger = document.activeElement;
        this.style.display = 'flex';
        const topAppBar = this.topAppBarElements?.[0];
        if (topAppBar) {
          if (!topAppBar.scrollTarget) topAppBar.scrollTarget = this.bodyRef.value;
          this.bodyRef.value.style.marginTop = '0';
        }
        this.modalHelper.activate();
        lockScreen(this);
        requestAnimationFrame(() => {
          if (isCurrent()) (this.querySelector('[autofocus]') || panel).focus({ preventScroll: true });
        });
      } else {
        this.modalHelper.deactivate();
      }

      if (canAnimate) {
        await Promise.all([overlay, panel, ...children].map(stopAnimations));
        if (!isCurrent()) return;
      }
      if (canAnimate && hasUpdated && !reduced) {
        panel.style.willChange = 'transform, opacity';
        overlay.style.willChange = 'opacity';

        const panelFrames = mobile
          ? [{ transform: 'translateY(100%)' }, { transform: 'translateY(0)' }]
          : opening
            ? [{ transform: 'translateY(10px) scale(.97)', opacity: 0 }, { transform: 'none', opacity: 1 }]
            : [{ transform: 'none', opacity: 1 }, { transform: 'scale(1.05)', opacity: 0 }];
        if (mobile && !opening) panelFrames.reverse();
        const fade = opening ? [{ opacity: 0 }, { opacity: 1 }] : [{ opacity: 1 }, { opacity: 0 }];
        const duration = mobile ? (opening ? 260 : 220) : (opening ? 200 : 160);
        await Promise.all([
          animateTo(panel, panelFrames, { duration, easing: mobile ? 'cubic-bezier(.32,.72,.22,1)' : 'cubic-bezier(.22,1,.36,1)' }),
          animateTo(overlay, fade, { duration, easing: 'linear' }),
        ]);

        panel.style.willChange = '';
        overlay.style.willChange = '';
        if (!isCurrent()) return;
      }

      if (!opening) {
        this.style.display = 'none';
        unlockScreen(this);
        const trigger = this.originalTrigger;
        if (typeof trigger?.focus === 'function') {
          setTimeout(() => { if (!this.open && transitions.get(this) === transition) trigger.focus(); });
        }
      }
      if (hasUpdated) this.emit(opening ? 'opened' : 'closed');
    } finally {
      transition.running = false;
    }
  };
}
