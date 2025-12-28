import { Logger } from '@cocotais/logger';
import { App, Config, Container, injectionProvider } from '@saukkojs/core';
import toml from 'smol-toml';
import fs from 'fs';
import net from 'net';
import path from 'path';
import { SaukkoEnv, DaemonMessage, DaemonResponse } from '../types';
import { getPluginPackages, getServicePackages } from './loader';

const env = process.env as SaukkoEnv;
const configPath = env.SAUKKO_CONFIG_PATH || path.join(process.cwd(), 'saukko.toml');
const socketPath = env.SAUKKO_SOCKET_PATH || path.join(process.cwd(), '.saukko.sock');
const ipcPath = process.platform === 'win32'
	? `\\\\.\\pipe\\${socketPath.replace(/[:\\/]/g, '-')}`
	: socketPath;

const logger = new Logger('daemon', {
	hasDate: true,
	loglevel: env.SAUKKO_LOG_LEVEL
});

function loadConfig() {
	if (fs.existsSync(configPath) === false) {
		logger.error('未找到 saukko.toml 文件。Daemon 无法启动。');
		process.exit(1);
	}
	const content = fs.readFileSync(configPath, 'utf8');
	return toml.parse(content);
}

function cleanupSocket() {
	if (process.platform === 'win32') return;
	try {
		if (fs.existsSync(ipcPath)) {
			fs.rmSync(ipcPath);
		}
	} catch (error) {
		logger.warn('无法清理 ipc 通信文件', error);
	}
}

async function main() {
	cleanupSocket();

	const config = loadConfig() as Config;
	const container = new Container();
	injectionProvider(container, config, { headless: false });

	const app = container.get('app');
	const plugin = container.get('plugin');

	const servicesToLoad = await getServicePackages(config, logger);
	for (const serviceModule of servicesToLoad) {
		container.register(serviceModule.name, serviceModule.default);
	}
	logger.info('已装载 ', servicesToLoad.length, ' 个服务');

	const pluginsToLoad = await getPluginPackages(config, logger);
	for (const pluginModule of pluginsToLoad) {
		plugin.install(pluginModule);
	}
	logger.info('已装载 ', pluginsToLoad.length, ' 个插件');

	await app.start();

	const server = net.createServer((socket) => {
		let buffer = '';
		socket.on('data', (chunk) => {
			buffer += chunk.toString();
			let index = buffer.indexOf('\n');
			while (index !== -1) {
				const raw = buffer.slice(0, index).trim();
				buffer = buffer.slice(index + 1);
				index = buffer.indexOf('\n');
				if (!raw) continue;
				try {
					const message = JSON.parse(raw) as DaemonMessage;
					void handleMessage(message, socket, app, server);
				} catch (error) {
					const response: DaemonResponse = { ok: false, message: 'Invalid message format' };
					socket.write(JSON.stringify(response) + '\n');
				}
			}
		});
	});

	server.on('close', cleanupSocket);
	server.on('error', (error: NodeJS.ErrnoException) => {
		logger.error('IPC 通信服务错误：', error);
        if (error.code === 'EADDRINUSE') {
            logger.error('IPC 地址已被占用，守护进程无法启动。');
            process.exit(1);
        }
	});

	server.listen(ipcPath, () => {
		logger.debug(`IPC 通信开始监听于： ${ipcPath}`);
	});

	const stop = async () => {
		server.close();
		try {
			await app.stop();
		} catch (error) {
			logger.error('停止框架失败：', error);
		} finally {
			cleanupSocket();
			process.exit(0);
		}
	};

	process.on('SIGINT', stop);
	process.on('SIGTERM', stop);
}

async function handleMessage(message: DaemonMessage, socket: net.Socket, app: App, server: net.Server) {
	if (message.action === 'stop') {
		const response: DaemonResponse = { ok: true, message: 'Daemon stopping' };
		socket.write(JSON.stringify(response) + '\n');
		server.close(async () => {
			try {
				await app.stop();
			} finally {
				cleanupSocket();
				process.exit(0);
			}
		});
		return;
	}

	if (message.action === 'command') {
		const [command, ...rest] = message.args || [];
		if (!command) {
			const response: DaemonResponse = { ok: true, message: 'No command provided' };
			socket.write(JSON.stringify(response) + '\n');
			return;
		}

		try {
			const commandText = [command, ...rest].join(' ');
			logger.notice(`Received command from cli: ${commandText}`);
			const response: DaemonResponse = { ok: true, message: 'Command dispatched' };
			socket.write(JSON.stringify(response) + '\n');
			return;
		} catch (error) {
			logger.error('Failed to handle command', error);
			const response: DaemonResponse = { ok: false, message: 'Command failed' };
			socket.write(JSON.stringify(response) + '\n');
			return;
		}
	}

	const response: DaemonResponse = { ok: false, message: 'Unknown action' };
	socket.write(JSON.stringify(response) + '\n');
}

main().catch((error) => {
	logger.error('Daemon 失败：', error);
	process.exit(1);
});
