export type LogLevel = 'trace' | 'debug' | 'info' | 'notice' | 'warn' | 'error';
export type LogLevelExtended = LogLevel | 'silent';

export interface PluginConfigRegistry { }
export interface ServiceConfigRegistry { }

export type Config = {
    project: {
        name: string;
    };
    plugin: {
        scopes?: string[];
        directories?: string[];
        files?: string[];
        config?: {
            [key in keyof PluginConfigRegistry]?: PluginConfigRegistry[key];
        };
    };
    service: {
        scopes?: string[];
        directories?: string[];
        files?: string[];
        config?: {
            [key in keyof ServiceConfigRegistry]?: ServiceConfigRegistry[key];
        };
    }
}