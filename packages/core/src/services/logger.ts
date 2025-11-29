import log from '@cocotais/logger';
import { LogLevel } from '../types';
import { ConfigService } from './config';

export class LoggerService {
    static inject = ['config'];
    constructor(private config: ConfigService) {}

    log(name: string, level: LogLevel, ...messages: any[]) {
        log(name, level, {
            hasDate: true,
            toConsole: true,
            toFile: this.config.get('log.logdir'),
            loglevel: this.config.get('log.loglevel')
        }, ...messages);
    }
}