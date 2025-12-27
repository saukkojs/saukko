type SaukkoEnv = {
    SAUKKO_LOG_LEVEL?: 'trace' | 'debug' | 'info' | 'notice' | 'warn' | 'error' | 'silent';
    SAUKKO_CONFIG_PATH?: string;
    SAUKKO_SOCKET_PATH?: string;
}

type DaemonMessage = {
    action: 'stop' | 'command';
    args?: string[];
};

type DaemonResponse = {
    ok: boolean;
    message?: string;
};

export type { SaukkoEnv, DaemonMessage, DaemonResponse };