import { Logger } from '@cocotais/logger';
import { SaukkoEnv } from './types';
import { version } from '../package.json';
import toml from 'smol-toml';
import fs from 'fs';
import path from 'path';
import net from 'net';
import 'dotenv/config';

const env = process.env as SaukkoEnv;
const configPath = env.SAUKKO_CONFIG_PATH || path.join(process.cwd(), 'saukko.toml');
const socketPath = env.SAUKKO_SOCKET_PATH || path.join(process.cwd(), '.saukko.sock');

const logger = new Logger("cli", {
    hasDate: true,
    loglevel: env.SAUKKO_LOG_LEVEL
});

logger.info(`saukko v${version} by Cocotais Team`);

if (fs.existsSync(configPath) === false) {
    logger.error('未找到 saukko.toml 文件。');
    logger.notice('你可能需要使用 create-saukko 创建一个项目。');
    logger.notice('请参阅 使用文档 获取更多信息。');
    process.exit(1);
}

const config = toml.parse(fs.readFileSync(configPath, 'utf8'));

const args = process.argv.slice(2);

if (args.length === 0) {
    if (fs.existsSync(socketPath)) {
        logger.error('已存在 .saukko.sock 文件，框架可能已启动。');
        logger.notice('如果你确认框架未启动，请删除 .saukko.sock 文件后重试。');
        process.exit(1);
    }
    logger.info('启动 saukko 中...');
    
}
else {
    // WIP
}