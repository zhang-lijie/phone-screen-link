// Pure helpers for the browser's device picker. Kept in a module so the
// timing rules can be tested without a DOM.

// Restore the browser's remembered choice once that phone actually appears.
// An empty first poll (adb still downloading, phone not plugged in yet) must
// not consume the single restore attempt.
export function restoreSerial({ remembered, devices = [], selected, attempted } = {}) {
  if (!remembered || remembered === selected || attempted === remembered) return null;
  return devices.some((device) => device.serial === remembered && device.selectable)
    ? remembered
    : null;
}

// A stream start scheduled 250ms earlier may be stale: the user may have
// switched phones or unselected all of them in the meantime.
export function canStartStream({ serial, gen, currentSerial, currentGen } = {}) {
  return Boolean(serial) && serial === currentSerial && gen === currentGen;
}


// Fit a canvas into the available box without changing its aspect ratio.
// The video and touch canvases must receive the same result so touch
// coordinates keep mapping onto the visible picture.
export function fitCanvasSize({ width, height, availableWidth, availableHeight } = {}) {
  const w = Number(width);
  const h = Number(height);
  const aw = Number(availableWidth);
  const ah = Number(availableHeight);
  if (![w, h, aw, ah].every(Number.isFinite) || w <= 1 || h <= 1 || aw <= 0 || ah <= 0) return null;
  const scale = Math.min(aw / w, ah / h);
  const fittedWidth = Math.floor(w * scale);
  const fittedHeight = Math.floor(h * scale);
  if (fittedWidth < 1 || fittedHeight < 1) return null;
  return { width: fittedWidth, height: fittedHeight };
}
