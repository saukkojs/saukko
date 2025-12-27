import { build } from 'esbuild';
import { Logger } from '@cocotais/logger';
import fs from 'fs';
import path from 'path';
import child_process from 'child_process';
import { glob } from 'glob';

const logger = new Logger('build', {
    loglevel: 'trace'
})

const entryPointsMap = {
    core: ['packages/core/src/index.ts'],
    saukko: ['packages/saukko/src/index.ts', 'packages/saukko/src/daemon/index.ts'],
}

async function buildPackage(pkg) {
    logger.info(`Building package ${pkg}...`);
    logger.debug(`package path: ${path.join('packages', pkg)}`)

    let entryPoints = entryPointsMap[pkg];

    const buildResult = await build({
        entryPoints,
        outdir: path.join('packages', pkg, 'lib'),
        bundle: true,
        minify: true,
        target: 'node20',
        format: 'esm',
        platform: 'node',
        packages: 'external',
        tsconfig: path.join('packages', pkg, 'tsconfig.json'),
    })

    logger.trace('build done for', pkg, buildResult);
    logger.info(`Build done for ${pkg}`);

    logger.info(`Generating declaration for ${pkg}...`);
    logger.debug('command: ', `npx tsc --project ${path.join('packages', pkg, 'tsconfig.json')} --declaration --emitDeclarationOnly --outDir ${path.join('packages', pkg, 'lib')} --moduleResolution bundler`)
    const declarationResult = child_process.execSync(`npx tsc --project ${path.join('packages', pkg, 'tsconfig.json')} --declaration --emitDeclarationOnly --outDir ${path.join('packages', pkg, 'lib')} --moduleResolution bundler`);
    
    logger.trace('declaration done for', pkg, declarationResult);
    logger.info(`Declaration generated for ${pkg}`);
}

const packages = fs.readdirSync('packages')
logger.debug(`Found ${packages.length} packages: `, packages);

for (const pkg of packages) {
    await buildPackage(pkg);
}