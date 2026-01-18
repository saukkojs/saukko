import log, { LogType } from '@cocotais/logger';
import { Context, Service } from '../context';

export class LoggerService extends Service {
    constructor(ctx: Context) {
        super(ctx, 'logger', true);

        ctx.on('internal.log', (name: string, level: LogType, ...messages: any[]) => {
            this.log(name, level, ...messages);
        })
    }

    log(name: string, level: LogType, ...messages: any[]) {
        log(name, level, {
            hasDate: true,
            toConsole: true
        }, ...messages);
    }
}