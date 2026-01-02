import { LoggerService } from './logger';
import { type Config } from '../types';

type KeyFinder<T, Prev extends string = ''> = {
    [K in keyof T & string]: NonNullable<T[K]> extends object
        ? NonNullable<T[K]> extends Array<any> | Function
            ? `${Prev}${K}`
            : `${Prev}${K}` | KeyFinder<NonNullable<T[K]>, `${Prev}${K}.`>
        : `${Prev}${K}`
}[keyof T & string];

type TypeFinder<T extends string, C> = T extends `${infer First}.${infer Rest}`
    ? First extends keyof C
        ? C[First] extends infer V
            ? undefined extends V
                ? TypeFinder<Rest, NonNullable<V>> | undefined
                : TypeFinder<Rest, V>
            : never
        : never
    : T extends keyof C
        ? C[T]
        : never;

export class ConfigService {
    static inject = ['logger'] as const;

    private config: Config | undefined;
    constructor(private logger: LoggerService) {}

    getConfig() {
        if (!this.config) {
            this.logger.log('config', 'error', 'Trying to call getConfig() before config is set.');
            return undefined;
        }
        return this.config;
    }

    setConfig(config: Config) {
        if (this.config) {
            this.logger.log('config', 'warn', 'Calling setConfig() will override the current config.');
        }
        this.config = config;
    }

    get<T extends KeyFinder<Config>>(item: T){
        const tree = item.split('.')

        if (!this.config) {
            this.logger.log('config', 'error', 'Trying to call get() before config is set.');
            return;
        }

        let config: any = this.config
        for (const key of tree) {
            if (!(key in config)) {
                this.logger.log('config', 'error', `Unknown config item: ${key} (in ${item})`)
                return undefined;
            }
            config = config[key]
        }
        return config as TypeFinder<T, Config>
    }
}