import { Logger } from '@cocotais/logger';
import prompts from 'prompts';
import fs from 'fs';
import { spawnSync } from 'child_process';

const logger = new Logger('version', {
    loglevel: 'trace'
})

const section = await prompts({
    type: 'select',
    name: 'confirm',
    message: '请确认发布前已经完成：\n1. 代码已经构建完成\n2. 版本号已经更新\n3. 所有更改已经提交并推送到远程仓库\n\n是否继续发布？',
    choices: [
        { title: '否', value: false },
        { title: '是', value: true }
    ],
})

if (!section.confirm) {
    logger.info('发布已取消');
    process.exit(0);
}

const packages = fs.readdirSync('packages')
logger.debug(`Found ${packages.length} packages: `, packages);

for (const pkg of packages) {
    spawnSync('pnpm', ['publish', '--access', 'public'], {
        cwd: `packages/${pkg}`,
        stdio: 'inherit',
        shell: true
    });
}