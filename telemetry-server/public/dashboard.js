'use strict';

const base = '/serialterminal/admin';
let selectedDays = 30;
let updatePolicies = [];
let editingPolicyId = '';

function cookie(name) {
  return document.cookie.split(';').map(part => part.trim()).find(part => part.startsWith(`${name}=`))?.slice(name.length + 1) || '';
}

function formatNumber(value) {
  return new Intl.NumberFormat('zh-CN').format(Number(value) || 0);
}

function renderBars(elementId, values) {
  const root = document.getElementById(elementId);
  root.replaceChildren();
  const max = Math.max(1, ...values.map(item => item.devices));
  values.forEach(item => {
    const row = document.createElement('div');
    row.className = 'bar-row';
    const label = document.createElement('span');
    label.className = 'bar-label';
    label.textContent = item.label;
    label.title = item.label;
    const track = document.createElement('progress');
    track.className = 'bar-track';
    track.max = max;
    track.value = item.devices;
    const value = document.createElement('span');
    value.className = 'bar-value';
    value.textContent = formatNumber(item.devices);
    row.append(label, track, value);
    root.append(row);
  });
}

function renderChart(values) {
  const svg = document.getElementById('activity-chart');
  svg.replaceChildren();
  const width = 1000;
  const height = 320;
  const margin = { top: 18, right: 18, bottom: 36, left: 48 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const max = Math.max(1, ...values.map(item => item.devices));
  const points = values.map((item, index) => ({
    ...item,
    x: margin.left + (values.length === 1 ? 0 : index / (values.length - 1) * plotWidth),
    y: margin.top + plotHeight - item.devices / max * plotHeight
  }));
  const ns = 'http://www.w3.org/2000/svg';
  for (let step = 0; step <= 4; step++) {
    const y = margin.top + step / 4 * plotHeight;
    const line = document.createElementNS(ns, 'line');
    line.setAttribute('class', 'chart-grid');
    line.setAttribute('x1', margin.left);
    line.setAttribute('x2', width - margin.right);
    line.setAttribute('y1', y);
    line.setAttribute('y2', y);
    svg.append(line);
    const label = document.createElementNS(ns, 'text');
    label.setAttribute('class', 'chart-label');
    label.setAttribute('x', margin.left - 10);
    label.setAttribute('y', y + 4);
    label.setAttribute('text-anchor', 'end');
    label.textContent = Math.round(max * (1 - step / 4));
    svg.append(label);
  }
  if (!points.length) return;
  const area = document.createElementNS(ns, 'path');
  area.setAttribute('class', 'chart-area');
  area.setAttribute('d', `M ${points[0].x} ${margin.top + plotHeight} L ${points.map(point => `${point.x} ${point.y}`).join(' L ')} L ${points.at(-1).x} ${margin.top + plotHeight} Z`);
  svg.append(area);
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('class', 'chart-line');
  path.setAttribute('d', `M ${points.map(point => `${point.x} ${point.y}`).join(' L ')}`);
  svg.append(path);
  points.forEach((point, index) => {
    if (values.length > 31 && index % 3 !== 0 && index !== points.length - 1) return;
    const dot = document.createElementNS(ns, 'circle');
    dot.setAttribute('class', 'chart-dot');
    dot.setAttribute('cx', point.x);
    dot.setAttribute('cy', point.y);
    dot.setAttribute('r', 3);
    const title = document.createElementNS(ns, 'title');
    title.textContent = `${point.day}: ${point.devices}`;
    dot.append(title);
    svg.append(dot);
  });
  [points[0], points.at(-1)].forEach(point => {
    const label = document.createElementNS(ns, 'text');
    label.setAttribute('class', 'chart-label');
    label.setAttribute('x', point.x);
    label.setAttribute('y', height - 10);
    label.setAttribute('text-anchor', point === points[0] ? 'start' : 'end');
    label.textContent = point.day.slice(5);
    svg.append(label);
  });
}

function renderRecentActivity(values) {
  const root = document.getElementById('recent-activity');
  root.replaceChildren();
  if (!values.length) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 5;
    cell.className = 'empty-cell';
    cell.textContent = '暂无上报记录';
    row.append(cell);
    root.append(row);
    return;
  }
  values.forEach(item => {
    const row = document.createElement('tr');
    [
      item.last_seen_at ? new Date(item.last_seen_at).toLocaleString('zh-CN') : '-',
      `...${item.device_id || '-'}`,
      item.app_version || '-',
      item.platform || '-',
      item.arch || '-'
    ].forEach(value => {
      const cell = document.createElement('td');
      cell.textContent = value;
      row.append(cell);
    });
    root.append(row);
  });
}

