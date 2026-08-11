import type { App } from './app';
import type { ConfigService } from './services/config';
import type { LoggerService } from './services/logger';
import type { PluginService } from './services/plugin';
import type { StorageService } from './services/storage';

export type LogLevel = 'trace' | 'debug' | 'info' | 'notice' | 'warn' | 'error';
export type LogLevelExtended = LogLevel | 'silent';

export type Constructor<T = any> = {
    new(...args: any[]): T;
    inject?: readonly (keyof ServiceRegistry)[];
};

/**
 * 服务注册表：服务名到服务类型的映射。
 * 服务作者通过 `declare module '@saukkojs/core'` 声明扩展本接口，
 * 使 `Scope.get` / `Context.get` 获得完整的类型推导。
 */
export interface ServiceRegistry {
    logger: LoggerService;
    config: ConfigService;
    app: App;
    plugin: PluginService;
    storage: StorageService;
}

export interface PluginConfigRegistry { }
export interface ServiceConfigRegistry {
    storage: {
        path?: string;
    }
}

export type Config = {
    project: {
        name: string;
    };
    plugin: {
        scopes?: string[];
        files?: string[];
        config: {
            [key in keyof PluginConfigRegistry]?: PluginConfigRegistry[key];
        };
    };
    /**
     * 服务配置节。0.2 起"服务即插件"：服务包经 `plugin.files` / 插件依赖扫描装载，
     * `service.files` / `service.scopes` 已废弃；本节仅保留核心服务的配置（如 storage）。
     */
    service: {
        config: {
            [key in keyof ServiceConfigRegistry]?: ServiceConfigRegistry[key];
        };
    }
}
