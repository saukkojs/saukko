import type { Container } from './container';
import type { LoggerService } from './services/logger';
import type { PluginService } from './services/plugin';
import { pluginDependencyDiagnose } from './utils';

export class App {
    static inject = ['logger', 'container', 'plugin'] as const;

    constructor(private logger: LoggerService, private container: Container, private plugin: PluginService) {}

    async start() {
        this.logger.log('app', 'info', 'Starting app...');
        const data = pluginDependencyDiagnose(this.plugin, this.container);
        if (data.issues.length > 0) {
            this.logger.log('app', 'warn', 'Plugin dependency issues detected, and they are skipped to load:');
            for (const issue of data.issues) {
                if (issue.type === 'missing-dependency') {
                    this.logger.log('app', 'warn', `- Plugin ${issue.plugin} is missing dependencies: ${issue.details.join(', ')}`);
                } else if (issue.type === 'circular-dependency') {
                    this.logger.log('app', 'warn', `- Plugin ${issue.plugin} has circular dependencies: ${issue.details.join(' -> ')}`);
                }
            }
        }
        for (const pluginName of data.order) {
            await this.plugin.apply(pluginName);
        }
        this.logger.log('app', 'info', `App started, ${data.order.length} plugins applied.`);
    }

    async stop() {
        this.logger.log('app', 'info', 'Stopping app...');
        const plugins = this.plugin.map();
        for (const [name, plugin] of plugins) {
            if (plugin.enabled) {
                this.plugin.dispose(name);
            }
        }
        this.logger.log('app', 'info', 'App stopped.');
    }
}