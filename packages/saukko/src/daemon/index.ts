import { Logger } from '@cocotais/logger';
import { App, Config, PluginService, Scope, createScope, injectionProvider, pluginDependencyDiagnose } from '@saukkojs/core';
import toml from 'smol-toml';
import fs from 'fs';
import net from 'net';
import path from 'path';
import { SaukkoEnv, DaemonMessage, DaemonResponse } from '../types';
import { getPluginPackages, getServicePackages, isPluginPackage, resolveModule } from './loader';

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

	logger.debug('配置加载', config);
	logger.debug('import.meta', import.meta);

	const rootScope = createScope();
	injectionProvider(rootScope, config, { headless: false });

	const app = rootScope.get<App>('app')!;
	const plugin = rootScope.get<PluginService>('plugin')!;

	const servicesToLoad = await getServicePackages(config, logger);
	for (const serviceModule of servicesToLoad) {
		rootScope.register(serviceModule.name, serviceModule.default);
	}
	logger.info('已装载 ', servicesToLoad.length, ' 个服务');

	const pluginsToLoad = await getPluginPackages(config, logger);
	for (const pluginModule of pluginsToLoad) {
		try {
			// install 即执行插件主体：单个插件装载失败不阻断其余插件。
			await plugin.install(pluginModule);
		} catch (error) {
			logger.error(`装载插件 ${pluginModule?.name ?? 'unknown'} 失败：`, error);
		}
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
					void handleMessage(message, socket, app, server, rootScope);
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

async function handleMessage(message: DaemonMessage, socket: net.Socket, app: App, server: net.Server, scope: Scope) {
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
		logger.info('IPC 收到命令请求', message.args);
		const [command, ...rest] = message.args || [];
		if (!command) {
			logger.warn('IPC 收到空命令');
			const response: DaemonResponse = { ok: true, message: '命令无效：命令为空' };
			socket.write(JSON.stringify(response) + '\n');
			return;
		}

		try {
			if (command === 'plugin') {
				const pluginService = scope.get<PluginService>('plugin')!;
				if (rest[0] === 'install') {
					if (!rest[1]) {
						throw new Error('缺少插件目录');
					}
					const plugin = await import(resolveModule(rest[1]));
					if (!isPluginPackage(plugin)) {
						throw new Error('无效的插件');
					}
					
					await pluginService.install(plugin);
					logger.info(`已通过 IPC 安装插件 ${plugin.name}`);
					const response: DaemonResponse = { ok: true, message: `已安装插件 ${plugin.name}` };
					socket.write(JSON.stringify(response) + '\n');
					return;
				}
				if (rest[0] === 'enable') {
					if (pluginService.map().has(rest[1]) === false) {
						throw new Error(`未找到插件 ${rest[1]}，可能未安装`);
					}
					// 动态启用前重新诊断依赖：循环依赖为硬错误，拒绝启用；
					// 缺失依赖转为等待语义，标记期望启用后由框架自动启动。
					const diagnosis = pluginDependencyDiagnose(pluginService, scope);
					const issue = diagnosis.issues.find((item) => item.plugin === rest[1]);
					if (issue?.type === 'circular-dependency') {
						throw new Error(`无法启用插件 ${rest[1]}：存在循环依赖 ${issue.details.join(' -> ')}`);
					}
					await pluginService.apply(rest[1]);
					const item = pluginService.map().get(rest[1])!;
					const message = item.enabled
						? `已启用插件 ${rest[1]}`
						: `插件 ${rest[1]} 已标记为期望启用，正在等待依赖: ${item.missing.join(', ')}`;
					logger.info(`已通过 IPC 处理插件启用请求`, rest[1], message);
					const response: DaemonResponse = { ok: true, message };
					socket.write(JSON.stringify(response) + '\n');
					return;
				}
				if (rest[0] === 'list') {
					// 列表展示运行状态：enabled / waiting（含等待的依赖）/ disabled。
					const entries = Array.from(pluginService.map().entries()).map(([name, item]) => {
						if (item.enabled) return `${name} (enabled)`;
						if (item.missing.length > 0) return `${name} (waiting: ${item.missing.join(', ')})`;
						return `${name} (disabled)`;
					});
					logger.info('已通过 IPC 列出插件列表', entries);
					const response: DaemonResponse = { ok: true, message: `已安装插件列表: ${entries.join(', ')}` };
					socket.write(JSON.stringify(response) + '\n');
					return;
				}
				if (rest[0] === 'disable') {
					if (pluginService.map().has(rest[1]) === false) {
						throw new Error(`未找到插件 ${rest[1]}，可能未安装`);
					}
					await pluginService.dispose(rest[1]);
					logger.info(`已通过 IPC 禁用插件 ${rest[1]}`);
					const response: DaemonResponse = { ok: true, message: `已禁用插件 ${rest[1]}` };
					socket.write(JSON.stringify(response) + '\n');
					return;
				}
				if (rest[0] === 'uninstall') {
					if (pluginService.map().has(rest[1]) === false) {
						throw new Error(`未找到插件 ${rest[1]}，可能未安装`);
					}
					await pluginService.remove(rest[1]);
					logger.info(`已通过 IPC 卸载插件 ${rest[1]}`);
					const response: DaemonResponse = { ok: true, message: `已卸载插件 ${rest[1]}` };
					socket.write(JSON.stringify(response) + '\n');
					return;
				}
				throw new Error(`未知的命令 ${rest[0]}。可用的命令有：install, uninstall, enable, disable, list`);
			}
			const response: DaemonResponse = { ok: false, message: `未知的命令 ${command}。可用的命令有：plugin` };
			socket.write(JSON.stringify(response) + '\n');
			return;
		} catch (error) {
			logger.error('IPC 处理命令失败', error);
			const response: DaemonResponse = { ok: false, message: error instanceof Error ? error.message : 'Unknown error' };
			socket.write(JSON.stringify(response) + '\n');
			return;
		}
	}

	logger.warn('IPC 收到未知的操作请求：', message.action);
	const response: DaemonResponse = { ok: false, message: 'Unknown action' };
	socket.write(JSON.stringify(response) + '\n');
}

main().catch((error) => {
	logger.error('Daemon 失败：', error);
	process.exit(1);
});
