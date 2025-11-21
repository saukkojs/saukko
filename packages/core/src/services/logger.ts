declare module '@saukkojs/core' {
    interface ServiceRegistry {
        logger: LoggerService;
    }
}

class LoggerService {
    constructor() {}

    l(name: string, ...messages: any[]) {
        // WIP
    }
}