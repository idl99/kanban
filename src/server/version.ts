declare const CKANBAN_VERSION: string | undefined;

/** Injected with --define at release build; "dev" when running from source. */
export const VERSION: string = typeof CKANBAN_VERSION === "string" ? CKANBAN_VERSION : "dev";

/** True inside a `bun build --compile` binary (sources live in Bun's virtual filesystem). */
export const IS_BINARY: boolean = import.meta.dir.startsWith("/$bunfs");

export const REPO = "leoawesome/ckanban";
