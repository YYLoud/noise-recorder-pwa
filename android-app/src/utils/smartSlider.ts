function getSliderBounds(slider: HTMLInputElement): { min: number; max: number; step: number; decimals: number } {
  const min = slider.min === '' ? 0 : Number(slider.min);
  const max = slider.max === '' ? 100 : Number(slider.max);
  const step = slider.step === '' || slider.step === 'any' ? 1 : Number(slider.step);
  const decimals = (String(step).split('.')[1] || '').length;
  return { min, max, step, decimals };
}

function snapAndClamp(rawVal: number, min: number, max: number, step: number, decimals: number): number {
  const snapped = Math.round((rawVal - min) / step) * step + min;
  const fixed = Number(snapped.toFixed(decimals));
  return Math.max(min, Math.min(max, fixed));
}

export function updateSliderFill(slider: HTMLInputElement): void {
  const { min, max } = getSliderBounds(slider);
  const val = Number(slider.value);
  const span = max - min;
  const pct = span > 0 ? Math.max(0, Math.min(100, ((val - min) / span) * 100)) : 0;
  slider.style.setProperty('--slider-pct', `${pct.toFixed(2)}%`);
}

function bindSmartSlider(slider: HTMLInputElement): void {
  if (slider.dataset.smartBound === '1') return;
  slider.dataset.smartBound = '1';
  updateSliderFill(slider);

  let committedValue = Number(slider.value);
  let isInternalUpdate = false;
  let lastTouchAt = 0;

  let activePointerId: number | null = null;
  let startX = 0;
  let startY = 0;
  let startVal = 0;
  let direction: 'undecided' | 'horizontal' | 'vertical' = 'undecided';

  const applyValue = (nextVal: number, fireChange: boolean): void => {
    const nextStr = String(nextVal);
    const changed = slider.value !== nextStr;
    committedValue = nextVal;
    isInternalUpdate = true;
    try {
      if (changed) {
        slider.value = nextStr;
        updateSliderFill(slider);
        slider.dispatchEvent(new Event('input', { bubbles: true }));
      }
      if (fireChange) {
        slider.dispatchEvent(new Event('change', { bubbles: true }));
      }
    } finally {
      isInternalUpdate = false;
    }
  };

  // Block native browser range tap/scroll jumps unless initiated by horizontal drag
  slider.addEventListener(
    'input',
    (e) => {
      if (isInternalUpdate) return;
      const recentTouch = activePointerId !== null || performance.now() - lastTouchAt < 700;
      if (recentTouch) {
        slider.value = String(committedValue);
        updateSliderFill(slider);
        e.stopImmediatePropagation();
        return;
      }
      committedValue = Number(slider.value);
      updateSliderFill(slider);
    },
    true,
  );

  slider.addEventListener(
    'change',
    (e) => {
      if (isInternalUpdate) return;
      const recentTouch = activePointerId !== null || performance.now() - lastTouchAt < 700;
      if (recentTouch) {
        slider.value = String(committedValue);
        updateSliderFill(slider);
        e.stopImmediatePropagation();
      }
    },
    true,
  );

  slider.addEventListener(
    'touchstart',
    () => {
      lastTouchAt = performance.now();
    },
    { passive: true },
  );

  const onPointerMove = (e: PointerEvent): void => {
    if (activePointerId !== e.pointerId) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    const absDx = Math.abs(dx);
    const absDy = Math.abs(dy);

    if (direction === 'undecided') {
      if (e.pointerType !== 'mouse' && absDy > 7 && absDy >= absDx * 0.85) {
        direction = 'vertical';
        cleanup(e.pointerId);
        return;
      }
      const horizThresh = e.pointerType === 'mouse' ? 3 : 10;
      if (absDx > horizThresh && absDx > absDy * 1.4) {
        direction = 'horizontal';
        slider.dataset.dragging = 'true';
        try {
          slider.setPointerCapture(e.pointerId);
        } catch {
          // Fallback to window listeners
        }
      } else {
        return;
      }
    }

    if (direction !== 'horizontal') return;

    const horizThresh = e.pointerType === 'mouse' ? 3 : 10;
    const rect = slider.getBoundingClientRect();
    const usableWidth = Math.max(40, rect.width - 22);
    const { min, max, step, decimals } = getSliderBounds(slider);
    const effectiveDx = dx - Math.sign(dx) * horizThresh;
    const rawNext = startVal + (effectiveDx / usableWidth) * (max - min);
    const nextVal = snapAndClamp(rawNext, min, max, step, decimals);
    applyValue(nextVal, false);
  };

  const cleanup = (pointerId: number): void => {
    if (activePointerId !== pointerId) return;
    activePointerId = null;
    delete slider.dataset.dragging;
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    window.removeEventListener('pointercancel', onPointerCancel);
    try {
      if (slider.hasPointerCapture(pointerId)) {
        slider.releasePointerCapture(pointerId);
      }
    } catch {
      // Ignore capture release errors
    }
  };

  const onPointerUp = (e: PointerEvent): void => {
    if (activePointerId !== e.pointerId) return;
    const wasHorizontal = direction === 'horizontal';
    cleanup(e.pointerId);
    if (wasHorizontal) {
      applyValue(committedValue, true);
    }
  };

  const onPointerCancel = (e: PointerEvent): void => {
    if (activePointerId !== e.pointerId) return;
    const wasHorizontal = direction === 'horizontal';
    cleanup(e.pointerId);
    if (wasHorizontal) {
      applyValue(committedValue, true);
    }
  };

  slider.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (slider.disabled) return;
    if (e.pointerType !== 'mouse') {
      lastTouchAt = performance.now();
    }

    committedValue = Number(slider.value);
    activePointerId = e.pointerId;
    startX = e.clientX;
    startY = e.clientY;
    startVal = committedValue;
    direction = 'undecided';

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerCancel);
  });
}

export function initSmartSliders(root: ParentNode = document): void {
  root.querySelectorAll<HTMLInputElement>('input[type="range"]').forEach((slider) => {
    bindSmartSlider(slider);
  });
}
