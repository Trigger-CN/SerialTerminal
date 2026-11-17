'use strict';

// Default mode only prepares; use --run to execute the isolated Electron verification.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');
const { WebSocket } = require('undici');

const projectRoot = path.resolve(__dirname, '..');
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const deadlineMs = 30000;

async function waitFor(probe, description, child) {
    const deadline = Date.now() + deadlineMs;
    let lastError;
    while (Date.now() < deadline) {
        if (child && child.exitCode !== null) throw new Error(`${description}: Electron exited (${child.exitCode})`);
        try {
            const value = await probe();
            if (value) return value;
        } catch (error) {
            lastError = error;
        }
        await delay(100);
    }
    throw new Error(`Timed out: ${description}${lastError ? `; ${lastError.message}` : ''}`);
}

async function unusedPort() {
    const server = net.createServer();
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const port = server.address().port;
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    return port;
}

async function connectCdp(url) {
    const socket = new WebSocket(url);
    const pending = new Map();
    let nextId = 1;
    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('CDP connection timed out')), deadlineMs);
        socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
        socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP connection failed')); }, { once: true });
    }).catch(error => { socket.close(); throw error; });
    socket.addEventListener('message', event => {
        const message = JSON.parse(String(event.data));
        const request = pending.get(message.id);
        if (!request) return;
        pending.delete(message.id);
        clearTimeout(request.timer);
        if (message.error) request.reject(new Error(JSON.stringify(message.error)));
        else request.resolve(message.result);
    });
    socket.addEventListener('close', () => {
        for (const request of pending.values()) {
            clearTimeout(request.timer);
            request.reject(new Error('CDP connection closed'));
        }
        pending.clear();
    });
    return {
        socket,
        call(method, params = {}) {
            const id = nextId++;
            return new Promise((resolve, reject) => {
                const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, deadlineMs);
                pending.set(id, { resolve, reject, timer });
                socket.send(JSON.stringify({ id, method, params }));
            });
        },
        async evaluate(expression) {
            const response = await this.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
            if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
            return response.result.value;
        }
    };
}

// These helpers run in the actual renderer lexical context; no extracted or substituted production functions.
const rendererHelpers = `
window.__multiSerialVerify = {
    check(value, message) { if (!value) throw new Error(message); },
    visible(id) {
        const element = document.getElementById(id);
        this.check(element?.isConnected, id + ': panel missing');
        this.check(element.classList.contains('active'), id + ': panel inactive');
        for (let ancestor = element; ancestor; ancestor = ancestor.parentElement) {
            const style = getComputedStyle(ancestor);
            this.check(!ancestor.hidden && style.display !== 'none' && style.visibility !== 'hidden'
                && style.visibility !== 'collapse' && Number(style.opacity) !== 0, id + ': hidden ancestor ' + ancestor.id);
        }
        const rect = element.getBoundingClientRect();
        this.check(rect.width > 0 && rect.height > 0, id + ': zero geometry');
        return { id, width: rect.width, height: rect.height };
    },
    count(object, method, name) {
        this.check(typeof object?.[method] === 'function', name + ': missing production method');
        const original = object[method];
        this.counts[name] = 0;
        object[method] = function(...args) {
            window.__multiSerialVerify.counts[name]++;
            return original.apply(this, args);
        };
    },
    counts: {},
    layout() { return serializeWorkspaceLayout(workspaceModel); },
    visiblePanes() {
        const result = [];
        for (const group of Object.values(workspaceModel.tabs).filter(tabModel.isContainer)) {
            for (const pane of group.panes) {
                const element = document.getElementById(pane.activeTabId);
                if (element && element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0) {
                    result.push(this.visible(pane.activeTabId));
                }
            }
        }
        result.push(this.visible(workspaceModel.focusedTabId));
        return result;
    }
};
`;

