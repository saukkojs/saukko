declare module '../container' {
    interface ServiceRegistry {
        logger: LoggerService;
    }
}

export class LoggerService {
    constructor() {}

    log(level: 'trace' | 'debug' | 'info' | 'notice' | 'warn' | 'error', name: string, ...messages: any[]) {
        // WIP
    }
}