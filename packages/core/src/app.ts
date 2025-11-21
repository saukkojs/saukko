import type { LoggerService } from './services/logger';

export class App {
    static inject = ['logger'] as const;

    constructor(private logger: LoggerService) {}

    async start() {
        this.logger.log('info', 'app', 'Starting app...');
    }

    async stop() {
        this.logger.log('info', 'app', 'Stopping app...');
    }
}