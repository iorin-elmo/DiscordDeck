(() => {
'use strict';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
let state;
let panelKey = '';
let navKey = '';
let editId = null;
let toastTimer;
let boundsFrame;
let submitting = false;
let selectedAvatar = null;
let navigationId = null;
let navigationKey = '';
let lastPage = { start: 0, capacity: 2 };
const accountDialog = $('#account-dialog');
const helpDialog = $('#help-dialog');
const navigationDialog = $('#navigation-dialog');
const settingsDialog = $('#settings-dialog');
const credentialsDialog = $('#credentials-dialog');
let credentialsId = null;
let credentialsBusy = false;
let credentialsEditing = false;
let settingsBusy = false;
let displayedFullscreen;
let scanGeneration = 0;
let scanStream;
let audioDevices = [];
const deck = $('#deck');

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#i-${name}`); svg.append(use); svg.setAttribute('aria-hidden', 'true');
  return svg;
}
function iconButton(name, title, callback) {
  const button = element('button', 'icon-button');
  button.type = 'button'; button.title = title; button.setAttribute('aria-label', title);
  button.append(icon(name)); button.addEventListener('click', callback);
  return button;
}
function notice(message) {
  clearTimeout(toastTimer); $('#toast').textContent = message; $('#toast').hidden = false;
  toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 6500);
}

async function command(value, showError = true) {
  try {
    const result = await window.deck.command(value);
    if (!result.ok) { if (showError) notice(result.error); return result; }
    render(result.state);
    return result;
  } catch {
    const result = { ok: false, error: 'アプリと通信できませんでした。再起動してください。' };
    if (showError) notice(result.error);
    return result;
  }
}

