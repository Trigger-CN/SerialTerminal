'use strict';

const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const API_ROOT = 'https://gitee.com/api/v5';

function parseArguments(args) {
  const options = { files: [] };
  for (let index = 0; index < args.length; index++) {
    const name = args[index];
    if (name === '--files') {
      options.files = args.slice(index + 1);
      break;
    }
    if (!name.startsWith('--') || !args[index + 1]) throw new Error(`Invalid argument: ${name}`);
    options[name.slice(2)] = args[++index];
  }
  for (const name of ['owner', 'repo', 'tag', 'target', 'notes']) {
    if (!options[name]) throw new Error(`Missing --${name}`);
  }
  if (options.files.length === 0) throw new Error('Missing --files');
  return options;
}

function createGiteePublisher({ token, fetchImpl = global.fetch, apiRoot = API_ROOT }) {
  if (!token) throw new Error('GITEE_ACCESS_TOKEN is required');

  async function request(method, endpoint, { body, form, allowNotFound = false } = {}) {
    const url = new URL(`${apiRoot}${endpoint}`);
    url.searchParams.set('access_token', token);
    const options = { method, headers: {} };
    if (body) {
      options.headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(body);
    } else if (form) {
      options.body = form;
    }
    const response = await fetchImpl(url, options);
    if (allowNotFound && response.status === 404) return null;
    if (!response.ok) {
      const details = (await response.text()).slice(0, 500);
      throw new Error(`Gitee API ${method} ${endpoint} failed: HTTP ${response.status}${details ? ` ${details}` : ''}`);
    }
    return response.status === 204 ? null : response.json();
  }

  async function publish({ owner, repo, tag, target, name, notes, files }) {
    const base = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases`;
    const releaseBody = {
      tag_name: tag,
      target_commitish: target,
      name: name || tag,
      body: notes,
      prerelease: /-(?:alpha|beta|rc)(?:\.|$)/i.test(tag)
    };
    let release = await request('GET', `${base}/tags/${encodeURIComponent(tag)}`, { allowNotFound: true });
    if (release) {
      release = await request('PATCH', `${base}/${release.id}`, { body: releaseBody });
    } else {
      release = await request('POST', base, { body: releaseBody });
    }

    const attachmentsEndpoint = `${base}/${release.id}/attach_files`;
    let attachments = await request('GET', attachmentsEndpoint);
    const assetUrls = new Map();
    const uploadFiles = [...files].sort((left, right) => {
      const leftIsMetadata = /(?:^|[\\/])latest(?:-linux)?\.yml$/i.test(left);
      const rightIsMetadata = /(?:^|[\\/])latest(?:-linux)?\.yml$/i.test(right);
      return Number(leftIsMetadata) - Number(rightIsMetadata);
    });
    for (const filePath of uploadFiles) {
      const fileName = path.basename(filePath);
      let uploadPath = filePath;
      if (/^latest(?:-linux)?\.yml$/i.test(fileName)) {
        const source = yaml.load(await fs.promises.readFile(filePath, 'utf8'));
        for (const file of source.files || []) {
          const assetUrl = assetUrls.get(file.url);
          if (assetUrl) file.url = assetUrl;
        }
        uploadPath = null;
        const metadata = Buffer.from(yaml.dump(source), 'utf8');
        const existing = attachments.find(item => item.name === fileName);
        if (existing) await request('DELETE', `${attachmentsEndpoint}/${existing.id}`);
        const form = new FormData();
        form.set('file', new Blob([metadata]), fileName);
        const uploaded = await request('POST', attachmentsEndpoint, { form });
        const assetUrl = getAttachmentUrl(uploaded);
        if (assetUrl) assetUrls.set(fileName, assetUrl);
        attachments = await request('GET', attachmentsEndpoint);
        continue;
      }
      const existing = attachments.find(item => item.name === fileName);
      if (existing) {
        await request('DELETE', `${attachmentsEndpoint}/${existing.id}`);
      }
      const form = new FormData();
      form.set('file', new Blob([await fs.promises.readFile(uploadPath)]), fileName);
      const uploaded = await request('POST', attachmentsEndpoint, { form });
      const assetUrl = getAttachmentUrl(uploaded);
      if (assetUrl) assetUrls.set(fileName, assetUrl);
      attachments = await request('GET', attachmentsEndpoint);
    }
    return release;
  }

  return { publish };
}

function getAttachmentUrl(attachment) {
  return attachment?.browser_download_url || attachment?.download_url || attachment?.url || '';
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const notes = await fs.promises.readFile(options.notes, 'utf8');
  for (const filePath of options.files) {
    await fs.promises.access(filePath, fs.constants.R_OK);
  }
  const publisher = createGiteePublisher({ token: process.env.GITEE_ACCESS_TOKEN });
  const release = await publisher.publish({ ...options, notes, name: `SerialTerminal ${options.tag.replace(/^v/, '')}` });
  console.log(`Published Gitee release ${release.tag_name || options.tag} with ${options.files.length} artifact(s)`);
}

if (require.main === module) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { createGiteePublisher, parseArguments };