async function verifyShellCloseFallback(cdp, child) {
    await cdp.evaluate(`(() => {
        const v = window.__multiSerialVerify;
        v.defaultId = activeGroupId;
        v.shellCloseGroups = [addSerialGroupFromUi().id, addSerialGroupFromUi().id];
        v.check(serialGroups.length === 3, 'Shell-close fixture requires exactly three serial groups');
        v.controlId = v.shellCloseGroups[1];
        createFilterTab({ id: 'tab-filter-920001', filterText: 'group3' });
        v.check(splitWorkspaceTabIntoPane({ tabId: 'tab-filter-920001', groupId: v.controlId, orientation: 'horizontal' }), 'group3 split rejected');
        v.localActives = () => JSON.stringify(Object.values(workspaceModel.tabs).filter(tabModel.isContainer)
            .map(group => [group.id, group.activePaneId, group.panes.map(pane => [pane.id, pane.activeTabId])]));
        v.checkControl = expected => {
            v.check(activeGroupId === v.controlId, 'Shell close changed control group');
            v.check(serialGroupRegistry.activeGroupId === v.controlId, 'Shell close registry differs from group3');
            v.check(document.getElementById('sidebar-active-group').dataset.groupId === v.controlId, 'Shell close sidebar differs from group3');
            const buttons = Array.from(document.querySelectorAll('.serial-group-tab'));
            v.check(buttons.some(button => button.dataset.groupId === v.controlId), 'group3 button missing');
            for (const button of buttons) {
                const selected = button.dataset.groupId === v.controlId;
                v.check(button.classList.contains('active') === selected, 'group button active differs from control group');
                v.check(button.getAttribute('aria-selected') === String(selected), 'group button aria differs from control group');
            }
            v.check(workspaceModel.focusedTabId === expected && focusedWorkspaceTabId === expected, 'Shell close focus differs from expected leaf');
            v.check(getGroupWorkspaceManager(v.controlId).getActiveTabId() === expected, 'group3 manager active differs from fallback');
            v.check(workspaceModel.tabs[expected]?.ownerGroupId === v.controlId, 'fallback owner differs from group3');
            return v.visible(expected);
        };
        return true;
    })()`);
    for (const split of [false, true]) {
        await cdp.evaluate(`(() => {
            const v = window.__multiSerialVerify;
            v.check(dispatchWorkspaceAction({ type: 'column-split', enabled: ${split}, orientation: 'horizontal' }).ok, 'column split rejected');
            activateSerialGroup(v.controlId);
            document.getElementById(mainTabButtonId(v.controlId)).click();
            activateSerialGroup(v.defaultId);
            createShellTab({ id: 'tab-shell-920001', title: 'Shell1' });
            activateSerialGroup(v.shellCloseGroups[0]);
            createShellTab({ id: 'tab-shell-920002', title: 'Shell2' });
            if (${shellCount} === 3) createShellTab({ id: 'tab-shell-920003', title: 'background Shell' });
            return true;
        })()`);
        await waitFor(() => cdp.evaluate(`${JSON.stringify(
            shellCount === 3 ? ['tab-shell-920001', 'tab-shell-920002', 'tab-shell-920003'] : ['tab-shell-920001', 'tab-shell-920002']
        )}.every(id => getShellTabState(id)?.sessionReady)`), `${shellCount} real Shell sessions ready`, child);
        console.log('shell-close-fallback', JSON.stringify(await cdp.evaluate(`(async () => {
            const v = window.__multiSerialVerify;
            document.querySelector('.serial-group-tab[data-group-id="' + v.controlId + '"]').click();
            if (${split}) document.getElementById('tab-filter-920001-button').click();
            v.fallbackId = getGroupWorkspaceManager(v.controlId).getActiveTabId();
            v.check(v.fallbackId === (${split} ? 'tab-filter-920001' : mainTabId(v.controlId)), 'group3 fixture active leaf differs');
            const before = v.localActives();
            document.getElementById('tab-shell-920002-button').click();
            v.check(workspaceModel.focusedTabId === 'tab-shell-920002', 'Shell2 click did not focus Shell2');
            v.check(activeGroupId === v.controlId, 'Shell2 click changed control group');
            document.getElementById('tab-shell-920002-button').querySelector('.main-tab-close').click();
            await new Promise(resolve => setTimeout(resolve, 300));
            const fallbackPanel = v.checkControl(v.fallbackId);
            v.check(v.localActives() === before, 'foreground Shell close changed local pane active');
            v.check(!workspaceModel.tabs['tab-shell-920002'] && !getShellTabState('tab-shell-920002')
                && !document.getElementById('tab-shell-920002'), 'closed Shell2 remains');
            if (${split}) {
                for (const group of Object.values(workspaceModel.tabs).filter(tabModel.isContainer)) {
                    for (const pane of group.panes) v.visible(pane.activeTabId);
                }
            }
            closeShellTab('tab-shell-920003');
            v.checkControl(v.fallbackId);
            v.check(v.localActives() === before, 'background Shell close changed local pane active');
            document.getElementById('tab-shell-920001-button').click();
            const shellFocusLocals = v.localActives();
            createShellTab({ id: 'tab-shell-920004', title: 'second background Shell' });
            switchShellTab('tab-shell-920001');
            closeShellTab('tab-shell-920004');
            v.check(workspaceModel.focusedTabId === 'tab-shell-920001' && focusedWorkspaceTabId === 'tab-shell-920001', 'background Shell close stole Shell focus');
            v.check(activeGroupId === v.controlId && serialGroupRegistry.activeGroupId === v.controlId, 'background close changed control context');
            v.check(v.localActives() === shellFocusLocals, 'background close changed other pane active');
            v.visible('tab-shell-920001');
            closeShellTab('tab-shell-920001');
            v.checkControl(v.fallbackId);
            return { split: ${split}, controlGroup: v.controlId, focusedTabId: workspaceModel.focusedTabId,
                fallbackPanel, localActivesPreserved: true, backgroundClosePreservedFocus: true };
        })()`)));
    }
    await cdp.evaluate(`(() => {
        const v = window.__multiSerialVerify;
        v.check(dispatchWorkspaceAction({ type: 'column-split', enabled: false }).ok, 'reset column split rejected');
        for (const id of v.shellCloseGroups.slice().reverse()) v.check(closeSerialGroup(id, { confirm: false }), 'fixture group cleanup failed');
        activateSerialGroup(v.defaultId);
        return true;
    })()`);
}

