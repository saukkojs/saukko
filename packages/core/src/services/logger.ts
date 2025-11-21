declare module '../container' {
    interface ServiceRegistry {
        logger: LoggerService;
    }
}

export class LoggerService {
    constructor() {}

    l(name: string, ...messages: any[]) {
        // WIP
    }
}