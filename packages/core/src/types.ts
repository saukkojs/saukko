export type LogLevel = 'trace' | 'debug' | 'info' | 'notice' | 'warn' | 'error';
export type LogLevelExtended = LogLevel | 'silent';

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
    service: {
        scopes?: string[];
        files?: string[];
        config: {
            [key in keyof ServiceConfigRegistry]?: ServiceConfigRegistry[key];
        };
    }
}