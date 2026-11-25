import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as keys from '../shared/keys.mjs';
import * as chatCommands from '../shared/chat-commands.mjs';

class ClassList {
  constructor() {
    this.values = new Set();
  }

  add(...names) {
    for (const name of names) this.values.add(name);
  }

  remove(...names) {
    for (const name of names) this.values.delete(name);
  }

  contains(name) {
    return this.values.has(name);
  }

  toggle(name, force) {
    const enabled = force === undefined ? !this.contains(name) : Boolean(force);
    if (enabled) this.add(name);
    else this.remove(name);
    return enabled;
  }
}

class Element {
  constructor(tagName = 'div', document = null) {
    this.tagName = tagName.toUpperCase();
    this.ownerDocument = document;
    this.attributes = new Map();
    this.dataset = {};
    this.children = [];
    this.listeners = new Map();
    this.classList = new ClassList();
    this.style = {
      values: new Map(),
      setProperty(name, value) { this.values.set(name, value); },
      removeProperty(name) { this.values.delete(name); },
    };
    this.value = '';
    this.checked = false;
    this.disabled = false;
    this.hidden = false;
    this.textContent = '';
    this.innerHTML = '';
    this.title = '';
    this.type = '';
    this.isConnected = true;
    this.focusCount = 0;
    this.scrollTop = 0;
    this.scrollHeight = 0;
    this.previousElementSibling = null;
    this.classChildren = new Map();
  }

  set className(value) {
    this.classList.values = new Set(String(value).split(/\s+/).filter(Boolean));
  }

  get className() {
    return [...this.classList.values].join(' ');
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (name === 'class') this.className = value;
    if (name === 'disabled') this.disabled = true;
    if (name === 'hidden') this.hidden = true;
    if (name.startsWith('data-')) {
      this.dataset[name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = String(value);
    }
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }

  async dispatch(type, event = {}) {
    const results = [];
    for (const listener of this.listeners.get(type) ?? []) {
      results.push(await listener({ type, target: this, ...event }));
    }
    return results;
  }

  async click() {
    if (this.disabled) return;
    await this.dispatch('click');
  }

  focus() {
    this.ownerDocument.activeElement = this;
    this.focusCount += 1;
  }

  contains(element) {
    for (let current = element; current; current = current.parentElement) {
      if (current === this) return true;
    }
    return false;
  }

  querySelector(selector) {
    if (selector.startsWith('.')) return this.classChildren.get(selector.slice(1)) ?? null;
    return null;
  }

  querySelectorAll() {
    return [];
  }

  appendChild(child) {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  append(...children) {
    for (const child of children) this.appendChild(child);
  }

  replaceChildren(...children) {
    this.children = [];
    this.append(...children);
  }

  remove() {
    if (this.parentElement) {
      this.parentElement.children = this.parentElement.children.filter((child) => child !== this);
      this.parentElement = null;
    }
    this.isConnected = false;
  }

  getClientRects() {
    return [{}];
  }

  getBoundingClientRect() {
    return { left: 0, top: 0, width: 380, height: 600 };
  }

  setPointerCapture() {}
  scrollIntoView() {}
}

export function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: (key) => data.delete(key),
  };
}

export function response(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 409 ? 'Conflict' : '',
    json: async () => payload,
  };
}

export function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function flush() {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
}

function stripImports(source) {
  return source.replace(/^import\s+[\s\S]*?from\s+['"][^'"]+['"];\s*/gm, '');
}