async function run() {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'serial-tab-fixes-'));
    console.log('isolated-temp', tempRoot);
    const profile = path.join(tempRoot, 'profile');
    const logs = path.join(tempRoot, 'logs');
    fs.mkdirSync(profile);
    fs.mkdirSync(logs);
    const configFile = path.join(profile, 'config.json');
    const seedConfig = () => fs.writeFileSync(configFile, JSON.stringify({
        configVersion: 16, telemetryEnabled: false, logEnabled: false, saveAllTabsLogToFiles: false,
        logRetentionDays: 0, logPath: logs, lastWelcomeVersion: require('../package.json').version,
        windowBounds: { width: 1200, height: 850 }
    }));
    seedConfig();
    const wrapper = path.join(tempRoot, 'main.cjs');
    const proofFile = path.join(tempRoot, 'isolation.json');
    fs.writeFileSync(wrapper, `
const { app } = require('electron');
const fs = require('node:fs');
const initialUserData = app.getPath('userData');
app.setAppPath(${JSON.stringify(projectRoot)});
app.setPath('userData', ${JSON.stringify(profile)});
app.setPath('documents', ${JSON.stringify(logs)});
app.setAppLogsPath(${JSON.stringify(logs)});
fs.writeFileSync(${JSON.stringify(proofFile)}, JSON.stringify({ initialUserData,
    userData: app.getPath('userData'), documents: app.getPath('documents'), logs: app.getPath('logs') }));
if (initialUserData === app.getPath('userData') || app.getPath('userData') !== ${JSON.stringify(profile)}) throw new Error('Isolation failed');
require(${JSON.stringify(path.join(projectRoot, 'main.js'))});
`);
    const children = new Set();
    const connections = new Set();
    const output = [];
    function verifyIsolation() {
        const proof = JSON.parse(fs.readFileSync(proofFile, 'utf8'));
        assert.notEqual(path.resolve(proof.initialUserData), path.resolve(profile));
        assert.equal(proof.userData, profile);
        assert.equal(proof.documents, logs);
        assert.equal(proof.logs, logs);
        const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
        assert.equal(config.telemetryEnabled, false);
        assert.equal(config.logEnabled, false);
        assert.equal(config.logRetentionDays, 0);
        assert.equal(config.logPath, logs);
    }

    async function launch() {
        const port = await unusedPort();
        const env = { ...process.env, NODE_ENV: 'development' };
        delete env.ELECTRON_RUN_AS_NODE;
        const child = spawn(require('electron'), [wrapper, `--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1'], {
            cwd: projectRoot, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false
        });
        children.add(child);
        child.on('error', error => output.push(String(error)));
        child.stdout.on('data', data => output.push(data.toString()));
        child.stderr.on('data', data => output.push(data.toString()));
        const target = await waitFor(async () => {
            const response = await fetch(`http://127.0.0.1:${port}/json/list`);
            const targets = await response.json();
            return targets.find(item => item.type === 'page' && item.url.endsWith('/index.html'));
        }, 'main renderer CDP target', child);
        const cdp = await connectCdp(target.webSocketDebuggerUrl);
        connections.add(cdp);
        await waitFor(() => cdp.evaluate(`typeof workspaceModel !== 'undefined' && !!workspaceModel
            && typeof currentConfig !== 'undefined' && !!currentConfig && !isRestoringWorkspaceSession`), 'renderer workspace ready', child);
        await cdp.evaluate(rendererHelpers);
        verifyIsolation();
        return { child, cdp };
    }

    async function normalClose({ child, cdp }) {
        // window.close exercises beforeunload layout flushing and the application's ordinary shutdown.
        await cdp.evaluate('setTimeout(() => window.close(), 0); true');
        await waitFor(() => child.exitCode !== null || child.signalCode !== null, 'normal Electron exit');
        console.log('normal-exit', JSON.stringify({ pid: child.pid, exitCode: child.exitCode, signalCode: child.signalCode }));
        assert.equal(child.exitCode, 0, `normal close exit=${child.exitCode}; signal=${child.signalCode}`);
        children.delete(child);
        cdp.socket.close();
        connections.delete(cdp);
        verifyIsolation();
    }

    async function exitDiagnostic(mode) {
        seedConfig();
        const { child, cdp } = await launch();
        const count = mode === 'A' ? 1 : 3;
        await cdp.evaluate(`(() => {
            const v = window.__multiSerialVerify;
            v.diagIds = [];
            for (let i = 1; i <= ${count}; i += 1) {
                const id = 'tab-shell-' + (93000 + i);
                createShellTab({ id, title: 'exit diagnostic ' + i });
                v.diagIds.push(id);
            }
            return true;
        })()`);
        await waitFor(() => cdp.evaluate('window.__multiSerialVerify.diagIds.every(id => getShellTabState(id)?.sessionReady)'),
            `${mode}: ${count} real Shell sessions ready`, child);
        if (mode === 'C') {
            await cdp.evaluate(`(() => {
                const v = window.__multiSerialVerify;
                closeShellTab(v.diagIds[1]);
                closeShellTab(v.diagIds[2]);
                return true;
            })()`);
        }
        await cdp.evaluate('new Promise(resolve => setTimeout(resolve, 700))');
        const state = await cdp.evaluate(`({ mode: '${mode}', created: ${count},
            shells: shellTabs.map(tab => tab.id), ready: shellTabs.map(tab => tab.sessionReady) })`);
        console.log('exit-diagnostic-state', JSON.stringify(state));
        await normalClose({ child, cdp });
        console.log('exit-diagnostic-result', JSON.stringify({ mode, created: count, exitCode: 0, remainingShells: state.shells.length }));
    }

    try {
        const diagnostic = process.argv.find(argument => argument.startsWith('--exit-diagnostic='));
        if (diagnostic) {
            const requested = (diagnostic.slice('--exit-diagnostic='.length) || 'all').split(',').filter(Boolean);
            const modes = requested.includes('all') ? ['A', 'B', 'C'] : requested;
            if (!modes.length || modes.some(mode => !['A', 'B', 'C'].includes(mode))) {
                throw new Error('Use --exit-diagnostic=A, B, C or all');
            }
            for (const mode of modes) await exitDiagnostic(mode);
            console.log('PASS: exit diagnostics', modes.join(','));
            return;
        }
        const first = await launch();
        const { cdp } = first;
        await verifyShellCloseFallback(cdp, first.child);
        const setup = await cdp.evaluate(`(() => {
            const v = window.__multiSerialVerify;
            for (const value of ['VERIFY_A_NOT_A_PORT', 'VERIFY_B_NOT_A_PORT']) {
                document.getElementById('port-select').add(new Option(value, value));
            }
            v.defaultId = activeGroupId;
            v.defaultTerm = serialRuntimes.get(v.defaultId).term;
            const a = getSerialGroupById(v.defaultId);
            a.portPath = 'VERIFY_A_NOT_A_PORT';
            a.serialOptions = { ...a.serialOptions, baudRate: '9600', dataBits: '8', stopBits: '1', parity: 'none' };
            applyActiveSerialGroup();
            const b = addSerialGroupFromUi();
            v.closedGroup = b.id;
            b.portPath = 'VERIFY_B_NOT_A_PORT';
            b.serialOptions = { ...b.serialOptions, baudRate: '115200', dataBits: '7', stopBits: '2', parity: 'even' };
            applyActiveSerialGroup();
            v.check(document.getElementById('parity-select').value === 'even', 'B sidebar setup');
            createFilterTab({ id: 'tab-filter-910001', filterText: 'verify' });
            v.filter = filterTabsStore.getList(b.id).find(tab => tab.id === 'tab-filter-910001');
            v.chart = createChartTab({ id: 'tab-chart-910001', fields: [{ key: 'value', label: 'value', visible: true, role: 'value', color: '#00ff00' }] });
            v.count(v.filter.term, 'dispose', 'filterDispose');
            v.count(v.chart.parserWorker, 'close', 'parserClose');
            v.count(v.chart.stream, 'dispose', 'streamDispose');
            v.count(v.chart.view, 'destroy', 'viewDestroy');
            return { defaultGroup: v.defaultId, closingGroup: b.id };
        })()`);
        console.log('setup', JSON.stringify(setup));
        // Let the production createChartTab settings callback settle before closing its group.
        await cdp.evaluate(`new Promise(resolve => setTimeout(resolve, 100))`);
        console.log('group-close', JSON.stringify(await cdp.evaluate(`(() => {
            const v = window.__multiSerialVerify;
            closeChartSettings();
            v.check(closeSerialGroup(v.closedGroup, { confirm: false }), 'group close failed');
            v.check(activeGroupId === v.defaultId, 'wrong control group after close');
            v.check(serialGroupRegistry.activeGroupId === v.defaultId, 'registry control alias stale');
            v.check(filterTabs === filterTabsStore.getList(v.defaultId), 'filter alias stale');
            v.check(chartTabs === chartTabsStore.getList(v.defaultId), 'chart alias stale');
            v.check(document.getElementById('sidebar-active-group').dataset.groupId === v.defaultId, 'sidebar group stale');
            const options = getGroupSerialOptionsForConnect(v.defaultId);
            v.check(options.path === 'VERIFY_A_NOT_A_PORT' && String(options.baudRate) === '9600'
                && options.parity === 'none' && String(options.dataBits) === '8' && String(options.stopBits) === '1', 'sidebar/connection parameters contaminated');
            v.check(v.filter.closed && v.chart.closed, 'closed flags missing');
            v.check(!v.filter.element.isConnected && !v.chart.element.isConnected, 'closed DOM remains');
            for (const [name, count] of Object.entries(v.counts)) v.check(count === 1, name + ': ' + count);
            v.check(!workspaceModel.tabs[v.filter.id] && !workspaceModel.tabs[v.chart.id], 'ghost model leaves');
            v.check(serialRuntimes.get(v.defaultId).term === v.defaultTerm, 'remaining main instance replaced');
            v.visible(mainTabId(v.defaultId));
            return { counts: v.counts, options };
        })()`)));
        await cdp.evaluate(`(() => {
            const v = window.__multiSerialVerify;
            addSerialGroupFromUi();
            activateSerialGroup(v.defaultId);
            createFilterTab({ id: 'tab-filter-910002', filterText: 'keep' });
            v.keepFilter = filterTabsStore.getList(v.defaultId).find(tab => tab.id === 'tab-filter-910002');
            v.keepTerm = v.keepFilter.term;
            v.check(splitWorkspaceTabIntoPane({ tabId: v.keepFilter.id, groupId: v.defaultId, orientation: 'horizontal' }), 'split rejected');
            const hit = tabModel.paneOfTab(workspaceModel, workspaceModel.tabs[v.keepFilter.id]);
            v.check(workspaceModel.tabs[v.defaultId].activePaneId === hit.pane.id, 'split activePane stale');
            v.check(getGroupWorkspaceManager(v.defaultId).getActivePane().id === hit.pane.id, 'manager activePane stale');
            v.check(v.keepFilter.term === v.keepTerm, 'split replaced xterm');
            v.visible(v.keepFilter.id);
            v.visible(mainTabId(v.defaultId));
            createFilterTab({ id: 'tab-filter-910003' });
            createChartTab({ id: 'tab-chart-910002', fields: [{ key: 'value', label: 'value', visible: true, role: 'value', color: '#00ff00' }] });
            createShellTab({ id: 'tab-shell-910001', title: 'CDP verify Shell' });
            v.shell = getShellTabState('tab-shell-910001');
            v.shellTerm = v.shell.term;
            v.shellElement = v.shell.element;
            v.check(workspaceModel.tabs[v.shell.id].parentId === null, 'Shell is not a root leaf');
            return true;
        })()`);
        await waitFor(() => cdp.evaluate('window.__multiSerialVerify.shell.sessionReady'), 'real Shell session ready', first.child);
        await cdp.evaluate(`new Promise(resolve => setTimeout(resolve, 100))`);
        console.log('focus-and-split', JSON.stringify(await cdp.evaluate(`(async () => {
            const v = window.__multiSerialVerify;
            closeChartSettings();
            switchShellTab(v.shell.id);
            const control = activeGroupId;
            const before = v.layout();
            const localActive = before.groups.map(group => group.panes.map(pane => [pane.id, pane.activeTabId]));
            closeFilterTab('tab-filter-910003');
            closeChartTab('tab-chart-910002');
            v.check(workspaceModel.focusedTabId === v.shell.id, 'closing background leaf stole focus');
            v.check(activeGroupId === control, 'Shell changed control group');
            v.check(v.shell.term === v.shellTerm && v.shell.element === v.shellElement && v.shell.sessionReady, 'Shell instance/session replaced');
            v.visible(v.shell.id);
            const marker = 'CDP_SHELL_TARGET_910001';
            await new Promise(resolve => v.shell.term.write('\\r\\n' + marker + '\\r\\n', resolve));
            const search = getActiveSearchTarget();
            const target = getCurrentTerminalTarget();
            v.check(search.id === v.shell.id && search.term === v.shellTerm && target.term === v.shellTerm, 'search/operation target differs from Shell');
            const exported = getActiveTerminalExport();
            v.check(exported.content.includes(marker), 'export did not read Shell');
            v.shell.term.selectAll();
            v.check(search.term.getSelection().includes(marker), 'selection search did not read Shell');
            clearActiveTerminal();
            v.check(getActiveTerminalExport().content.indexOf(marker) === -1, 'clear did not target Shell');
            v.check(serialRuntimes.get(v.defaultId).term === v.defaultTerm, 'main instance changed');
            // Preserve a two-pane layout with distinct local active tabs for the restart check.
            setFocusedTab(v.keepFilter.id);
            const manager = getGroupWorkspaceManager(v.defaultId);
            manager.setPaneSizes(0.37);
            await new Promise(resolve => setTimeout(resolve, 300));
            v.check(v.keepFilter.term === v.keepTerm, 'filter instance replaced');
            v.visible(v.keepFilter.id);
            v.visible(mainTabId(v.defaultId));
            v.expected = v.layout();
            scheduleWorkspaceLayoutSave();
            return { localActiveBeforeClose: localActive, layout: v.expected, visible: v.visiblePanes() };
        })()`)));
        const expected = await cdp.evaluate('window.__multiSerialVerify.expected');
        const expectedGeometry = await cdp.evaluate('window.__multiSerialVerify.visiblePanes()');
        await normalClose(first);
        const saved = JSON.parse(fs.readFileSync(configFile, 'utf8'));
        assert.deepEqual(saved.workspaceLayoutState, expected, 'normal-close saved layout differs');
        const second = await launch();
        await second.cdp.evaluate('new Promise(resolve => setTimeout(resolve, 300))');
        const restored = await second.cdp.evaluate(`(() => {
            const v = window.__multiSerialVerify;
            return { layout: v.layout(), visible: v.visiblePanes() };
        })()`);
        assert.deepEqual(restored.layout, expected, 'restart layout differs (order, active, focus, split or proportions)');
        assert.deepEqual(restored.visible.map(panel => panel.id), expectedGeometry.map(panel => panel.id), 'restart visible pane identities differ');
        restored.visible.forEach((panel, index) => {
            assert.ok(Math.abs(panel.width - expectedGeometry[index].width) < 2, `${panel.id}: restart width differs`);
            assert.ok(Math.abs(panel.height - expectedGeometry[index].height) < 2, `${panel.id}: restart height differs`);
        });
        console.log('restart-equivalent', JSON.stringify(restored));
        await normalClose(second);
        console.log('PASS: isolated production functions, real DOM/resources, and normal-close restart equivalence');
    } catch (error) {
        console.error(`Electron output:\n${output.join('').slice(-18000)}`);
        throw error;
    } finally {
        for (const connection of connections) connection.socket.close();
        for (const child of children) {
            if (child.exitCode !== null || child.signalCode !== null) continue;
            if (process.platform === 'win32') {
                const result = spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { encoding: 'utf8', timeout: 10000 });
                if (result.status !== 0) console.error('cleanup taskkill:', result.stderr || result.stdout);
            } else child.kill('SIGKILL');
            await waitFor(() => child.exitCode !== null || child.signalCode !== null, 'owned Electron cleanup');
        }
        try {
            if (fs.existsSync(proofFile)) verifyIsolation();
        } finally {
            fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
            assert.equal(fs.existsSync(tempRoot), false, 'temporary directory remains');
            console.log('cleanup-complete', JSON.stringify({ tempRemoved: true, ownedElectronRunning: [...children].filter(child => child.exitCode === null && child.signalCode === null).length }));
        }
    }
}

if (process.argv.includes('--run')) {
    run().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
} else {
    console.log('Prepared only. Run isolated verification: node scripts/verify-multi-serial-tab-fixes.js --run');
    console.log('Exit diagnostics: node scripts/verify-multi-serial-tab-fixes.js --run --exit-diagnostic=all');
}
