const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

if (process.platform !== 'win32' || !['x64', 'arm64'].includes(os.arch())) process.exit(0);

const nodePtyDir = path.join(__dirname, '..', 'node_modules', 'node-pty');
const versionsDir = path.join(nodePtyDir, 'third_party', 'conpty');
const version = fs.readdirSync(versionsDir, { withFileTypes: true })
    .find(entry => entry.isDirectory())?.name;

if (!version) throw new Error('Bundled ConPTY resources were not found');

const sourceDir = path.join(versionsDir, version, `win10-${os.arch()}`);
const destinationDir = path.join(nodePtyDir, 'build', 'Release', 'conpty');
fs.mkdirSync(destinationDir, { recursive: true });

for (const file of ['conpty.dll', 'OpenConsole.exe']) {
    const source = path.join(sourceDir, file);
    const destination = path.join(destinationDir, file);
    if (fs.existsSync(destination) && fs.readFileSync(source).equals(fs.readFileSync(destination))) continue;
    fs.copyFileSync(source, destination);
}
