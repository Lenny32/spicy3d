// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

export type LoggerLevel = "debug" | "info" | "warn" | "error";

const LEVEL_PRIORITY: Record<LoggerLevel, number> = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3,
};

/** Told about every warning and error logged, whatever `Logger.level` (the optional telemetry). */
export type LoggerListener = (level: "warn" | "error", message: unknown, params: readonly unknown[]) => void;

export class Logger {
    static level: LoggerLevel = "info";
    private static readonly listeners = new Set<LoggerListener>();
    private static notifying = false;

    /** Returns the unsubscriber. A listener that logs itself is not called again for that. */
    static addListener(listener: LoggerListener): () => void {
        Logger.listeners.add(listener);
        return () => Logger.listeners.delete(listener);
    }

    private static notify(level: "warn" | "error", message: unknown, params: readonly unknown[]) {
        if (Logger.listeners.size === 0 || Logger.notifying) return;
        Logger.notifying = true;
        try {
            for (const listener of [...Logger.listeners]) {
                try {
                    listener(level, message, params);
                } catch {
                    // A listener never breaks logging.
                }
            }
        } finally {
            Logger.notifying = false;
        }
    }

    static isEnabled(level: LoggerLevel): boolean {
        return LEVEL_PRIORITY[Logger.level] <= LEVEL_PRIORITY[level];
    }

    static debug(message?: any, ...optionalParams: any[]) {
        if (Logger.isEnabled("debug")) {
            console.debug(message, ...optionalParams);
        }
    }

    static info(message?: any, ...optionalParams: any[]) {
        if (Logger.isEnabled("info")) {
            console.log(message, ...optionalParams);
        }
    }

    static warn(message?: any, ...optionalParams: any[]) {
        if (Logger.isEnabled("warn")) {
            console.warn(message, ...optionalParams);
        }
        Logger.notify("warn", message, optionalParams);
    }

    static error(message?: any, ...optionalParams: any[]) {
        if (Logger.isEnabled("error")) {
            console.error(message, ...optionalParams);
        }
        Logger.notify("error", message, optionalParams);
    }
}

// facilitate debugging (warnings and errors keep going through the listeners)
if (!__IS_PRODUCTION__) {
    Logger.debug = console.debug;
    Logger.info = console.log;
}
