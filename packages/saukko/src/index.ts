import { Logger } from '@cocotais/logger';
import { version } from '../package.json';
import toml from 'smol-toml';
import fs from 'fs';
import path from 'path';
import { SaukkoEnv } from './types';

const env = process.env as SaukkoEnv;

const logger = new Logger("cli", env.SAUKKO_LOG_LEVEL, {
    hasDate: true
});

logger.info(`saukko v${version} by Cocotais Team`);

if (fs.existsSync(path.join(process.cwd(), 'saukko.toml'))) {
    logger.error('未找到 saukko.toml 文件。');
    logger.notice('你可能需要使用 create-saukko 创建一个项目。');
    logger.notice('请参阅 使用文档 获取更多信息。');
    process.exit(1);
}

const config = toml.parse(fs.readFileSync(path.join(process.cwd(), 'saukko.toml'), 'utf8'));

const args = process.argv.slice(2);

if (args.length === 0) {
    logger.info('启动 saukko 中...');
    // WIP
}
else {
    // WIP
}