async function loadMetrics() {
  const error = document.getElementById('error');
  error.hidden = true;
  try {
    const response = await fetch(`${base}/api/metrics?days=${selectedDays}`, { credentials: 'same-origin' });
    if (response.status === 401) return location.assign(`${base}/login`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    document.getElementById('dau').textContent = formatNumber(data.summary.dau);
    document.getElementById('wau').textContent = formatNumber(data.summary.wau);
    document.getElementById('mau').textContent = formatNumber(data.summary.mau);
    document.getElementById('total').textContent = formatNumber(data.summary.total_installations);
    document.getElementById('new-today').textContent = formatNumber(data.summary.new_today);
    document.getElementById('updated-at').textContent = `更新于 ${new Date(data.generatedAt).toLocaleString('zh-CN')}`;
    renderChart(data.daily);
    renderBars('versions', data.versions);
    renderBars('platforms', data.platforms);
    renderBars('architectures', data.architectures);
    renderRecentActivity(data.recentActivity || []);
  } catch (cause) {
    error.textContent = `加载统计数据失败：${cause.message}`;
    error.hidden = false;
  }
}

function csrfToken() {
  try {
    return decodeURIComponent(cookie('serialterminal_csrf'));
  } catch {
    return '';
  }
}

function formatPolicyDate(value) {
  return value ? new Date(value).toLocaleString('zh-CN') : '-';
}

function policyVersionRange(policy) {
  if (!policy.minClientVersion && !policy.maxClientVersion) return '所有版本';
  return `${policy.minClientVersion || '不限'} 至 ${policy.maxClientVersion || '不限'}`;
}

function appendTextCell(row, value, className = '') {
  const cell = document.createElement('td');
  cell.textContent = value;
  if (className) cell.className = className;
  row.append(cell);
  return cell;
}

function renderUpdatePolicies() {
  const root = document.getElementById('update-policies');
  root.replaceChildren();
  document.getElementById('update-policies-summary').textContent = `${updatePolicies.length} 条策略`;
  if (!updatePolicies.length) {
    const row = document.createElement('tr');
    const cell = appendTextCell(row, '暂无更新策略', 'empty-cell');
    cell.colSpan = 6;
    root.append(row);
    return;
  }
  updatePolicies.forEach(policy => {
    const row = document.createElement('tr');
    row.classList.toggle('editing', String(policy.id) === editingPolicyId);

    const stateCell = document.createElement('td');
    const state = document.createElement('span');
    state.className = `policy-state${policy.enabled ? '' : ' disabled'}`;
    state.textContent = policy.enabled ? '已启用' : '已停用';
    stateCell.append(state);
    if (policy.legacy) {
      const legacy = document.createElement('span');
      legacy.className = 'legacy-label';
      legacy.textContent = '旧客户端';
      stateCell.append(legacy);
    }
    row.append(stateCell);

    const scopeCell = document.createElement('td');
    scopeCell.className = 'policy-scope';
    const channel = document.createElement('strong');
    channel.textContent = policy.channel || '全部渠道';
    const versions = document.createElement('span');
    versions.textContent = policyVersionRange(policy);
    scopeCell.append(channel, versions);
    row.append(scopeCell);

    appendTextCell(row, policy.priority, 'policy-priority');
    const urlCell = document.createElement('td');
    const link = document.createElement('a');
    link.className = 'policy-url';
    link.href = policy.metadataUrl;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.title = policy.metadataUrl;
    link.textContent = policy.metadataUrl;
    urlCell.append(link);
    row.append(urlCell);

    const updatedCell = document.createElement('td');
    updatedCell.className = 'policy-updated';
    const updatedAt = document.createElement('span');
    updatedAt.textContent = formatPolicyDate(policy.updatedAt);
    const updatedBy = document.createElement('small');
    updatedBy.textContent = policy.updatedBy || '-';
    updatedCell.append(updatedAt, updatedBy);
    row.append(updatedCell);

    const actionCell = document.createElement('td');
    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'policy-edit';
    edit.dataset.policyId = policy.id;
    edit.textContent = '编辑';
    actionCell.append(edit);
    row.append(actionCell);
    root.append(row);
  });
}

function updateLegacyPolicyNote() {
  const form = document.getElementById('update-policy-form');
  const legacyPolicy = updatePolicies.find(policy => policy.legacy && String(policy.id) !== editingPolicyId);
  form.elements.legacy.disabled = Boolean(legacyPolicy);
  document.getElementById('legacy-policy-note').textContent = legacyPolicy
    ? `策略 #${legacyPolicy.id} 已用于旧客户端，请先取消该策略的旧客户端标记`
    : '';
}

function openPolicyEditor(policy = null) {
  const form = document.getElementById('update-policy-form');
  form.hidden = false;
  form.reset();
  editingPolicyId = policy ? String(policy.id) : '';
  form.elements.policyId.value = editingPolicyId;
  form.elements.metadataUrl.value = policy?.metadataUrl || '';
  form.elements.channel.value = policy?.channel || '';
  form.elements.priority.value = policy?.priority ?? 0;
  form.elements.minClientVersion.value = policy?.minClientVersion || '';
  form.elements.maxClientVersion.value = policy?.maxClientVersion || '';
  form.elements.enabled.checked = policy?.enabled ?? true;
  form.elements.legacy.checked = policy?.legacy ?? false;
  document.getElementById('policy-editor-title').textContent = policy ? `编辑策略 #${policy.id}` : '新建策略';
  document.getElementById('policy-editor-meta').textContent = policy?.createdAt
    ? `创建于 ${formatPolicyDate(policy.createdAt)}`
    : '';
  form.querySelector('button[type="submit"]').textContent = policy ? '保存更改' : '创建策略';
  const status = document.getElementById('policy-form-status');
  status.className = 'form-status';
  status.textContent = '';
  updateLegacyPolicyNote();
  renderUpdatePolicies();
}

function closePolicyEditor() {
  editingPolicyId = '';
  document.getElementById('update-policy-form').hidden = true;
  renderUpdatePolicies();
}

async function updatePolicyError(response) {
  const payload = await response.json().catch(() => ({}));
  const messages = {
    forbidden: '请求验证失败，请刷新页面后重试',
    invalid_update_policy: '请检查地址、渠道、版本范围和优先级',
    legacy_policy_conflict: '只能启用一条旧客户端默认策略',
    policy_not_found: '策略不存在或已被修改'
  };
  return new Error(messages[payload.error] || payload.message || `HTTP ${response.status}`);
}

async function loadUpdatePolicies() {
  const response = await fetch(`${base}/api/update-policies`, { credentials: 'same-origin' });
  if (response.status === 401) return location.assign(`${base}/login`);
  if (!response.ok) throw await updatePolicyError(response);
  const data = await response.json();
  if (!Array.isArray(data.policies)) throw new Error('服务器返回的策略列表无效');
  updatePolicies = data.policies;
  renderUpdatePolicies();
}

document.getElementById('new-policy').addEventListener('click', () => {
  openPolicyEditor();
  document.getElementById('update-policy-form').elements.metadataUrl.focus();
});

document.getElementById('cancel-policy').addEventListener('click', closePolicyEditor);

document.getElementById('update-policies').addEventListener('click', event => {
  const button = event.target.closest('[data-policy-id]');
  if (!button) return;
  const policy = updatePolicies.find(item => String(item.id) === button.dataset.policyId);
  if (policy) openPolicyEditor(policy);
});

document.getElementById('update-policy-form').elements.legacy.addEventListener('change', updateLegacyPolicyNote);
document.getElementById('update-policy-form').elements.metadataUrl.addEventListener('input', event => event.currentTarget.setCustomValidity(''));
document.getElementById('update-policy-form').elements.priority.addEventListener('input', event => event.currentTarget.setCustomValidity(''));

document.getElementById('update-policy-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const metadataInput = form.elements.metadataUrl;
  try {
    const url = new URL(metadataInput.value.trim());
    metadataInput.setCustomValidity(url.protocol === 'https:' && !url.username && !url.password && !url.hash
      && (!url.port || url.port === '443') && /\/latest\.yml$/i.test(url.pathname)
      ? ''
      : '请输入 HTTPS latest.yml 地址');
  } catch {
    metadataInput.setCustomValidity('请输入 HTTPS latest.yml 地址');
  }
  if (!form.reportValidity()) return;

  const priority = Number(form.elements.priority.value);
  if (!Number.isSafeInteger(priority)) {
    form.elements.priority.setCustomValidity('优先级必须是整数');
    form.reportValidity();
    return;
  }
  form.elements.priority.setCustomValidity('');
  const id = form.elements.policyId.value;
  const payload = {
    metadataUrl: metadataInput.value.trim(),
    channel: form.elements.channel.value.trim() || null,
    minClientVersion: form.elements.minClientVersion.value.trim() || null,
    maxClientVersion: form.elements.maxClientVersion.value.trim() || null,
    enabled: form.elements.enabled.checked,
    legacy: form.elements.legacy.checked,
    priority
  };
  const button = form.querySelector('button[type="submit"]');
  const status = document.getElementById('policy-form-status');
  button.disabled = true;
  status.className = 'form-status';
  status.textContent = '正在保存';
  try {
    const response = await fetch(`${base}/api/update-policies${id ? `/${encodeURIComponent(id)}` : ''}`, {
      method: id ? 'PUT' : 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': csrfToken()
      },
      body: JSON.stringify(payload)
    });
    if (response.status === 401) return location.assign(`${base}/login`);
    if (!response.ok) throw await updatePolicyError(response);
    const saved = await response.json();
    editingPolicyId = String(saved.id);
    await loadUpdatePolicies();
    openPolicyEditor(updatePolicies.find(policy => String(policy.id) === editingPolicyId) || saved);
    status.classList.add('success');
    status.textContent = id ? '策略已更新' : '策略已创建';
  } catch (cause) {
    status.classList.add('failure');
    status.textContent = `保存失败：${cause.message}`;
  } finally {
    button.disabled = false;
  }
});

document.querySelectorAll('[data-days]').forEach(button => button.addEventListener('click', () => {
  selectedDays = Number(button.dataset.days);
  document.querySelectorAll('[data-days]').forEach(item => item.classList.toggle('active', item === button));
  loadMetrics();
}));

document.getElementById('logout').addEventListener('click', async () => {
  await fetch(`${base}/logout`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'X-CSRF-Token': csrfToken() }
  });
  location.assign(`${base}/login`);
});

Promise.all([loadMetrics(), loadUpdatePolicies()]).catch(cause => {
  const error = document.getElementById('error');
  error.textContent = `加载管理数据失败：${cause.message}`;
  error.hidden = false;
});
