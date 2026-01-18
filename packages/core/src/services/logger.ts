import log from '@cocotais/logger';
import { LogLevel } from '../types';
import { Context, Service } from '../context';

export class LoggerService extends Service {
    constructor(ctx: Context) {
        super(ctx, 'logger', true);

        ctx.on('internal.log', (name: string, level: string, ...messages: any[]) => {
            this.log(name, level as LogLevel, ...messages);
        })
    }

    log(name: string, level: LogLevel, ...messages: any[]) {
        log(name, level, {
            hasDate: true,
            toConsole: true
        }, ...messages);
    }
}