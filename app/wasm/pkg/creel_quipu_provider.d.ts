/* tslint:disable */
/* eslint-disable */

/**
 * Dispatch one MCP tool call. `args_json` is the tool's `arguments` object;
 * returns the tool's JSON result as a string, or the error message.
 */
export function call_tool(name: string, args_json: string): string;

/**
 * Serialize the current store to `.db` bytes (the interchange format —
 * downloadable, attachable to a native store, openable in the CLI).
 */
export function export_db(): Uint8Array;

/**
 * Install the opfs-sahpool VFS as the process-wide default, so `open(path)`
 * persists across reloads. Call once per worker, before `open`. Optional:
 * without it, stores are memory-backed and die with the tab.
 */
export function install_opfs(): Promise<void>;

/**
 * Open (or create) the store at `path` (OPFS if `install_opfs` ran).
 */
export function open(path: string): void;

/**
 * Open a store from `.db` bytes (a knowledge pack or any quipu store file).
 */
export function open_from_bytes(bytes: Uint8Array): void;

/**
 * Open a fresh in-memory store.
 */
export function open_memory(): void;

/**
 * quipu's MCP tool schemas, verbatim — a JSON array string.
 */
export function tool_definitions(): string;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly call_tool: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly export_db: (a: number) => void;
    readonly install_opfs: () => number;
    readonly open: (a: number, b: number, c: number) => void;
    readonly open_from_bytes: (a: number, b: number, c: number) => void;
    readonly open_memory: (a: number) => void;
    readonly tool_definitions: (a: number) => void;
    readonly ring_core_0_17_14__bn_mul_mont: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly rust_sqlite_wasm_abort: () => void;
    readonly rust_sqlite_wasm_assert_fail: (a: number, b: number, c: number, d: number) => void;
    readonly rust_sqlite_wasm_calloc: (a: number, b: number) => number;
    readonly rust_sqlite_wasm_malloc: (a: number) => number;
    readonly rust_sqlite_wasm_free: (a: number) => void;
    readonly rust_sqlite_wasm_getentropy: (a: number, b: number) => number;
    readonly rust_sqlite_wasm_localtime: (a: number) => number;
    readonly rust_sqlite_wasm_realloc: (a: number, b: number) => number;
    readonly sqlite3_os_end: () => number;
    readonly sqlite3_os_init: () => number;
    readonly __wasm_bindgen_func_elem_2130: (a: number, b: number, c: number, d: number) => void;
    readonly __wasm_bindgen_func_elem_1373: (a: number, b: number, c: number, d: number) => void;
    readonly __wbindgen_export: (a: number, b: number) => number;
    readonly __wbindgen_export2: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_export3: (a: number) => void;
    readonly __wbindgen_export4: (a: number, b: number) => void;
    readonly __wbindgen_add_to_stack_pointer: (a: number) => number;
    readonly __wbindgen_export5: (a: number, b: number, c: number) => void;
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
