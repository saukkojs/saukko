import { Logger } from '@cocotais/logger';
import fs from 'fs';

const logger = new Logger('version', {
    loglevel: 'trace'
})

if (process.argv.length < 3) {
    logger.error('缺少版本号参数');
    process.exit(1);
}

const packages = fs.readdirSync('packages')
logger.debug(`Found ${packages.length} packages: `, packages);

for (const pkg of packages) {
    const packageJsonPath = `packages/${pkg}/package.json`;
    logger.info(`Updating version for package ${pkg}...`);
    let packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
    const newVersion = process.argv[2];
    packageJson.version = newVersion;
    fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2), 'utf-8');
    logger.info(`Updated version for package ${pkg} to ${newVersion}`);
}