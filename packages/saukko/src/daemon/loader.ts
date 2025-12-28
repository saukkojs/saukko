import { Logger } from "@cocotais/logger";
import { Config, Constructor, ServiceRegistry } from "@saukkojs/core";
import { PluginType } from "@saukkojs/core/lib/services/plugin";
import fs from "fs";
import path from "path";
import { pathToFileURL } from "url";
import { createRequire } from "module";

const require = createRequire(path.join(process.cwd(), "package.json"));

type ServiceType = {
    name: keyof ServiceRegistry;
    default: Constructor<any> | (() => any);
}

function resolvePath(dir: string) {
    try {
        return pathToFileURL(require.resolve(path.resolve(dir))).href;
    } catch {
        return pathToFileURL(path.resolve(dir)).href;
    }
}

function resolvePackage(name: string) {
    return pathToFileURL(require.resolve(name, { paths: [process.cwd()] })).href;
}

export function resolveModule(id: string) {
    try {
        return resolvePackage(id);
    } catch {
        return resolvePath(id);
    }
}

function getDependencies(scopes: string[]): string[] {
    const pkgPath = path.join(process.cwd(), 'package.json');
    if (!fs.existsSync(pkgPath)) return [];

    try {
        const content = fs.readFileSync(pkgPath, 'utf-8');
        const pkg = JSON.parse(content);
        const deps = { ...pkg.dependencies, ...pkg.devDependencies };
        return Object.keys(deps).filter(name => scopes.some(scope => name.startsWith(scope)));
    } catch {
        return [];
    }
}

export function isServicePackage(pkg: any): pkg is ServiceType {
    return pkg.name && typeof pkg.name === 'string' && (typeof pkg.default === 'function' || typeof pkg.default === 'object');
}

export function isPluginPackage(pkg: any): pkg is PluginType {
    return pkg.name && typeof pkg.name === 'string' && typeof pkg.default === 'function';
}

export async function getServicePackages(config: Config, logger: Logger): Promise<ServiceType[]> {
    const scopes = [
        '@saukkojs/service-',
        'saukko-service-',
        ...(config.service.scopes || [])
    ];
    const files = config.service.files || [];

    let packages = [];

    for (const file of files) {
        logger.debug('加载文件：', resolvePath(file));
        try {
            packages.push(await import(resolvePath(file)));
        } catch (error) {
            logger.error(`无法加载服务文件 ${file}：`, error);
        }
    }

    const packageNames = getDependencies(scopes);
    if (packageNames.length > 0) {
        logger.debug('发现依赖包：', packageNames);
        for (const name of packageNames) {
            try {
                const url = resolvePackage(name);
                logger.debug('加载包：', url);
                packages.push(await import(url));
            } catch (error) {
                logger.error(`无法加载服务包 ${name}：`, error);
            }
        }
    }

    const validPackages: ServiceType[] = [];
    for (const pkg of packages) {
        if (!isServicePackage(pkg)) {
            logger.debug('无效的服务，过滤：', pkg);
        } else {
            validPackages.push(pkg);
        }
    }

    return validPackages;
}

export async function getPluginPackages(config: Config, logger: Logger): Promise<PluginType[]> {
    const scopes = [
        '@saukkojs/plugin-',
        'saukko-plugin-',
        ...(config.plugin.scopes || [])
    ];
    const files = config.plugin.files || [];

    let packages: PluginType[] = [];

    for (const file of files) {
        logger.debug('加载文件：', resolvePath(file));
        try {
            packages.push(await import(resolvePath(file)));
        } catch (error) {
            logger.error(`无法加载插件文件 ${file}：`, error);
        }
    }

    const packageNames = getDependencies(scopes);
    if (packageNames.length > 0) {
        logger.debug('发现依赖包：', packageNames);
        for (const name of packageNames) {
            try {
                const url = resolvePackage(name);
                logger.debug('加载包：', url);
                packages.push(await import(url));
            } catch (error) {
                logger.error(`无法加载插件包 ${name}：`, error);
            }
        }
    }

    const validPackages: PluginType[] = [];
    for (const pkg of packages) {
        if (!isPluginPackage(pkg)) {
            logger.debug('无效的插件，过滤：', pkg);
        } else {
            validPackages.push(pkg);
        }
    }

    return validPackages;
}