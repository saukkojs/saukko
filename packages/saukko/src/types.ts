type SaukkoEnv = {
    SAUKKO_LOG_LEVEL?: 'trace' | 'debug' | 'info' | 'notice' | 'warn' | 'error' | 'silent';
    SAUKKO_CONFIG_PATH?: string;
    SAUKKO_SOCKET_PATH?: string;
}

export type { SaukkoEnv };