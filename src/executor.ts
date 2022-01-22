import path from 'path';
import vm from 'vm';
import Module from 'module';
import * as ts from '@tslab/typescript-for-tslab';
import { getCodeMetadata } from './metadata';
import { Converter, CompletionInfo, SideOutput, Diagnostic } from './converter';
import { normalizeJoin } from './tspath';

export interface ConverterSet {
  /** The converter for Node.js code */
  node: Converter;
  /** The converter for browser code */
  browser: Converter;
  close: () => void;
}

export interface Executor {
  /**
   * Transpiles and executes `src`.
   *
   * Note: Although this method returns a promise, `src` is executed immdiately
   * when this code is executed.
   * @param src source code to be executed.
   * @returns Whether `src` was executed successfully.
   */
  execute(src: string): Promise<boolean>;
  inspect(src: string, position: number): ts.QuickInfo;
  complete(src: string, positin: number): CompletionInfo;
  reset(): void;

  /**
   * Interrupts non-blocking code execution. This method is called from SIGINT signal handler.
   * Note that blocking code execution is terminated by SIGINT separately because it is impossible
   * to call `interrupt` while `execute` is blocked.
   */
  interrupt(): void;

  /** locals exposes tslab local variables for unit tests. */
  locals: { [key: string]: any };

  /** Release internal resources to terminate the process gracefully. */
  close(): void;
}

export interface ConsoleInterface {
  log(message?: any, ...optionalParams: any[]): void;
  error(message?: any, ...optionalParams: any[]): void;
}

/**
 * createRequire creates `require` which resolves modules from `rootDir`.
 */
export function createRequire(rootDir: string): NodeJS.Require {
  // createRequire is added in Node v12. createRequireFromPath is deprecated.
  const create = Module.createRequire || Module.createRequireFromPath;
  return create(normalizeJoin(rootDir, 'src.js'));
}

/**
 * Wrap `require` to hook import of tslab and imports from sideOutputs.
 */
function wrapRequire(
  req: NodeJS.Require,
  dirname: string,
  sideOutputs: Map<string, string>,
  sideModules: Map<string, NodeModule>
): NodeJS.Require {
  function requireFromSideOutputs(id: string): any {
    let filename = normalizeJoin(dirname, id);
    if (path.extname(filename) === '') {
      filename += '.js';
    }
    const cached = sideModules.get(filename);
    if (cached) {
      return cached.exports;
    }
    if (!sideOutputs.has(filename)) {
      return null;
    }
    const mod = new Module(filename, module);
    // Emulate load of Module:
    // https://github.com/nodejs/node/blob/118b28abed73f82f0d6aab33031edfc78934d90f/lib/internal/modules/cjs/loader.js#L1033
    mod.filename = filename;
    mod.paths = Module['_nodeModulePaths'](path.dirname(filename));
    // Wrap require to hook tslab and imports from sideOutputs.
    mod.require = wrapRequire(mod.require, path.dirname(filename), sideOutputs, sideModules);
    (mod as any)._compile(sideOutputs.get(filename), filename);
    sideModules.set(filename, mod);
    return mod.exports;
  }

  return new Proxy<NodeJS.Require>(req, {
    // TODO: Test this behavior.
    apply: (_target: object, thisArg: any, argArray?: any): any => {
      if (argArray.length !== 1) {
        return req.apply(thisArg, argArray);
      }
      const arg = argArray[0];
      if (arg === 'tslab') {
        // Hook require('tslab').
        return require('..');
      }
      const mod = requireFromSideOutputs(arg);
      if (mod) {
        return mod;
      }
      return req.apply(thisArg, argArray);
    },
  });
}

