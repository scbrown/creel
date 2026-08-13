/* tslint:disable */
/* eslint-disable */

/**
 * Dispatch one MCP tool call. `args_json` is the tool's `arguments` object;
 * returns the tool's JSON result as a string.
 */
export function call_tool(name: string, args_json: string): string;

/**
 * The languages this build can extract.
 */
export function languages(): string;

/**
 * The provider's MCP tool schemas — a JSON array string (the shape
 * quipu-backend.js's provider contract expects from `listTools`).
 */
export function tool_definitions(): string;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly call_tool: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly languages: (a: number) => void;
    readonly tool_definitions: (a: number) => void;
    readonly __assert_fail: (a: number, b: number, c: number, d: number) => void;
    readonly __imported_wasi_snapshot_preview1_fd_close: (a: number) => number;
    readonly __imported_wasi_snapshot_preview1_fd_fdstat_get: (a: number, b: number) => number;
    readonly __imported_wasi_snapshot_preview1_fd_read: (a: number, b: number, c: number, d: number) => number;
    readonly __imported_wasi_snapshot_preview1_fd_seek: (a: number, b: bigint, c: number, d: number) => number;
    readonly abort: () => void;
    readonly clock_gettime: (a: number, b: number) => number;
    readonly __imported_wasi_snapshot_preview1_fd_fdstat_set_flags: (a: number, b: number) => number;
    readonly __imported_wasi_snapshot_preview1_fd_write: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_add_to_stack_pointer: (a: number) => number;
    readonly __wbindgen_export: (a: number, b: number) => number;
    readonly __wbindgen_export2: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_export3: (a: number, b: number, c: number) => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
