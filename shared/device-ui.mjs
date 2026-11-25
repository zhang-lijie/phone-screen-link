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
