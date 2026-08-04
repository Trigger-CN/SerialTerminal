'use strict';

const base = '/serialterminal/admin';
let selectedDays = 30;

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
  } catch (cause) {
    error.textContent = `加载统计数据失败：${cause.message}`;
    error.hidden = false;
  }
}

document.querySelectorAll('[data-days]').forEach(button => button.addEventListener('click', () => {
  selectedDays = Number(button.dataset.days);
  document.querySelectorAll('[data-days]').forEach(item => item.classList.toggle('active', item === button));
  loadMetrics();
}));

document.getElementById('logout').addEventListener('click', async () => {
  await fetch(`${base}/logout`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'X-CSRF-Token': decodeURIComponent(cookie('serialterminal_csrf')) }
  });
  location.assign(`${base}/login`);
});

loadMetrics();
