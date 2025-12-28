import { Logger } from "@cocotais/logger";
import { Config, Constructor, ServiceRegistry } from "@saukkojs/core";
import { PluginType } from "@saukkojs/core/lib/services/plugin";
import fs from "fs";
import path from "path";

type ServiceType = {
    name: keyof ServiceRegistry;
    default: Constructor<any> | (() => any);
}

export function hasNodeModules(dir: string): boolean {
    const nodeModulesPath = path.join(dir, 'node_modules');
    return fs.existsSync(nodeModulesPath) && fs.statSync(nodeModulesPath).isDirectory();
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
        logger.debug('加载：', file);
        try {
            packages.push(await import(path.resolve(file)));
        } catch (error) {
            console.error(`无法加载服务 ${file}：`, error);
        }

    }
    if (!hasNodeModules(process.cwd())) {
        logger.warn('当前目录下未找到 node_modules');
    }
    else {
        for (const scope of scopes) {
            logger.debug('扫描域：', scope);
            const basePath = scope.startsWith('@') ? scope.split('/')[0] : null;
            const scopePath = basePath ? path.join('node_modules', basePath) : 'node_modules';
            if (!fs.existsSync(scopePath)) continue;
            const scopedPackages = fs.readdirSync(scopePath).filter(name => name.startsWith(basePath ? scope.split('/')[1] : scope));
            logger.debug('发现包：', scopedPackages);
            for (const pkg of scopedPackages) {
                const fullPath = basePath ? path.join(scopePath, pkg) : path.join('node_modules', pkg);
                try {
                    packages.push(await import(fullPath));
                } catch (error) {
                    console.error(`无法加载服务 ${pkg} (域 ${scope})：`, error);
                }
            }
        }
    }

    const validPackages: ServiceType[] = [];
    for (const pkg of packages) {
        if (!isServicePackage(pkg)) {
            console.debug('无效的服务，过滤：', pkg);
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
        logger.debug('加载：', file);
        try {
            packages.push(await import(path.resolve(file)));
        } catch (error) {
            console.error(`无法加载插件 ${file}：`, error);
        }

    }
    if (!hasNodeModules(process.cwd())) {
        logger.warn('当前目录下未找到 node_modules');
    }
    else {
        for (const scope of scopes) {
            logger.debug('扫描域：', scope);
            const basePath = scope.startsWith('@') ? scope.split('/')[0] : null;
            const scopePath = basePath ? path.join('node_modules', basePath) : 'node_modules';
            if (!fs.existsSync(scopePath)) continue;
            const scopedPackages = fs.readdirSync(scopePath).filter(name => name.startsWith(basePath ? scope.split('/')[1] : scope));
            logger.debug('发现包：', scopedPackages);
            for (const pkg of scopedPackages) {
                const fullPath = basePath ? path.join(scopePath, pkg) : path.join('node_modules', pkg);
                try {
                    packages.push(await import(fullPath));
                } catch (error) {
                    console.error(`无法加载插件 ${pkg} (域 ${scope})：`, error);
                }
            }
        }
    }

    const validPackages: PluginType[] = [];
    for (const pkg of packages) {
        if (!isPluginPackage(pkg)) {
            console.debug('无效的插件，过滤：', pkg);
        } else {
            validPackages.push(pkg);
        }
    }

    return validPackages;
}