'use strict';

if (process.platform === 'win32') {
  const { ipcRenderer } = require('electron');
  document.documentElement.classList.add('custom-titlebar');

  const installTitleBar = () => {
    const titleBar = document.createElement('div');
    titleBar.className = 'window-titlebar';
    titleBar.setAttribute('aria-hidden', 'true');

    const titleText = document.createElement('span');
    titleText.className = 'window-titlebar-text';
    titleBar.appendChild(titleText);
    document.body.prepend(titleBar);

    const titleElement = document.querySelector('title');
    const updateTitle = () => {
      titleText.textContent = document.title;
    };
    updateTitle();
    if (titleElement) new MutationObserver(updateTitle).observe(titleElement, { childList: true });
    ipcRenderer.on('window-title-updated', (event, title) => {
      titleText.textContent = String(title || document.title);
    });
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', installTitleBar, { once: true });
  } else {
    installTitleBar();
  }
}