export function createExecutor(rootDir: string, convs: ConverterSet, console: ConsoleInterface): Executor {
  const sideOutputs = new Map<string, string>();
  const sideModules = new Map<string, NodeModule>();
  function updateSideOutputs(outs: SideOutput[]): void {
    for (const out of outs) {
      if (sideModules.has(out.path)) {
        sideModules.delete(out.path);
      }
      sideOutputs.set(out.path, out.data);
    }
  }

  const exports = createExports();
  const req = wrapRequire(createRequire(rootDir), rootDir, sideOutputs, sideModules);
  // Set __tslab__ to pass `exports` and `require` to the code.
  // We need to wrapthe code with runInThisContext rather than
  // setting __tslab__ to globalThis directory because jest
  // hooks accesses to global variables.
  vm.runInThisContext('(x) => {globalThis.__tslab__ = x; }')({
    exports,
    require: req,
  });

  let prevDecl = '';
  let interrupted = new Error('Interrupted asynchronously');
  let rejectInterruptPromise: (reason?: any) => void;
  let interruptPromise: Promise<void>;
  function resetInterruptPromise(): void {
    interruptPromise = new Promise((_, reject) => {
      rejectInterruptPromise = reject;
    });
    // Suppress "UnhandledPromiseRejectionWarning".
    interruptPromise.catch(() => {});
  }
  resetInterruptPromise();

  function interrupt(): void {
    rejectInterruptPromise(interrupted);
    resetInterruptPromise();
  }

  function createExports() {
    const exports = {};
    return new Proxy(exports, {
      // We need to handle defineProperty as set because TypeScript converts
      // named imports to defineProperty but we want to named imported symbols rewritable.
      defineProperty: (_target, prop, attrs) => {
        if (prop === '__esModule') {
          return true;
        }
        if (attrs.get) {
          exports[prop as any] = attrs.get();
        } else {
          exports[prop as any] = attrs.value;
        }
        return true;
      },
    });
  }

  function printDiagnostics(diagnostics: Diagnostic[]) {
    for (const diag of diagnostics) {
      console.error('%s%d:%d - %s', diag.fileName ? diag.fileName + ' ' : '', diag.start.line + 1, diag.start.character + 1, diag.messageText);
    }
  }

  async function execute(src: string): Promise<boolean> {
    const meta = getCodeMetadata(src);
    if (meta.module) {
      const conv = meta.mode === 'browser' ? convs.browser : convs.node;
      printDiagnostics(conv.addModule(meta.module, src, meta));
      // Always returns true because modules are registered regardless of errors in src.
      return true;
    }
    if (meta.mode === 'browser') {
      // TODO: Bundle and display browser JS
      return true;
    }
    const converted = convs.node.convert(prevDecl, src);
    if (converted.sideOutputs) {
      updateSideOutputs(converted.sideOutputs);
    }
    if (converted.diagnostics.length > 0) {
      printDiagnostics(converted.diagnostics);
      return false;
    }
    if (!converted.output) {
      prevDecl = converted.declOutput || '';
      return true;
    }
    let promise: Promise<any> = null;
    try {
      // Wrap code with (function(){...}) to improve the performance (#11)
      // Also, it's necessary to redeclare let and const in tslab.
      const prefix = converted.hasToplevelAwait ? '(async function(exports, require) { ' : '(function(exports, require) { ';
      const wrapped = prefix + converted.output + '\n})(__tslab__.exports, __tslab__.require)';
      const ret = vm.runInThisContext(wrapped, {
        breakOnSigint: true,
      });
      if (converted.hasToplevelAwait) {
        promise = ret;
      }
    } catch (e) {
      console.error(e);
      return false;
    }
    if (promise) {
      try {
        await Promise.race([promise, interruptPromise]);
      } catch (e) {
        console.error(e);
        return false;
      }
    }
    prevDecl = converted.declOutput || '';
    if (converted.lastExpressionVar && exports[converted.lastExpressionVar] != null) {
      let ret: any = exports[converted.lastExpressionVar];
      delete exports[converted.lastExpressionVar];
      console.log(ret);
    }
    return true;
  }

  function inspect(src: string, position: number): ts.QuickInfo {
    const conv = getCodeMetadata(src).mode === 'browser' ? convs.browser : convs.node;
    return conv.inspect(prevDecl, src, position);
  }

  function complete(src: string, position: number): CompletionInfo {
    const conv = getCodeMetadata(src).mode === 'browser' ? convs.browser : convs.node;
    return conv.complete(prevDecl, src, position);
  }

  function reset(): void {
    prevDecl = '';
    for (const name of Object.getOwnPropertyNames(exports)) {
      delete exports[name];
    }
  }

  function close(): void {
    convs.close();
  }

  return {
    execute,
    inspect,
    complete,
    locals: exports,
    reset,
    interrupt,
    close,
  };
}
