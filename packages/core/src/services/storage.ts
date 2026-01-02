import fs from "fs";
import { ConfigService } from "./config";
import { LoggerService } from "./logger";
import path from "path";

type Config = {
    path: string;
}

class Storage {
    private data: Map<string, any> = new Map();
    public autoSave: boolean = true;
    public deleted: boolean = false;

    constructor(
        public name: string,
        public filePath: string
    ){
        if (!fs.existsSync(this.filePath)) {
            fs.writeFileSync(this.filePath, JSON.stringify({}), 'utf-8');
        }

        this.load();
    }

    get length() {
        return this.data.size;
    }

    clear() {
        this.data.clear();
        this.autoSave && this.save();
    }

    getItem<T = any>(key: string): T | null {
        if (!this.data.has(key)) {
            return null;
        }
        return this.data.get(key) as T;
    }

    setItem(key: string, value: any) {
        this.data.set(key, value);
        this.autoSave && this.save();
    }

    removeItem(key: string) {
        this.data.delete(key);
        this.autoSave && this.save();
    }

    key(index: number): string | null {
        const keys = Array.from(this.data.keys());
        return keys[index] || null;
    }

    save() {
        if (this.deleted) return;
        fs.writeFileSync(this.filePath, JSON.stringify(Object.fromEntries(this.data)), 'utf-8');
    }

    load() {
        const content = fs.readFileSync(this.filePath, 'utf-8');
        const obj = JSON.parse(content);
        this.data = new Map(Object.entries(obj));
    }
}

export class StorageService {
    static inject = ['logger', 'config'] as const;
    private storages: Map<string, Storage> = new Map();
    private config: Config;

    constructor(
        private logger: LoggerService,
        config: ConfigService
    ) {
        const storageConfig = config.get('service.config.storage');
        this.config = {
            path: storageConfig?.path ?? './.storage',
        };

        if (!fs.existsSync(this.config.path)) {
            fs.mkdirSync(this.config.path, { recursive: true });
        }

        if (!fs.statSync(this.config.path).isDirectory()) {
            this.logger.log('storage', 'error', `存储路径 "${this.config.path}" 不是一个目录`);
            const randomDir = `${this.config.path}-${Date.now()}`;
            this.logger.log('storage', 'error', `将尝试使用临时目录 "${randomDir}" 作为存储路径`);
            fs.mkdirSync(randomDir, { recursive: true });
            this.config.path = randomDir;
        }

        fs.readdirSync(this.config.path).forEach(file => {
            if (file.endsWith('.json')) {
                const name = path.basename(file, '.json');
                this.storages.set(name, new Storage(name, path.join(this.config.path, file)));
                logger.log('storage', 'info', `加载 Storage "${file}"`);
            }
        })
    }

    init(name: string, data?: Record<string, any>) {
        if (this.storages.has(name)) {
            return this.storages.get(name)!;
        }
        const storage = new Storage(name, path.join(this.config.path, `${name}.json`));
        this.storages.set(name, storage);
        storage.autoSave = false;
        if (data) {
            for (const [key, value] of Object.entries(data)) {
                storage.setItem(key, value);
            }
        }
        storage.save();
        storage.autoSave = true;
        return storage;
    }

    get(name: string) {
        if (!this.storages.has(name)) {
            this.logger.log('storage', 'error', `"${name}" 不存在`);
            return;
        }
        return this.storages.get(name);
    }

    has(name: string) {
        return this.storages.has(name);
    }

    delete(name: string) {
        if (!this.storages.has(name)) {
            this.logger.log('storage', 'error', `"${name}" 不存在`);
            return false;
        }
        this.storages.get(name)!.deleted = true;
        if (this.storages.get(name)!.filePath && fs.existsSync(this.storages.get(name)!.filePath)) {
            fs.unlinkSync(this.storages.get(name)!.filePath);
        }
        this.storages.delete(name);
        this.logger.log('storage', 'info', `成功删除 Storage "${name}"`);
        return true;
    }

}