export async function loadWirelessApp({
  html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8'),
  app = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8'),
  storage = memoryStorage(),
  fetchImpl,
  autoResponse = null,
  usbOnline = true,
} = {}) {
  const document = {
    activeElement: null,
    fullscreenElement: null,
    listeners: new Map(),
    getElementById(id) { return this.elements.get(id) ?? null; },
    querySelectorAll() { return []; },
    createElement(tagName) { return new Element(tagName, this); },
    createTreeWalker() { return { nextNode: () => false }; },
    addEventListener(type, listener) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(listener);
    },
  };
  document.elements = new Map();
  document.documentElement = new Element('html', document);
  document.body = new Element('body', document);
  document.activeElement = document.body;

  for (const match of html.matchAll(/<([a-z][a-z0-9-]*)\b([^>]*\bid="([^"]+)"[^>]*)>/gi)) {
    const [, tagName, attributeText, id] = match;
    const element = new Element(tagName, document);
    document.elements.set(id, element);
    const classMatch = /\bclass="([^"]*)"/.exec(attributeText);
    if (classMatch) element.className = classMatch[1];
    if (/\sdisabled(?:\s|=|$)/.test(attributeText)) element.disabled = true;
    if (/\shidden(?:\s|=|$)/.test(attributeText)) element.hidden = true;
    const valueMatch = /\bvalue="([^"]*)"/.exec(attributeText);
    if (valueMatch) element.value = valueMatch[1];
    if (/\schecked(?:\s|=|$)/.test(attributeText)) element.checked = true;
    for (const dataMatch of attributeText.matchAll(/\bdata-([a-z0-9-]+)="([^"]*)"/g)) {
      element.setAttribute(`data-${dataMatch[1]}`, dataMatch[2]);
    }
    if (classMatch) {
      for (const className of classMatch[1].split(/\s+/).filter(Boolean)) {
        element.classChildren.set(className, element);
      }
    }
  }

  const wirelessPanel = new Element('section', document);
  wirelessPanel.className = 'wireless-panel';
  document.getElementById('wireless-overlay').classChildren.set('wireless-panel', wirelessPanel);
  const chatHead = new Element('div', document);
  chatHead.className = 'chat-head';
  document.getElementById('chat-panel').classChildren.set('chat-head', chatHead);

  const requests = [];
  const defaultFetch = async (url, options = {}) => {
    requests.push({ url, options });
    if (url.endsWith('/api/chat-config')) return response(200, { enabled: false });
    if (url.endsWith('/api/wireless')) {
      return response(200, { mode: 'usb', serial: 'USB123456', online: true, usbOnline });
    }
    if (url.endsWith('/api/wireless/auto')) {
      if (autoResponse === null) throw new Error('unexpected auto-fetch request');
      return typeof autoResponse === 'function' ? autoResponse() : autoResponse;
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  const context = vm.createContext({
    ...keys,
    ...chatCommands,
    console,
    document,
    navigator: { language: 'en-US' },
    localStorage: storage,
    location: { protocol: 'http:', hostname: '127.0.0.1' },
    screen: { availWidth: 1920, availHeight: 1080, width: 1920, height: 1080 },
    innerWidth: 1280,
    innerHeight: 800,
    NodeFilter: { SHOW_TEXT: 4 },
    HTMLElement: Element,
    MutationObserver: class { observe() {} },
    getComputedStyle: () => ({ columnGap: '0px' }),
    fetch: fetchImpl ?? defaultFetch,
    setInterval: () => 1,
    clearInterval: () => {},
    setTimeout: () => 1,
    clearTimeout: () => {},
  });
  context.window = context;
  context.addEventListener = (type, listener) => document.addEventListener(type, listener);
  context.resizeTo = () => {};
  document.documentElement.requestFullscreen = async () => {};
  document.exitFullscreen = async () => {};

  const source = `${stripImports(app)}\nglobalThis.__wirelessTest = {
    openWireless,
    closeWireless,
    autoFetchWireless,
    refreshWirelessStatus,
    applyWirelessStatus,
    readWirelessForm,
    fields: wirelessFields,
    form: wirelessForm,
    buttons: { auto: wirelessAuto, submit: wirelessSubmit, usb: wirelessUsb, clear: wirelessClear },
    feedback: wirelessFeedbackEl,
    warning: wirelessWarning,
  };`;
  vm.runInContext(source, context, { filename: 'web/app.js' });
  await flush();
  const api = context.__wirelessTest;
  api.readWirelessForm = () => Object.fromEntries(
    keys.WIRELESS_PAIRING_FIELDS.map((field) => [field, api.fields[field].value]),
  );

  return {
    document,
    storage,
    requests,
    api,
    async ready() {
      await flush();
      return this;
    },
  };
}
