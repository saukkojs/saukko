import log from '@cocotais/logger';

const env = process.env;
declare module '../container' {
    interface ServiceRegistry {
        logger: LoggerService;
    }
}

export class LoggerService {
    constructor() {}

    log(name: string, level: 'trace' | 'debug' | 'info' | 'notice' | 'warn' | 'error', ...messages: any[]) {
        log(name, level, {
            hasDate: true,
            toConsole: true,
            toFile: 'logs/saukko.log',
            loglevel: env.SAUKKO_LOG_LEVEL as 'trace' | 'debug' | 'info' | 'notice' | 'warn' | 'error' | 'silent'
        }, ...messages);
    }
}