import { Logger } from '@cocotais/logger';
import { DaemonMessage, DaemonResponse, SaukkoEnv } from './types';
import { version } from '../package.json';
import fs from 'fs';
import net from 'net';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import 'dotenv/config';

const env = process.env as SaukkoEnv;
const configPath = env.SAUKKO_CONFIG_PATH || path.join(process.cwd(), 'saukko.toml');
const socketPath = env.SAUKKO_SOCKET_PATH || path.join(process.cwd(), '.saukko.sock');
const ipcPath = process.platform === 'win32'
    ? `\\\\.\\pipe\\${socketPath.replace(/[:\\/]/g, '-')}`
    : socketPath;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const logger = new Logger('cli', {
    hasDate: true,
    loglevel: env.SAUKKO_LOG_LEVEL
});

function ensureConfig() {
    if (fs.existsSync(configPath)) return;
    logger.error('未找到 saukko.toml 文件。');
    logger.notice('你可能需要使用 create-saukko 创建一个项目。');
    logger.notice('请参阅 使用文档 获取更多信息。');
    process.exit(1);
}

function sendToDaemon(message: DaemonMessage) {
    return new Promise<DaemonResponse>((resolve, reject) => {
        const client = net.createConnection(ipcPath, () => {
            client.write(JSON.stringify(message) + '\n');
        });

        client.setEncoding('utf8');

        let buffer = '';
        client.on('data', (chunk) => {
            buffer += chunk.toString();
            let index = buffer.indexOf('\n');
            while (index !== -1) {
                const raw = buffer.slice(0, index).trim();
                buffer = buffer.slice(index + 1);
                index = buffer.indexOf('\n');
                if (!raw) continue;
                try {
                    resolve(JSON.parse(raw) as DaemonResponse);
                } catch (error) {
                    reject(error);
                } finally {
                    client.end();
                }
            }
        });

        client.on('error', (error) => {
            reject(error);
        });
    });
}

function startDaemon() {
    if (process.platform !== 'win32' && fs.existsSync(ipcPath)) {
        logger.error('已存在 .saukko.sock 文件，框架可能已启动。');
        logger.notice('如果你确认框架未启动，请删除 .saukko.sock 文件后重试。');
        process.exit(1);
    }

    ensureConfig();

    const daemonEntry = path.resolve(__dirname, 'daemon', 'index.js');
    logger.notice('启动 saukko 守护进程...');

    const child = spawn(process.execPath, [daemonEntry], {
        env: process.env,
        stdio: ['ignore', 'inherit', 'inherit']
    });

    child.on('exit', (code) => {
        if (code === 0) {
            logger.notice('守护进程已退出。');
        } else {
            logger.error(`守护进程异常退出，代码: ${code ?? 'unknown'}`);
        }
    });
}

async function main() {
    const args = process.argv.slice(2);

    logger.info(`saukko v${version} by Cocotais Team`);

    if (args.length === 0 || args[0] === 'start') {
        startDaemon();
        return;
    }

    if (args[0] === 'stop') {
        try {
            const response = await sendToDaemon({ action: 'stop' });
            logger.notice(response.message || '守护进程已停止');
        } catch (error) {
            logger.error('无法连接到守护进程，请确认其是否已启动。', error);
            process.exit(1);
        }
        return;
    }

    try {
        const response = await sendToDaemon({ action: 'command', args });
        logger.notice(response.message || '命令已发送到守护进程');
    } catch (error) {
        logger.error('无法连接到守护进程，请确认其是否已启动。', error);
        process.exit(1);
    }
}

main().catch((error) => {
    logger.error('CLI 运行失败', error);
    process.exit(1);
});