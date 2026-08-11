import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliEntry = path.join(packageRoot, 'lib', 'index.js');

type DaemonResponse = { ok: boolean; message?: string };

/** 夹具插件：挂载/清理时在 daemon 工作目录写标记文件，供外部观察生命周期。 */
const fixturePlugin = (name: string) => `import fs from 'node:fs';
import path from 'node:path';
export const name = '${name}';
export default function (context) {
    fs.writeFileSync(path.join(process.cwd(), '${name}.mounted'), 'mounted');
    context.lifecycle.onStop(() => {
        fs.writeFileSync(path.join(process.cwd(), '${name}.stopped'), 'stopped');
    });
}
`;

const fixtureGhost = `export const name = 'fixture-ghost';
export const inject = ['ghost-svc'];
export default function () {}
`;

function createProjectDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'saukko-daemon-test-'));
    fs.writeFileSync(path.join(dir, 'package.json'), '{}', 'utf8');
    fs.writeFileSync(path.join(dir, 'fixture-a.mjs'), fixturePlugin('fixture-a'), 'utf8');
    fs.writeFileSync(path.join(dir, 'fixture-b.mjs'), fixturePlugin('fixture-b'), 'utf8');
    fs.writeFileSync(path.join(dir, 'fixture-ghost.mjs'), fixtureGhost, 'utf8');
    fs.writeFileSync(path.join(dir, 'saukko.toml'), `[project]
name = "daemon-test"

[plugin]
files = ["./fixture-a.mjs", "./fixture-ghost.mjs"]

[plugin.config]

[service]
files = []

[service.config]
`, 'utf8');
    return dir;
}

function ipcPathFor(socketPath: string) {
    return process.platform === 'win32'
        ? `\\\\.\\pipe\\${socketPath.replace(/[:\\/]/g, '-')}`
        : socketPath;
}

function sendIpc(ipcPath: string, message: unknown): Promise<DaemonResponse> {
    return new Promise((resolve, reject) => {
        const client = net.createConnection(ipcPath, () => {
            client.write(JSON.stringify(message) + '\n');
        });
        client.setEncoding('utf8');
        let buffer = '';
        client.on('data', (chunk) => {
            buffer += chunk.toString();
            const index = buffer.indexOf('\n');
            if (index === -1) return;
            try {
                resolve(JSON.parse(buffer.slice(0, index).trim()) as DaemonResponse);
            } catch (error) {
                reject(error);
            } finally {
                client.end();
            }
        });
        client.on('error', reject);
    });
}

function runCli(args: string[], env: NodeJS.ProcessEnv, cwd: string) {
    return new Promise<{ code: number | null; output: string }>((resolve, reject) => {
        const child = spawn(process.execPath, [cliEntry, ...args], { env, cwd });
        let output = '';
        child.stdout.on('data', (chunk) => (output += chunk));
        child.stderr.on('data', (chunk) => (output += chunk));
        child.on('error', reject);
        child.on('exit', (code) => resolve({ code, output }));
    });
}

function waitExit(child: ChildProcess) {
    return new Promise<number | null>((resolve) => child.on('exit', resolve));
}

test('daemon and CLI cover start, plugin commands and stop over IPC', { timeout: 90000 }, async (t) => {
    const dir = createProjectDir();
    const socketPath = path.join(dir, '.saukko.sock');
    const ipcPath = ipcPathFor(socketPath);
    const env = {
        ...process.env,
        SAUKKO_CONFIG_PATH: path.join(dir, 'saukko.toml'),
        SAUKKO_SOCKET_PATH: socketPath,
        SAUKKO_LOG_LEVEL: 'info',
    };
    const command = (args: string[]) => sendIpc(ipcPath, { action: 'command', args });
    const marker = (name: string) => path.join(dir, name);

    // 经 CLI `start` 启动 daemon，覆盖 CLI 的进程拉起路径。
    const cli = spawn(process.execPath, [cliEntry, 'start'], { env, cwd: dir });
    // 丢弃输出，避免管道缓冲填满阻塞进程。
    cli.stdout.on('data', () => {});
    cli.stderr.on('data', () => {});
    t.after(() => {
        cli.kill();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    // 轮询等待 daemon 就绪。
    let ready = false;
    for (let attempt = 0; attempt < 60 && !ready; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        ready = await command(['plugin', 'list']).then((r) => r.ok, () => false);
    }
    assert.ok(ready, 'daemon should become ready');

    // 启动时装载并启用 fixture-a；缺失依赖的 fixture-ghost 被诊断跳过。
    assert.ok(fs.existsSync(marker('fixture-a.mounted')), 'fixture-a mounted at startup');
    assert.ok(!fs.existsSync(marker('fixture-ghost.mounted')), 'fixture-ghost skipped at startup');

    // enable：缺失依赖的插件被拒绝并给出原因（3.5 补的诊断缺口）。
    const ghost = await command(['plugin', 'enable', 'fixture-ghost']);
    assert.equal(ghost.ok, false);
    assert.match(ghost.message ?? '', /缺失依赖 ghost-svc/);

    // install + enable：动态装载插件并启用。
    const install = await command(['plugin', 'install', './fixture-b.mjs']);
    assert.equal(install.ok, true, install.message);
    const enable = await command(['plugin', 'enable', 'fixture-b']);
    assert.equal(enable.ok, true, enable.message);
    assert.ok(fs.existsSync(marker('fixture-b.mounted')), 'fixture-b mounted after enable');

    // disable：等待清理完成，标记文件落盘。
    const disable = await command(['plugin', 'disable', 'fixture-a']);
    assert.equal(disable.ok, true, disable.message);
    assert.ok(fs.existsSync(marker('fixture-a.stopped')), 'fixture-a cleanup completed');

    // 经真实 CLI 进程查询列表。
    const list = await runCli(['plugin', 'list'], env, dir);
    assert.equal(list.code, 0);
    assert.match(list.output, /fixture-b/);
    assert.match(list.output, /fixture-a/);

    // uninstall：从列表移除。
    const uninstall = await command(['plugin', 'uninstall', 'fixture-b']);
    assert.equal(uninstall.ok, true, uninstall.message);
    const after = await command(['plugin', 'list']);
    assert.ok(!after.message?.includes('fixture-b'), 'fixture-b removed from list');

    // stop：daemon 退出，CLI 前端进程随之退出。
    const stop = await runCli(['stop'], env, dir);
    assert.equal(stop.code, 0);
    const exitCode = await waitExit(cli);
    assert.equal(exitCode, 0);

    // 非 Windows 平台退出后清理 socket 文件。
    if (process.platform !== 'win32') {
        assert.ok(!fs.existsSync(socketPath), 'socket file cleaned up');
    }
});
