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

function applyValue(slider: HTMLInputElement, nextVal: number, fireChange: boolean): void {
  const nextStr = String(nextVal);
  const changed = slider.value !== nextStr;
  if (changed) {
    slider.value = nextStr;
    updateSliderFill(slider);
    slider.dispatchEvent(new Event('input', { bubbles: true }));
  }
  if (fireChange) {
    slider.dispatchEvent(new Event('change', { bubbles: true }));
  }
}

function bindSmartSlider(slider: HTMLInputElement): void {
  if (slider.dataset.smartBound === '1') return;
  slider.dataset.smartBound = '1';
  updateSliderFill(slider);

  slider.addEventListener('input', () => updateSliderFill(slider));

  // Prevent iOS Safari / Android Chrome native range jump on initial touch
  slider.addEventListener(
    'touchstart',
    (e) => {
      if (e.cancelable) e.preventDefault();
    },
    { passive: false },
  );

  let activePointerId: number | null = null;
  let startX = 0;
  let startY = 0;
  let startTime = 0;
  let startVal = 0;
  let hasDragged = false;
  const DRAG_DEADZONE_PX = 4;
  const QUICK_TAP_MAX_MS = 280;
  const QUICK_TAP_MAX_MOVE_PX = 7;

  const onPointerMove = (e: PointerEvent): void => {
    if (activePointerId !== e.pointerId) return;
    const dx = e.clientX - startX;
    const absDx = Math.abs(dx);

    if (!hasDragged && absDx <= DRAG_DEADZONE_PX) {
      return;
    }

    if (!hasDragged) {
      hasDragged = true;
      slider.dataset.dragging = 'true';
    }

    const rect = slider.getBoundingClientRect();
    const usableWidth = Math.max(40, rect.width - 22);
    const { min, max, step, decimals } = getSliderBounds(slider);
    const effectiveDx = dx - Math.sign(dx) * DRAG_DEADZONE_PX;
    const rawNext = startVal + (effectiveDx / usableWidth) * (max - min);
    const nextVal = snapAndClamp(rawNext, min, max, step, decimals);
    applyValue(slider, nextVal, false);
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
    const elapsed = performance.now() - startTime;
    const dist = Math.hypot(e.clientX - startX, e.clientY - startY);
    const wasDragged = hasDragged;
    cleanup(e.pointerId);

    if (!wasDragged && dist <= QUICK_TAP_MAX_MOVE_PX && elapsed < QUICK_TAP_MAX_MS) {
      // Quick tap jumps smoothly to the tapped track position
      const rect = slider.getBoundingClientRect();
      const pad = 11;
      const usableWidth = Math.max(40, rect.width - pad * 2);
      const ratio = Math.max(0, Math.min(1, (e.clientX - (rect.left + pad)) / usableWidth));
      const { min, max, step, decimals } = getSliderBounds(slider);
      const tapVal = snapAndClamp(min + ratio * (max - min), min, max, step, decimals);
      applyValue(slider, tapVal, true);
    } else if (wasDragged) {
      slider.dispatchEvent(new Event('change', { bubbles: true }));
    }
  };

  const onPointerCancel = (e: PointerEvent): void => {
    const wasDragged = hasDragged;
    cleanup(e.pointerId);
    if (wasDragged) {
      slider.dispatchEvent(new Event('change', { bubbles: true }));
    }
  };

  slider.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (slider.disabled) return;
    if (e.cancelable) e.preventDefault();

    activePointerId = e.pointerId;
    startX = e.clientX;
    startY = e.clientY;
    startTime = performance.now();
    startVal = Number(slider.value);
    hasDragged = false;

    try {
      slider.setPointerCapture(e.pointerId);
    } catch {
      // Fallback to window listeners below
    }

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
