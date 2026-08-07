'use strict';

const { ipcRenderer } = require('electron');

const statusEl = document.getElementById('status');
const detailsEl = document.getElementById('details');
const progressFill = document.getElementById('progress-fill');
const installBtn = document.getElementById('install-btn');
const cancelBtn = document.getElementById('cancel-btn');
const manualDownloadHintEl = document.getElementById('manual-download-hint');
const manualDownloadLinkEl = document.getElementById('manual-download-link');
let strings = {};

function formatSpeed(bytesPerSecond) {
    const value = Number(bytesPerSecond);
    if (!Number.isFinite(value) || value <= 0) return '';
    if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB/s`;
    return `${Math.max(1, Math.round(value / 1024))} KB/s`;
}

function showProgress(progress = {}) {
    const percent = Math.max(0, Math.min(100, Number(progress.percent) || 0));
    progressFill.style.width = `${percent}%`;
    statusEl.textContent = `${strings.downloading || 'Downloading...'} ${Math.round(percent)}%`;
    detailsEl.textContent = formatSpeed(progress.bytesPerSecond);
}

ipcRenderer.on('update-download-init', (event, data = {}) => {
    strings = data;
    document.title = data.title || document.title;
    statusEl.textContent = `${data.downloading || 'Downloading...'} 0%`;
    detailsEl.textContent = data.version ? `v${data.version}` : '';
    installBtn.textContent = data.installAndRestart || 'Install and Restart';
    cancelBtn.textContent = data.cancel || 'Cancel';
    manualDownloadHintEl.textContent = data.manualDownloadHint || 'If the download fails or is slow, download it manually:';
    manualDownloadLinkEl.textContent = data.manualDownload || 'Download EXE';
    manualDownloadLinkEl.onclick = event => {
        event.preventDefault();
        ipcRenderer.invoke('open-update-download-url', data.manualDownloadUrl);
    };
});

ipcRenderer.on('update-download-status', (event, { status, data } = {}) => {
    if (status === 'progress') {
        showProgress(data);
    } else if (status === 'downloaded') {
        progressFill.style.width = '100%';
        statusEl.textContent = strings.downloaded
            ? strings.downloaded.replace('{version}', data?.version || '')
            : 'Update downloaded';
        detailsEl.textContent = strings.restartToInstall || '';
        installBtn.style.display = 'inline-block';
        cancelBtn.style.display = 'none';
    } else if (status === 'cancelled') {
        statusEl.textContent = strings.cancelled || 'Download cancelled';
        detailsEl.textContent = '';
        cancelBtn.style.display = 'none';
    } else if (status === 'error') {
        statusEl.textContent = data || 'Update failed.';
        detailsEl.textContent = '';
        cancelBtn.style.display = 'none';
    }
});

installBtn.onclick = () => ipcRenderer.send('quit-and-install');
cancelBtn.onclick = () => {
    cancelBtn.disabled = true;
    ipcRenderer.send('cancel-update-download');
};
