'use strict';

/**
 * 历史版本列表的纯逻辑：从 GitHub Release 数据里挑选可用版本、判定相对状态、
 * 挑选与当前平台匹配的安装包。
 *
 * 这层刻意不碰网络和 Electron，主进程只负责取数据，判定全部在这里完成，
 * 这样「哪个版本该显示什么标签」「哪个资产才是这个版本的安装包」都能单独测试。
 */

const GITHUB_OWNER = 'Trigger-CN';
const GITHUB_REPO = 'SerialTerminal';

// 平台对应的安装包资产命名。与 .github/workflows/release.yml 里的产物名一致。
const WINDOWS_INSTALLER_PATTERN = /^SerialTerminal-Setup-.+\.exe$/i;
const WINDOWS_BLOCKMAP_PATTERN = /\.exe\.blockmap$/i;
const LINUX_APPIMAGE_PATTERN = /\.AppImage$/i;
const LINUX_DEB_PATTERN = /\.deb$/i;
const LINUX_METADATA_PATTERN = /^latest-linux\.ya?ml$/i;
const WINDOWS_METADATA_PATTERN = /^latest\.ya?ml$/i;

const RELEASE_TAG_PATTERN = /^v(\d+\.\d+\.\d+)(?:-([0-9A-Za-z.-]+))?$/;
const MAX_LISTED_RELEASES = 100;

/**
 * 把 tag 拆成版本号。只接受 vX.Y.Z 形式的稳定 tag，
 * 预发布（带 - 后缀）一律跳过，避免把测试版混进可回退列表。
 */
function parseReleaseTag(tagName) {
  const match = RELEASE_TAG_PATTERN.exec(String(tagName || ''));
  if (!match) return null;
  if (match[2]) return null;
  return match[1];
}

function compareVersions(left, right) {
  const a = String(left || '').split('.').map(Number);
  const b = String(right || '').split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const x = Number.isFinite(a[i]) ? a[i] : 0;
    const y = Number.isFinite(b[i]) ? b[i] : 0;
    if (x !== y) return x - y;
  }
  return 0;
}

/**
 * 当前版本相对列表项的语义。UI 用这三种状态给版本打标签。
 * same 刻意与 newer/older 区分，因为「当前」不该算作「旧版本」。
 */
function classifyVersion(candidate, current) {
  const delta = compareVersions(candidate, current);
  if (delta === 0) return 'same';
  return delta > 0 ? 'newer' : 'older';
}

/**
 * 从资产里挑出当前平台真正能安装的那一个。
 * 顺序有讲究：Windows 优先 exe；Linux 优先 deb（系统包管理器可处理依赖），
 * 其次 AppImage（免安装）。
 */
function pickInstallerAsset(assets, platform = process.platform) {
  if (!Array.isArray(assets)) return null;
  const usable = assets.filter(asset => asset && typeof asset.name === 'string' && asset.browser_download_url);

  if (platform === 'win32') {
    const installer = usable.find(asset => WINDOWS_INSTALLER_PATTERN.test(asset.name) && !WINDOWS_BLOCKMAP_PATTERN.test(asset.name));
    return installer || null;
  }

  // Linux：deb 与 AppImage 都是可安装产物，deb 优先。
  const deb = usable.find(asset => LINUX_DEB_PATTERN.test(asset.name));
  if (deb) return deb;
  const appImage = usable.find(asset => LINUX_APPIMAGE_PATTERN.test(asset.name));
  return appImage || null;
}

function pickChecksumAsset(assets, platform = process.platform) {
  if (!Array.isArray(assets)) return null;
  const pattern = platform === 'linux' ? LINUX_METADATA_PATTERN : WINDOWS_METADATA_PATTERN;
  return assets.find(asset => asset && pattern.test(String(asset.name || ''))) || null;
}

function formatReleaseDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * 把 GitHub 的 releases 响应整理成 UI 需要的形状。
 *
 * 跳过规则：
 * - draft：草稿对用户不可见
 * - prerelease：预发布不提供回退
 * - 无稳定 tag
 * - 当前平台没有可安装资产（例如只有 Linux 包的版本）
 */
function buildReleaseList(releases, { currentVersion, platform = process.platform, limit = MAX_LISTED_RELEASES } = {}) {
  if (!Array.isArray(releases)) return [];

  const items = [];
  for (const release of releases) {
    if (!release || release.draft === true || release.prerelease === true) continue;
    const version = parseReleaseTag(release.tag_name);
    if (!version) continue;

    const installer = pickInstallerAsset(release.assets, platform);
    if (!installer) continue;

    items.push({
      version,
      tag: release.tag_name,
      state: classifyVersion(version, currentVersion),
      publishedAt: formatReleaseDate(release.published_at || release.created_at),
      sizeBytes: Number(installer.size) || 0,
      assetName: installer.name,
      downloadUrl: installer.browser_download_url,
      pageUrl: release.html_url || '',
      notes: typeof release.body === 'string' ? release.body.trim() : ''
    });
  }

  items.sort((a, b) => compareVersions(b.version, a.version));
  return Number.isFinite(limit) && limit > 0 ? items.slice(0, limit) : items;
}

/**
 * 校验下载地址。版本列表来自外部接口，地址必须在预期仓库下，
 * 防止接口数据被篡改后把用户引到别处下载可执行文件。
 */
function isTrustedReleaseDownloadUrl(value) {
  let url;
  try {
    url = new URL(String(value || ''));
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  if (url.hostname !== 'github.com') return false;
  const expectedPrefix = `/${GITHUB_OWNER}/${GITHUB_REPO}/releases/download/`;
  return url.pathname.startsWith(expectedPrefix);
}

module.exports = {
  GITHUB_OWNER,
  GITHUB_REPO,
  MAX_LISTED_RELEASES,
  buildReleaseList,
  classifyVersion,
  compareVersions,
  isTrustedReleaseDownloadUrl,
  parseReleaseTag,
  pickChecksumAsset,
  pickInstallerAsset
};