function reportBounds() {
  cancelAnimationFrame(boundsFrame);
  boundsFrame = requestAnimationFrame(() => {
    if (state?.privacyHidden || $('dialog[open]')) { window.deck.setBounds([]); return; }
    const bounds = $$('.panel-body', deck).map((body) => {
      const rect = body.getBoundingClientRect();
      return { id: body.closest('.panel').dataset.id, x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    });
    window.deck.setBounds(bounds);
  });
}

function initials(name) { return [...name].slice(0, 2).join(''); }

function parseColor(value) {
  const match = value.trim().match(/^#?([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (!match) return null;
  const hex = match[1].toLowerCase();
  return `#${hex.length === 3 ? [...hex].map((c) => c + c).join('') : hex}`;
}

function applyAccent(node, color) {
  const hex = parseColor(color) || '#8b91ff';
  const rgb = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
  node.style.setProperty('--account-accent', hex);
  node.style.setProperty('--account-tint', `rgba(${rgb.join(',')},0.18)`);
  node.style.setProperty('--account-stroke', `rgba(${rgb.join(',')},0.55)`);
  node.style.setProperty('--account-halo', `rgba(${rgb.join(',')},0.15)`);
  node.style.setProperty('--account-ink', rgb[0] * 0.299 + rgb[1] * 0.587 + rgb[2] * 0.114 >= 80 ? hex : '#e2e8f4');
}

function previewColor(value, normalizeInput = true) {
  const color = parseColor(value);
  if (!color) return false;
  if (normalizeInput) $('#account-color-code').value = color;
  $('#account-color').value = color;
  for (const radio of $$('input[name=color]')) radio.checked = radio.value === color;
  applyAccent($('#color-preview'), color);
  return true;
}

function renderAvatar(node, entry, custom = entry.avatar) {
  const source = custom || entry.discordAvatar || '';
  const key = `${source}|${entry.name}`;
  if (node.dataset.avatar === key) return;
  node.dataset.avatar = key;
  const fallback = element('span', 'avatar-initials', initials(entry.name));
  node.replaceChildren(fallback);
  if (source) {
    const image = element('img', 'avatar-image'); image.alt = ''; image.referrerPolicy = 'no-referrer'; image.draggable = false;
    image.addEventListener('load', () => { fallback.hidden = true; });
    image.addEventListener('error', () => { image.remove(); fallback.hidden = false; });
    image.src = source; node.append(image);
  }
}

function moveAccount(id, direction) {
  const index = state.accounts.findIndex((a) => a.id === id);
  const target = state.accounts[index + direction];
  if (target) return command({ type: 'reorder', id, targetId: target.id, placement: direction < 0 ? 'before' : 'after' });
}

function makePanel(entry) {
  const panel = element('article', 'panel'); panel.dataset.id = entry.id;
  applyAccent(panel, entry.color);
  panel.setAttribute('aria-label', `${entry.name}の列`);
  const header = element('div', 'panel-header');
  const identity = element('div', 'panel-identity');
  const badge = element('span', 'account-badge'); renderAvatar(badge, entry);
  const name = element('div', 'panel-name'); name.append(element('b', '', entry.name));
  const actions = element('div', 'panel-actions');
  actions.append(
    iconButton('refresh', `${entry.name}を再読み込み`, () => command({ type: 'reload', id: entry.id })),
    iconButton('focus', `${entry.name}を単独表示・解除`, () => command({ type: 'focus', id: entry.id })),
    iconButton('more', `${entry.name}の設定`, () => openAccount(entry.id)),
  );
  identity.append(iconButton('menu', `${entry.name}のサーバー・DMメニュー`, () => openNavigation(entry.id)), badge, name);
  header.append(identity, element('span', 'panel-context', entry.channelTitle || 'Discord'), actions);
  const body = element('div', 'panel-body');
  const placeholder = element('div', 'page-placeholder');
  placeholder.append(element('div', 'spinner'), element('p', 'placeholder-message', 'Discordを開いています…'));
  const retry = element('button', 'button secondary', '再読み込み'); retry.hidden = true;
  retry.addEventListener('click', () => command({ type: 'reload', id: entry.id })); placeholder.append(retry); body.append(placeholder);
  panel.append(header, body);
  return panel;
}

function render(next) {
  if (settingsDialog.open && displayedFullscreen !== next.settings.fullscreen) $('#settings-fullscreen').checked = next.settings.fullscreen;
  displayedFullscreen = next.settings.fullscreen;
  state = next;
  renderUpdates();
  if (accountDialog.open) updateCredentialStatus();
  document.body.classList.toggle('privacy-hidden', state.privacyHidden === true);
  $('#privacy-screen').hidden = state.privacyHidden !== true;
  const accounts = state.accounts;
  const activeIndex = Math.max(0, accounts.findIndex((a) => a.id === state.activeId));
  const capacity = state.mode === 'focus' ? 1 : state.mode === 'grid' ? 4 : state.columnCount;
  const start = Math.floor(activeIndex / capacity) * capacity;
  lastPage = { start, capacity };
  const visible = accounts.slice(start, start + capacity);
  $('#welcome').hidden = accounts.length > 0; deck.hidden = accounts.length === 0;
  for (const button of $$('[data-layout]')) {
    const selected = button.dataset.layout === state.mode && (state.mode !== 'columns' || Number(button.dataset.columns) === state.columnCount);
    button.classList.toggle('selected', selected); button.setAttribute('aria-pressed', String(selected));
  }
  for (const button of [$('#rail-add'), $('#welcome-add')]) button.disabled = accounts.length >= state.maxAccounts;
  const nextNavKey = JSON.stringify(accounts.map((a) => [a.id, a.name, a.color, a.avatar, a.discordAvatar]));
  if (nextNavKey !== navKey) {
    navKey = nextNavKey;
    const buttons = accounts.map((entry) => {
      const button = element('button', 'account-nav');
      const avatar = element('span', 'nav-avatar'); renderAvatar(avatar, entry);
      const badge = element('span', 'unread-badge'); badge.hidden = true; badge.setAttribute('aria-hidden', 'true');
      button.append(avatar, badge);
      button.title = entry.name; button.dataset.id = entry.id; button.setAttribute('aria-label', `${entry.name}を表示`); applyAccent(button, entry.color);
      button.addEventListener('click', () => command({ type: 'activate', id: entry.id }));
      button.draggable = true;
      button.addEventListener('dragstart', (event) => {
        event.dataTransfer.setData('application/x-discorddeck-account', entry.id); event.dataTransfer.effectAllowed = 'move'; button.classList.add('dragging');
      });
      button.addEventListener('dragend', () => { for (const item of $$('.account-nav')) item.classList.remove('dragging', 'drop-target'); });
      button.addEventListener('dragover', (event) => {
        if (!event.dataTransfer.types.includes('application/x-discorddeck-account')) return;
        event.preventDefault(); event.dataTransfer.dropEffect = 'move'; button.classList.add('drop-target');
      });
      button.addEventListener('dragleave', () => button.classList.remove('drop-target'));
      button.addEventListener('drop', (event) => {
        event.preventDefault(); button.classList.remove('drop-target');
        const id = event.dataTransfer.getData('application/x-discorddeck-account');
        if (!state.accounts.some((a) => a.id === id) || id === entry.id) return;
        const rect = button.getBoundingClientRect();
        command({ type: 'reorder', id, targetId: entry.id, placement: event.clientY > rect.top + rect.height / 2 ? 'after' : 'before' });
      });
      button.addEventListener('keydown', (event) => {
        if (event.altKey && ['ArrowUp', 'ArrowDown'].includes(event.key)) { event.preventDefault(); moveAccount(entry.id, event.key === 'ArrowUp' ? -1 : 1); }
      });
      return button;
    });
    $('#accounts-nav').replaceChildren(...buttons);
  }
  for (const button of $$('.account-nav')) {
    const entry = accounts.find((a) => a.id === button.dataset.id);
    const selected = button.dataset.id === state.activeId;
    button.classList.toggle('active', selected); button.setAttribute('aria-current', selected ? 'true' : 'false');
    const badge = $('.unread-badge', button);
    badge.hidden = !entry.hasUnread && !entry.unreadCount;
    badge.classList.toggle('dot', !entry.unreadCount);
    badge.textContent = entry.unreadCount ? (entry.unreadCount > 99 ? '99+' : String(entry.unreadCount)) : '';
    const unread = badge.hidden ? '' : `・未読${entry.unreadCount ? ` ${entry.unreadCount}件` : 'あり'}`;
    button.title = `${entry.name}${unread}（ドラッグで並べ替え）`; button.setAttribute('aria-description', unread || '未読なし');
  }
  const nextPanelKey = JSON.stringify([state.mode, state.columnCount, visible.map((a) => [a.id, a.name, a.color])]);
  if (nextPanelKey !== panelKey) {
    panelKey = nextPanelKey;
    deck.className = `deck ${state.mode === 'grid' ? 'grid' : state.mode === 'focus' ? 'focus' : state.columnCount === 3 ? 'three' : ''}${state.mode === 'grid' && visible.length <= 2 ? ' single-row' : ''}`;
    deck.replaceChildren(...visible.map(makePanel));
  }
  for (const panel of $$('.panel', deck)) {
    const entry = accounts.find((a) => a.id === panel.dataset.id);
    const failed = ['error', 'crashed'].includes(entry.status);
    panel.classList.toggle('active', entry.id === state.activeId);
    renderAvatar($('.account-badge', panel), entry);
    panel.dataset.status = entry.status;
    $('.spinner', panel).hidden = failed;
    $('.placeholder-message', panel).textContent = failed ? 'Discordを表示できませんでした。インターネット接続を確認して、再読み込みしてください。' : 'Discordを開いています…';
    $('.page-placeholder .button', panel).hidden = !failed;
    const context = $('.panel-context', panel);
    context.textContent = entry.channelTitle || 'Discord'; context.title = entry.channelTitle || 'Discord';
  }
  $('#pager').hidden = accounts.length <= capacity;
  $('#page-label').textContent = `${start + 1}–${Math.min(start + capacity, accounts.length)} / ${accounts.length}`;
  $('#previous-page').disabled = start === 0;
  $('#next-page').disabled = start + capacity >= accounts.length;
  if (editId && accountDialog.open) {
    const index = accounts.findIndex((a) => a.id === editId);
    if (accounts[index]) renderAvatar($('#avatar-preview'), accounts[index], selectedAvatar);
    if (accounts[index]) updateZoom(accounts[index]);
    $('#move-up').disabled = submitting || index <= 0;
    $('#move-down').disabled = submitting || index < 0 || index === accounts.length - 1;
  }
  if (navigationDialog.open) renderNavigation();
  reportBounds();
}

function updateZoom(entry) {
  $('#settings-zoom').textContent = `${Math.round(entry.zoom * 100)}%`;
  $('#zoom-out').disabled = submitting || entry.zoom <= 0.5;
  $('#zoom-in').disabled = submitting || entry.zoom >= 1.25;
}

function renderNavigation() {
  const entry = state.accounts.find((a) => a.id === navigationId);
  if (!entry) { closeDialog(navigationDialog); return; }
  const query = $('#navigation-search').value.trim().toLocaleLowerCase();
  const items = (entry.navigation || []).filter((item) => item.kind !== 'dm' && item.label.toLocaleLowerCase().includes(query));
  const key = JSON.stringify([entry.id, items, query]);
  if (navigationKey === key) return;
  navigationKey = key;
  $('#navigation-title').textContent = `${entry.name}：サーバー / DM`;
  const kinds = { home: 'DM一覧', guild: 'サーバー', dm: 'DM', folder: 'フォルダを開く' };
  const rows = items.map((item) => {
    const button = element('button', 'navigation-item'); button.type = 'button';
    button.setAttribute('aria-label', `${item.label}へ移動`);
    const avatar = element('span', 'navigation-icon');
    if (item.kind === 'home') { avatar.classList.add('mail-icon'); avatar.append(icon('mail')); }
    else renderAvatar(avatar, { name: item.label, avatar: null, discordAvatar: item.icon });
    const text = element('span', 'navigation-item-text'); text.append(element('b', '', item.label), element('small', '', kinds[item.kind] || ''));
    button.append(avatar, text);
    button.addEventListener('click', async () => {
      button.disabled = true;
      const result = await command({ type: 'navigate', id: entry.id, key: item.key });
      if (result.ok && item.kind !== 'folder') closeDialog(navigationDialog);
      button.disabled = false;
    });
    return button;
  });
  if (!rows.length) rows.push(element('p', 'navigation-empty', query ? '該当する移動先がありません。' : '移動先を取得できていません。下のボタンでDiscordの元の一覧を表示できます。'));
  $('#navigation-list').replaceChildren(...rows);
}

function openNavigation(id) {
  navigationId = id; navigationKey = ''; $('#navigation-search').value = '';
  renderNavigation(); openDialog(navigationDialog); $('#navigation-search').focus();
}

function openDialog(dialog) {
  window.deck.setModal(true); window.deck.setBounds([]); dialog.showModal();
}
function closeDialog(dialog) {
  if (submitting || settingsBusy || credentialsBusy) return;
  dialog.close();
}
for (const dialog of $$('dialog')) {
  dialog.addEventListener('close', () => { window.deck.setModal(Boolean($('dialog[open]'))); reportBounds(); });
  dialog.addEventListener('cancel', (event) => { if (submitting || settingsBusy || credentialsBusy) event.preventDefault(); });
  for (const button of $$('[data-close]', dialog)) button.addEventListener('click', () => closeDialog(dialog));
}

function openAccount(id = null) {
  editId = id;
  const editing = id !== null;
  const entry = state.accounts.find((a) => a.id === id);
  $('#account-form').hidden = false; $('#remove-confirmation').hidden = true;
  $('#dialog-title').textContent = editing ? 'アカウントの設定' : 'アカウントを追加';
  $('#dialog-description').textContent = editing ? 'この列の表示名と通知を調整できます。' : '見分けやすい名前を付けて、Discordにログインしましょう。';
  $('#account-name').value = entry?.name ?? '';
  $('#account-muted').checked = entry?.muted ?? false;
  $('#account-notifications').checked = entry?.notifications ?? false;
  $('#account-microphone').checked = entry?.microphone !== false;
  $('#account-camera').checked = entry?.camera === true;
  $('#account-compact-header').checked = entry?.compactHeader !== false;
  $('#account-compact-servers').checked = entry?.compactServers !== false;
  updateCredentialStatus();
  if (entry) updateZoom(entry);
  selectedAvatar = entry?.avatar ?? null;
  if (entry) renderAvatar($('#avatar-preview'), entry, selectedAvatar);
  $('#edit-options').hidden = !editing; $('#add-note').hidden = editing; $('#remove-account').hidden = !editing;
  $('#save-account').textContent = editing ? '変更を保存' : '追加してログイン';
  $('#form-error').textContent = ''; $('#remove-error').textContent = '';
  const colors = state.colors.map((color, i) => {
    const option = element('label', 'color-option');
    const radio = element('input'); radio.type = 'radio'; radio.name = 'color'; radio.value = color;
    radio.setAttribute('aria-label', `アクセントカラー ${i + 1}`); radio.checked = color === entry?.color;
    const dot = element('span', 'color-dot'); dot.style.backgroundColor = color;
    radio.addEventListener('change', () => previewColor(color));
    option.append(radio, dot); return option;
  });
  $('#color-picker').replaceChildren(...colors);
  previewColor(entry?.color || state.colors[0]);
  openDialog(accountDialog);
  $('#move-up').disabled = !editing || state.accounts.findIndex((a) => a.id === id) === 0;
  $('#move-down').disabled = !editing || state.accounts.findIndex((a) => a.id === id) === state.accounts.length - 1;
  $('#account-name').focus();
}

function setSubmitting(value) {
  submitting = value;
  for (const button of $$('button', accountDialog)) button.disabled = value;
  if (!value && editId) {
    const index = state.accounts.findIndex((a) => a.id === editId);
    $('#move-up').disabled = index <= 0;
    $('#move-down').disabled = index < 0 || index === state.accounts.length - 1;
    if (index >= 0) updateZoom(state.accounts[index]);
  }
}

$('#account-form').addEventListener('submit', async (event) => {
  event.preventDefault(); if (submitting) return;
  const color = parseColor($('#account-color-code').value);
  if (editId && !color) { $('#form-error').textContent = 'カラーコードは #RRGGBB または #RGB で指定してください。'; return; }
  setSubmitting(true);
  const value = { type: editId ? 'update' : 'add', name: $('#account-name').value };
  if (editId) Object.assign(value, { id: editId, color, muted: $('#account-muted').checked, notifications: $('#account-notifications').checked, microphone: $('#account-microphone').checked, camera: $('#account-camera').checked, compactHeader: $('#account-compact-header').checked, compactServers: $('#account-compact-servers').checked, avatar: selectedAvatar });
  const result = await command(value, false);
  setSubmitting(false);
  if (result.ok) { closeDialog(accountDialog); notice(editId ? '設定を保存しました。' : '列を追加しました。Discordの画面でログインしてください。'); }
  else $('#form-error').textContent = result.error;
});
function credentialStatus(entry) {
  if (entry?.credentialsError) return '保存情報を読み込めません。';
  if (!entry?.credentialsSaved) return '未保存';
  return entry.autofillEnabled ? '保存済み・自動入力ON' : '保存済み・自動入力OFF';
}
function updateCredentialStatus() { $('#account-credentials-status').textContent = credentialStatus(state.accounts.find((a) => a.id === editId)); }
function clearCredentialInputs() { $('#login-email').value = ''; $('#login-password').value = ''; }
function showCredentialForm() {
  const entry = state.accounts.find((a) => a.id === credentialsId);
  $('#credentials-title').textContent = `${entry?.name || ''}のログイン情報`;
  $('#credentials-status').textContent = credentialStatus(entry);
  $('#credentials-fields').hidden = !credentialsEditing;
  for (const input of $$('#credentials-fields input')) { input.disabled = !credentialsEditing; input.required = credentialsEditing; }
  $('#change-credentials').hidden = !entry?.credentialsSaved || credentialsEditing;
  $('#delete-credentials').hidden = !entry?.credentialsSaved;
  $('#save-credentials').textContent = credentialsEditing ? (entry?.credentialsSaved ? '変更を保存' : '保存') : '設定を保存';
}
function setCredentialBusy(value) {
  credentialsBusy = value;
  for (const control of $$('button,input', credentialsDialog)) control.disabled = value;
  if (!value) showCredentialForm();
}
$('#manage-credentials').addEventListener('click', () => {
  credentialsId = editId;
  const entry = state.accounts.find((a) => a.id === credentialsId);
  clearCredentialInputs(); credentialsEditing = !entry?.credentialsSaved;
  $('#credentials-enabled').checked = entry?.credentialsSaved ? entry.autofillEnabled : true;
  $('#credentials-error').textContent = '';
  showCredentialForm(); openDialog(credentialsDialog);
});
$('#change-credentials').addEventListener('click', () => {
  credentialsEditing = true; clearCredentialInputs(); showCredentialForm(); $('#login-email').focus();
});
credentialsDialog.addEventListener('close', () => { clearCredentialInputs(); credentialsId = null; });
$('#credentials-form').addEventListener('submit', async (event) => {
  event.preventDefault(); if (credentialsBusy) return;
  const payload = { type: 'credentials-save', id: credentialsId, enabled: $('#credentials-enabled').checked, email: credentialsEditing ? $('#login-email').value : '', password: credentialsEditing ? $('#login-password').value : '' };
  clearCredentialInputs(); setCredentialBusy(true);
  const result = await command(payload, false);
  payload.email = ''; payload.password = '';
  if (result.ok) credentialsEditing = false;
  setCredentialBusy(false);
  $('#credentials-error').textContent = result.ok ? '' : result.error;
  if (result.ok) $('#credentials-status').textContent = '保存しました。' + credentialStatus(state.accounts.find((a) => a.id === credentialsId));
});
$('#delete-credentials').addEventListener('click', async () => {
  if (credentialsBusy) return;
  clearCredentialInputs(); setCredentialBusy(true);
  const result = await command({ type: 'credentials-delete', id: credentialsId }, false);
  if (result.ok) credentialsEditing = true;
  setCredentialBusy(false);
  $('#credentials-error').textContent = result.ok ? '' : result.error;
  if (result.ok) $('#credentials-status').textContent = '保存したログイン情報を削除しました。';
});
$('#remove-account').addEventListener('click', () => { $('#account-form').hidden = true; $('#remove-confirmation').hidden = false; $('#cancel-remove').focus(); });
$('#cancel-remove').addEventListener('click', () => { $('#account-form').hidden = false; $('#remove-confirmation').hidden = true; });
$('#choose-avatar').addEventListener('click', async () => {
  if (submitting) return;
  setSubmitting(true);
  const result = await command({ type: 'choose-avatar', id: editId }, false);
  setSubmitting(false);
  if (result.ok && !result.canceled) { selectedAvatar = result.avatar; renderAvatar($('#avatar-preview'), state.accounts.find((a) => a.id === editId), selectedAvatar); }
  else if (!result.ok) $('#form-error').textContent = result.error;
});
$('#reset-avatar').addEventListener('click', () => { selectedAvatar = null; renderAvatar($('#avatar-preview'), state.accounts.find((a) => a.id === editId), null); });
$('#move-up').addEventListener('click', () => moveAccount(editId, -1));
$('#move-down').addEventListener('click', () => moveAccount(editId, 1));
$('#account-color').addEventListener('input', (event) => previewColor(event.target.value));
$('#account-color-code').addEventListener('input', (event) => previewColor(event.target.value, false));
$('#account-color-code').addEventListener('blur', (event) => previewColor(event.target.value));
for (const [selector, delta] of [['#zoom-out', -0.05], ['#zoom-in', 0.05]]) $(selector).addEventListener('click', () => {
  const entry = state.accounts.find((a) => a.id === editId);
  if (entry) command({ type: 'zoom', id: entry.id, zoom: entry.zoom + delta });
});
$('#zoom-reset').addEventListener('click', () => command({ type: 'zoom', id: editId, zoom: 0.8 }));
$('#navigation-search').addEventListener('input', () => renderNavigation());
$('#restore-discord-ui').addEventListener('click', async () => {
  const result = await command({ type: 'appearance', id: navigationId, compactHeader: false, compactServers: false });
  if (result.ok) closeDialog(navigationDialog);
});
$('#confirm-remove').addEventListener('click', async () => {
  if (submitting) return;
  setSubmitting(true);
  const result = await command({ type: 'remove', id: editId }, false);
  setSubmitting(false);
  if (result.ok) { closeDialog(accountDialog); notice('列と、この列のログイン情報を削除しました。'); }
  else $('#remove-error').textContent = result.error;
});
for (const id of ['rail-add', 'welcome-add']) $(`#${id}`).addEventListener('click', () => openAccount());
function populateDevices(selector, kind, choice) {
  const select = $(selector);
  const options = [new Option('Discord / Windowsの既定', 'null')];
  const counts = new Map();
  for (const device of audioDevices.filter((d) => d.kind === kind)) {
    const ordinal = counts.get(device.label) || 0; counts.set(device.label, ordinal + 1);
    options.push(new Option(`${device.label}${ordinal ? ` (${ordinal + 1})` : ''}`, JSON.stringify({ label: device.label, ordinal })));
  }
  const value = JSON.stringify(choice);
  if (choice && !options.some((option) => option.value === value)) options.push(new Option(`${choice.label}（保存済み・一覧未確認）`, value));
  select.replaceChildren(...options); select.value = value;
}
function renderUpdates() {
  const update = state?.updates || { enabled: false, phase: 'idle', unavailable: 'アプリ内更新はインストーラー版で使えます。' };
  $('#update-version').textContent = update.currentVersion ? `v${update.currentVersion}` : '';
  const messages = {
    idle: '「更新を確認」で最新版をチェックできます。', checking: 'GitHubで最新版を確認しています…',
    current: '最新バージョンです。', available: `v${update.latestVersion}をダウンロードできます。`,
    downloading: `v${update.latestVersion}をダウンロード中… ${update.progress}%`, downloaded: `v${update.latestVersion}の準備ができました。`,
    installing: 'ログイン状態を保存し、更新して再起動します…', error: update.error,
  };
  $('#update-status').textContent = update.enabled ? messages[update.phase] || '' : update.unavailable;
  $('#check-update').disabled = settingsBusy || !update.enabled || !['idle', 'current', 'available', 'error'].includes(update.phase);
  $('#download-update').hidden = update.phase !== 'available';
  $('#download-update').disabled = settingsBusy;
  $('#install-update').hidden = update.phase !== 'downloaded';
  $('#install-update').disabled = settingsBusy;
  $('#update-progress').hidden = !['downloading', 'downloaded'].includes(update.phase);
  $('#update-progress').value = update.progress || 0;
}
$('#check-update').addEventListener('click', () => command({ type: 'update-check' }));
$('#download-update').addEventListener('click', () => command({ type: 'update-download' }));
$('#install-update').addEventListener('click', () => command({ type: 'update-install' }));
$('#update-releases').addEventListener('click', () => command({ type: 'update-releases' }));
$('#settings-button').addEventListener('click', () => {
  const settings = state.settings;
  $('#settings-fullscreen').checked = settings.fullscreen;
  $('#settings-sound').checked = settings.notificationSound;
  $('#settings-taskbar-badge').checked = settings.taskbarBadge;
  $('#settings-privacy').checked = settings.hideOnBlur;
  $('#settings-passkeys').checked = settings.suppressPasskeyPrompts;
  populateDevices('#settings-input', 'audioinput', settings.inputDevice);
  populateDevices('#settings-output', 'audiooutput', settings.outputDevice);
  $('#settings-error').textContent = ''; $('#device-status').textContent = '';
  openDialog(settingsDialog);
});
settingsDialog.addEventListener('close', () => {
  scanGeneration++; scanStream?.getTracks().forEach((track) => track.stop()); scanStream = undefined;
  $('#refresh-devices').disabled = false; $('#save-settings').disabled = false;
  void command({ type: 'end-device-scan' }, false);
});
$('#refresh-devices').addEventListener('click', async () => {
  const generation = ++scanGeneration;
  const input = JSON.parse($('#settings-input').value), output = JSON.parse($('#settings-output').value);
  $('#refresh-devices').disabled = true; $('#save-settings').disabled = true;
  $('#device-status').textContent = '音声機器を確認中…';
  let stream;
  try {
    const result = await command({ type: 'begin-device-scan' }, false);
    if (!result.ok) throw new Error(result.error);
    if (!settingsDialog.open || generation !== scanGeneration) return;
    stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    if (!settingsDialog.open || generation !== scanGeneration) return;
    scanStream = stream;
    const devices = await navigator.mediaDevices.enumerateDevices();
    if (!settingsDialog.open || generation !== scanGeneration) return;
    audioDevices = devices.filter((device) => ['audioinput', 'audiooutput'].includes(device.kind) && !['default', 'communications'].includes(device.deviceId) && device.label);
    populateDevices('#settings-input', 'audioinput', input); populateDevices('#settings-output', 'audiooutput', output);
    $('#device-status').textContent = audioDevices.length ? '一覧を更新しました。マイクは停止しました。' : '機器名を取得できませんでした。Windowsの音声設定を確認してください。';
  } catch (error) {
    if (generation === scanGeneration) $('#device-status').textContent = error.name === 'NotAllowedError' ? 'マイクの使用が許可されませんでした。Windowsのアクセス許可も確認してください。' : `機器を取得できませんでした。${error.message || ''}`;
  } finally {
    stream?.getTracks().forEach((track) => track.stop());
    if (scanStream === stream) scanStream = undefined;
    if (generation === scanGeneration) {
      await command({ type: 'end-device-scan' }, false);
      $('#refresh-devices').disabled = false; $('#save-settings').disabled = false;
    }
  }
});
$('#settings-form').addEventListener('submit', async (event) => {
  event.preventDefault(); if (settingsBusy || $('#save-settings').disabled) return;
  settingsBusy = true;
  for (const button of $$('button', settingsDialog)) button.disabled = true;
  const result = await command({ type: 'settings', settings: { fullscreen: $('#settings-fullscreen').checked, taskbarBadge: $('#settings-taskbar-badge').checked, suppressPasskeyPrompts: $('#settings-passkeys').checked, notificationSound: $('#settings-sound').checked, hideOnBlur: $('#settings-privacy').checked, inputDevice: JSON.parse($('#settings-input').value), outputDevice: JSON.parse($('#settings-output').value) } }, false);
  settingsBusy = false;
  for (const button of $$('button', settingsDialog)) button.disabled = false;
  renderUpdates();
  if (result.ok) { closeDialog(settingsDialog); notice('本体設定を保存しました。'); }
  else $('#settings-error').textContent = result.error;
});
$('#help-button').addEventListener('click', () => openDialog(helpDialog));
$('#open-data-folder').addEventListener('click', () => command({ type: 'data-folder' }));
$('#reset-external-permissions').addEventListener('click', async () => {
  const result = await command({ type: 'reset-external-permissions' });
  if (result.ok) notice('外部アプリの許可をリセットしました。次回から確認します。');
});
for (const button of $$('[data-layout]')) button.addEventListener('click', () => command({ type: 'layout', mode: button.dataset.layout, columnCount: Number(button.dataset.columns) }));
$('#previous-page').addEventListener('click', () => command({ type: 'activate', id: state.accounts[Math.max(0, lastPage.start - lastPage.capacity)].id }));
$('#next-page').addEventListener('click', () => command({ type: 'activate', id: state.accounts[lastPage.start + lastPage.capacity].id }));
new ResizeObserver(reportBounds).observe(deck);
window.addEventListener('resize', reportBounds);
window.deck.onLayout(reportBounds);
window.deck.onState(render);
window.deck.onNotice(notice);
window.deck.getState().then(render).catch(() => notice('起動できませんでした。アプリを再起動してください。'));
})();
