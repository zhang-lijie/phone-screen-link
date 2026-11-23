// Preset slash commands for the chat panel. Each maps to a single, safe agent
// tool (no model call). `triggers` are matched after a leading "/" is stripped;
// latin triggers are case-insensitive. `note` is a short bilingual description
// shown in the suggestion list.

export const PRESET_COMMANDS = Object.freeze([
  { id: 'desktop', triggers: ['desktop', '回', '桌', 'home'], tool: 'press_key', args: { key: 'KEYCODE_HOME' }, note: { zh: '回到主屏幕', en: 'Go to home screen' } },
  { id: 'back', triggers: ['back', '返', '返回'], tool: 'press_back', args: {}, note: { zh: '按返回键', en: 'Press Back' } },
  { id: 'apps', triggers: ['apps', '多', '多任务', 'overview'], tool: 'press_key', args: { key: 'KEYCODE_APP_SWITCH' }, note: { zh: '打开最近应用', en: 'Open recent apps' } },
  { id: 'screenshot', triggers: ['screenshot', '截图', '截', 'shot'], tool: 'screenshot', args: {}, note: { zh: '截取当前屏幕', en: 'Take a screenshot' } },
  { id: 'power', triggers: ['power', '电源', '锁屏'], tool: 'press_key', args: { key: 'KEYCODE_POWER' }, note: { zh: '按电源键', en: 'Press Power' } },
  { id: 'volup', triggers: ['volup', '音量加', 'volumeup'], tool: 'press_key', args: { key: 'KEYCODE_VOLUME_UP' }, note: { zh: '增大音量', en: 'Volume up' } },
  { id: 'voldown', triggers: ['voldown', '音量减', 'volumedown'], tool: 'press_key', args: { key: 'KEYCODE_VOLUME_DOWN' }, note: { zh: '减小音量', en: 'Volume down' } },
  { id: 'state', triggers: ['state', '状态'], tool: 'get_phone_state', args: {}, note: { zh: '查看当前应用状态', en: 'Show phone state' } },
  { id: 'ui', triggers: ['ui', '界面', 'dump'], tool: 'dump_ui', args: {}, note: { zh: '导出界面层级', en: 'Dump UI hierarchy' } },
  { id: 'tree', triggers: ['tree', '树', '控件'], tool: 'get_screen_tree', args: {}, note: { zh: '查看屏幕控件树', en: 'Show screen tree' } },
  { id: 'list', triggers: ['list', '应用', 'apps-list'], tool: 'list_apps', args: {}, note: { zh: '列出已安装应用', en: 'List installed apps' } },
]);

const RESULT_LIMIT = 500;

// Match commands whose id or any trigger starts with the query. A leading "/"
// is optional in the query; latin comparison is case-insensitive.
export function findCommands(query) {
  const q = String(query ?? '').replace(/^\//, '').trim().toLowerCase();
  if (!q) return [...PRESET_COMMANDS];
  return PRESET_COMMANDS.filter((c) =>
    c.id.toLowerCase().startsWith(q) || c.triggers.some((t) => t.toLowerCase().startsWith(q))
  );
}

// Resolve a single command by exact id or trigger token (case-insensitive latin).
export function resolveCommand(value) {
  const q = String(value ?? '').replace(/^\//, '').trim().toLowerCase();
  if (!q) return null;
  return PRESET_COMMANDS.find((c) =>
    c.id.toLowerCase() === q || c.triggers.some((t) => t.toLowerCase() === q)
  ) ?? null;
}

// Read-only tool output can be large (UI dump / app list); keep bubbles sane.
export function truncateResult(text) {
  const str = String(text ?? '');
  if (str.length <= RESULT_LIMIT) return str;
  return `${str.slice(0, RESULT_LIMIT)}\n…[结果已截断]`;
}
