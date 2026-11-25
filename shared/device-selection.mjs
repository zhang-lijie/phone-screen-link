// Which phone the bridge should drive. Pure so the policy can be tested
// without an adb process, a server, or a browser.
//
// Priority: the current selection (while it is still there), the browser's
// remembered choice, the installer's preferred serial, then the only
// authorised device. With two or more candidates and no prior choice, return
// null and let the user decide.
export function chooseDevice({ devices = [], selected, remembered, preferred } = {}) {
  const selectable = devices.filter((device) => device.selectable).map((device) => device.serial);
  for (const candidate of [selected, remembered, preferred]) {
    if (candidate && selectable.includes(candidate)) return candidate;
  }
  return selectable.length === 1 ? selectable[0] : null;
}
