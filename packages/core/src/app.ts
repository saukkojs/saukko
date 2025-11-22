import type { LoggerService } from './services/logger';

export class App {
    static inject = ['logger'] as const;

    constructor(private logger: LoggerService) {}

    async start() {
        this.logger.log('app', 'info', 'Starting app...');
    }

    async stop() {
        this.logger.log('app', 'info', 'Stopping app...');
    }
}