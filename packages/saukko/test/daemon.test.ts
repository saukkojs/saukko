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

/** 夹具服务插件：主体内经 context.share 提升服务，start/stop 写标记文件。 */
const fixtureSvc = `import fs from 'node:fs';
import path from 'node:path';
export const name = 'fixture-svc';
export default async function (context) {
    await context.share('demo-svc', {
        start() { fs.writeFileSync(path.join(process.cwd(), 'fixture-svc.started'), 'started'); },
        stop() { fs.writeFileSync(path.join(process.cwd(), 'fixture-svc.stopped'), 'stopped'); },
    });
}
`;

/** 夹具消费插件：依赖 demo-svc，启停时追加日志（观察级联与恢复）。 */
const fixtureDep = `import fs from 'node:fs';
import path from 'node:path';
export const name = 'fixture-dep';
export const inject = ['demo-svc'];
export default function (context) {
    context.lifecycle.onStart(() => {
        fs.appendFileSync(path.join(process.cwd(), 'fixture-dep.log'), 'start\\n');
    });
    context.lifecycle.onStop(() => {
        fs.appendFileSync(path.join(process.cwd(), 'fixture-dep.log'), 'stop\\n');
    });
}
`;

function createProjectDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'saukko-daemon-test-'));
    fs.writeFileSync(path.join(dir, 'package.json'), '{}', 'utf8');
    fs.writeFileSync(path.join(dir, 'fixture-dep.mjs'), fixtureDep, 'utf8');
    fs.writeFileSync(path.join(dir, 'fixture-svc.mjs'), fixtureSvc, 'utf8');
    fs.writeFileSync(path.join(dir, 'fixture-a.mjs'), fixturePlugin('fixture-a'), 'utf8');
    fs.writeFileSync(path.join(dir, 'fixture-b.mjs'), fixturePlugin('fixture-b'), 'utf8');
    fs.writeFileSync(path.join(dir, 'fixture-ghost.mjs'), fixtureGhost, 'utf8');
    fs.writeFileSync(path.join(dir, 'saukko.toml'), `[project]
name = "daemon-test"

[plugin]
files = ["./fixture-dep.mjs", "./fixture-svc.mjs", "./fixture-a.mjs", "./fixture-ghost.mjs"]

[plugin.config]

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

    // 启动时装载并启用 fixture-a；缺失依赖的 fixture-ghost 挂起等待（主体不执行）。
    assert.ok(fs.existsSync(marker('fixture-a.mounted')), 'fixture-a mounted at startup');
    assert.ok(!fs.existsSync(marker('fixture-ghost.mounted')), 'fixture-ghost suspended at startup');

    // 服务即插件：fixture-svc 经 plugin.files 装载并随 app.start 启动其共享服务；
    // fixture-dep 在安装序上先于服务出现（挂起），服务就绪后自动执行并启用。
    assert.ok(fs.existsSync(marker('fixture-svc.started')), 'fixture-svc started at startup');
    assert.equal(fs.readFileSync(marker('fixture-dep.log'), 'utf8'), 'start\n');

    // disable 服务插件：共享服务停止并摘除，依赖方级联自动停止。
    const disableSvc = await command(['plugin', 'disable', 'fixture-svc']);
    assert.equal(disableSvc.ok, true, disableSvc.message);
    assert.ok(fs.existsSync(marker('fixture-svc.stopped')), 'fixture-svc stopped');
    assert.equal(fs.readFileSync(marker('fixture-dep.log'), 'utf8'), 'start\nstop\n');
    const waitingList = await command(['plugin', 'list']);
    assert.match(waitingList.message ?? '', /fixture-dep \(waiting: demo-svc\)/);

    // 重新启用服务插件：依赖方自动恢复。
    const enableSvc = await command(['plugin', 'enable', 'fixture-svc']);
    assert.equal(enableSvc.ok, true, enableSvc.message);
    assert.equal(fs.readFileSync(marker('fixture-dep.log'), 'utf8'), 'start\nstop\nstart\n');

    // enable：缺失依赖不再拒绝，标记期望启用并报告等待中的依赖。
    const ghost = await command(['plugin', 'enable', 'fixture-ghost']);
    assert.equal(ghost.ok, true);
    assert.match(ghost.message ?? '', /等待依赖: ghost-svc/);
    assert.ok(!fs.existsSync(marker('fixture-ghost.mounted')), 'fixture-ghost still suspended');

    // install + enable：动态装载插件并启用（install 即执行主体）。
    const install = await command(['plugin', 'install', './fixture-b.mjs']);
    assert.equal(install.ok, true, install.message);
    assert.ok(fs.existsSync(marker('fixture-b.mounted')), 'fixture-b mounted at install');
    const enable = await command(['plugin', 'enable', 'fixture-b']);
    assert.equal(enable.ok, true, enable.message);
    assert.match(enable.message ?? '', /已启用插件 fixture-b/);

    // disable：等待清理完成，标记文件落盘。
    const disable = await command(['plugin', 'disable', 'fixture-a']);
    assert.equal(disable.ok, true, disable.message);
    assert.ok(fs.existsSync(marker('fixture-a.stopped')), 'fixture-a cleanup completed');

    // 经真实 CLI 进程查询列表。
    const list = await runCli(['plugin', 'list'], env, dir);
    assert.equal(list.code, 0);
    assert.match(list.output, /fixture-b \(enabled\)/);
    assert.match(list.output, /fixture-a \(disabled\)/);
    assert.match(list.output, /fixture-ghost \(waiting: ghost-svc\)/);

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
