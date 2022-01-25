import { createHash } from 'crypto';
import fs from 'fs';
import pathlib from 'path';

import * as executor from './executor';
import { createConverter } from './converter';
import { runInTmpAsync, WaitFileEventFunc, createConverterWithFileWatcher, sleep } from './testutil';
import ts from '@tslab/typescript-for-tslab';
import { normalizeJoin } from './tspath';

let ex: executor.Executor;
let waitFileEvent: WaitFileEventFunc;

let consoleLogCalls = [];
let consoleErrorCalls = [];

beforeAll(() => {
  let node = createConverterWithFileWatcher();
  waitFileEvent = node.waitFileEvent;
  let browserConv = createConverter({ isBrowser: true });
  let close = () => {
    node.converter.close();
    browserConv.close();
  };
  let exconsole = {
    log: function (...args) {
      consoleLogCalls.push(args);
    },
    error: function (...args) {
      consoleErrorCalls.push(args);
    },
  };
  const convs = { node: node.converter, browser: browserConv, close };
  ex = executor.createExecutor(process.cwd(), convs, exconsole);
});
afterAll(() => {
  if (ex) {
    ex.close();
  }
});

afterEach(() => {
  ex.reset();
  consoleLogCalls = [];
  consoleErrorCalls = [];
});

describe('execute', () => {
  it('immediate', () => {
    // Show code is executed immediately with execute.
    // See a docstring of execute for details.
    const promise = ex.execute('let x = 10; x + 4;');
    expect(consoleLogCalls).toEqual([[14]]);
  });

  it('calculate numbers', async () => {
    expect(await ex.execute(`let x = 3, y = 4;`)).toBe(true);
    expect(await ex.execute(`let z = x * y; z -= 2;`)).toBe(true);
    expect(await ex.execute(`y = x * z;`)).toBe(true);
    expect(ex.locals).toEqual({ x: 3, y: 30, z: 10 });
    expect(await ex.execute(`x = Math.max(z, y)`));
    expect(ex.locals).toEqual({ x: 30, y: 30, z: 10 });
    expect(consoleLogCalls).toEqual([[10], [30], [30]]);
  });

  it('recursion', async () => {
    let ok = await ex.execute(
      `
      function naiveFib(n: number) {
        if (n > 1) {
          return naiveFib(n - 1) + naiveFib(n - 2);
        }
        return 1;
      }
      let fib20 = naiveFib(20);`
    );
    expect(ok).toBe(true);
    expect(ex.locals.fib20).toEqual(10946);
  });

  it('node globals', async () => {
    let ok = await ex.execute(`let ver = process.version;`);
    expect(ok).toBe(true);
    expect(ex.locals.ver).toEqual(process.version);
  });

  it('redeclare const', async () => {
    expect(await ex.execute(`const x = 3;`)).toBe(true);
    expect(await ex.execute(`const x = 4;`)).toBe(true);
    expect(ex.locals).toEqual({ x: 4 });
  });

  it('class', async () => {
    let ok = await ex.execute(`
    class Person {
      name: string;
      age: number;

      constructor(name: string, age: number) {
        this.name = name;
        this.age = age;
      }

      toString(): string {
        return 'Person(' + this.name + ', ' + this.age + ')';
      }
    }
    let alice = (new Person('alice', 123)).toString();
    `);
    expect(ok).toBe(true);
    expect(ex.locals.alice).toEqual('Person(alice, 123)');
  });

  for (const tc of [
    { name: 'import start', import: 'import * as crypto from "crypto";' },
    { name: 'import default', import: 'import crypto from "crypto";' },
    { name: 'dynamic import', import: 'const crypto = await import("crypto")' },
  ]) {
    // Note: For some reason, dynamic import is way slower than others.
    it(tc.name, async () => {
      let ok = await ex.execute(
        [tc.import, 'const message = "Hello TypeScript!";', 'const hash = crypto.createHash("sha256").update(message).digest("hex");'].join('\n')
      );
      expect(ok).toBe(true);
      const hash = createHash('sha256').update('Hello TypeScript!').digest('hex');
      expect(ex.locals.hash).toEqual(hash);
    });
  }

  it('enum', async () => {
    expect(
      await ex.execute(`
    enum Direction {
      Up = 1,
      Down,
      Left,
      Right,
    }
    `)
    ).toBe(true);
    expect(await ex.execute(`const x = Direction.Down`)).toBe(true);
    expect(await ex.execute(`const y = Direction[2]`)).toBe(true);
    expect(await ex.execute(`let Direction = null;`)).toBe(true);
    expect(ex.locals).toEqual({ x: 2, y: 'Down', Direction: null });
  });

  it('exports defineProperty', async () => {
    // Check defineProperty is hooked and we can redefine properties in tslab.
    expect(
      await ex.execute(
        [
          'Object.defineProperty(exports, "myprop", {value: "p0"});',
          'let prop0 = exports.myprop',
          'Object.defineProperty(exports, "myprop", {value: "p1"});',
          'let prop1 = exports.myprop',
        ].join('\n')
      )
    ).toBe(true);
    expect(ex.locals).toEqual({
      myprop: 'p1',
      prop0: 'p0',
      prop1: 'p1',
    });
  });

  it('syntax error', async () => {
    expect(await ex.execute(`let x + y;`)).toBe(false);
    expect(consoleErrorCalls).toEqual([
      ['%s%d:%d - %s', '', 1, 7, "',' expected."],
      ['%s%d:%d - %s', '', 1, 9, "Cannot find name 'y'."],
    ]);
  });

  it('exception', async () => {
    let ok = await ex.execute(`throw new Error('my error');`);
    expect(ok).toBe(false);
    expect(consoleErrorCalls).toEqual([[new Error('my error')]]);
  });

  it('await promise resolved', async () => {
    let promise = ex.execute(`
    await new Promise(resolve => {
      resolve('Hello Promise');
    });
    `);
    // The promise is not resolved yet.
    expect(consoleLogCalls).toEqual([]);
    expect(consoleErrorCalls).toEqual([]);

    expect(await promise).toBe(true);
    expect(consoleLogCalls).toEqual([['Hello Promise']]);
    expect(consoleErrorCalls).toEqual([]);
  });

  it('await promise rejected', async () => {
    let promise = ex.execute(`
    await new Promise((_, reject) => {
      reject('Good Bye Promise');
    });
    `);
    // The promise is not resolved yet.
    expect(consoleLogCalls).toEqual([]);
    expect(consoleErrorCalls).toEqual([]);

    expect(await promise).toBe(false);
    expect(consoleLogCalls).toEqual([]);
    expect(consoleErrorCalls).toEqual([['Good Bye Promise']]);
  });

  it('await async resolved', async () => {
    let promise = ex.execute(`
    async function fn(msg: string) {
      return 'Hello ' + msg;
    }
    await fn('async');
    `);
    // The promise is not resolved yet.
    expect(consoleLogCalls).toEqual([]);
    expect(consoleErrorCalls).toEqual([]);

    expect(await promise).toBe(true);
    expect(consoleLogCalls).toEqual([['Hello async']]);
    expect(consoleErrorCalls).toEqual([]);
  });

  it('await async rejected', async () => {
    let promise = ex.execute(`
    async function fn(msg: string) {
      throw 'Good Bye async';
    }
    await fn('async');
    `);
    // The promise is not resolved yet.
    expect(consoleLogCalls).toEqual([]);
    expect(consoleErrorCalls).toEqual([]);

    expect(await promise).toBe(false);
    expect(consoleLogCalls).toEqual([]);
    expect(consoleErrorCalls).toEqual([['Good Bye async']]);
  });

  it('assign top-level await', async () => {
    let promise = ex.execute(`
    async function asyncHello() {
      return "Hello, World!";
    }
    let msg = await asyncHello();`);
    expect(consoleLogCalls).toEqual([]);
    expect(consoleErrorCalls).toEqual([]);
    expect(await promise).toBe(true);
    expect(ex.locals.msg).toEqual('Hello, World!');
  });

  it('promise rejected immediately', async () => {
    let promise = ex.execute(`
    new Promise(() => {
      throw new Error('rejected immediately');
    });
    `);
    expect(await promise).toBe(true);
    expect(consoleErrorCalls).toEqual([]);
    expect(consoleLogCalls.length).toEqual(1);
    expect(consoleLogCalls[0].length).toEqual(1);
    // If we don't catch this, another test with Promise fails for some reason.
    // TODO: Investigate what happens internally.
    try {
      await consoleLogCalls[0][0];
      fail('await above must fail.');
    } catch (e) {
      expect(e).toEqual(new Error('rejected immediately'));
    }
  });

  it('import star', async () => {
    expect(
      await ex.execute(`
      import * as crypto from "crypto";
      let h0 = crypto.createHash("sha256").update("Hello TypeScript!").digest("hex");
    `)
    ).toBe(true);
    expect(
      await ex.execute(`
      let h1 = crypto.createHash("sha256").update("Hello TypeScript!").digest("hex");
    `)
    ).toBe(true);
    expect(await ex.execute(`let crypto = 'crypto';`)).toBe(true);
    const hash = createHash('sha256').update('Hello TypeScript!').digest('hex');
    expect(ex.locals).toEqual({ crypto: 'crypto', h0: hash, h1: hash });
  });

  it('import star', async () => {
    expect(
      await ex.execute(`
      import * as crypto from "crypto";
      let h0 = crypto.createHash("sha256").update("Hello TypeScript!").digest("hex");
    `)
    ).toBe(true);
    expect(
      await ex.execute(`
      let h1 = crypto.createHash("sha256").update("Hello TypeScript!").digest("hex");
    `)
    ).toBe(true);
    expect(await ex.execute(`let crypto = 'crypto';`)).toBe(true);
    const hash = createHash('sha256').update('Hello TypeScript!').digest('hex');
    expect(ex.locals).toEqual({ crypto: 'crypto', h0: hash, h1: hash });
  });

  it('import default', async () => {
    expect(
      await ex.execute(`
      import crypto from "crypto";
      let h0 = crypto.createHash("sha256").update("Hello TypeScript!").digest("hex");
    `)
    ).toBe(true);
    expect(
      await ex.execute(`
      let h1 = crypto.createHash("sha256").update("Hello TypeScript!").digest("hex");
    `)
    ).toBe(true);
    expect(await ex.execute(`let crypto = 'crypto';`)).toBe(true);
    const hash = createHash('sha256').update('Hello TypeScript!').digest('hex');
    expect(ex.locals).toEqual({ crypto: 'crypto', h0: hash, h1: hash });
  });

  it('named import', async () => {
    expect(
      await ex.execute(`
      import {createHash} from "crypto";
      let h0 = createHash("sha256").update("Hello TypeScript!").digest("hex");
    `)
    ).toBe(true);
    expect(
      await ex.execute(`
      let h1 = createHash("sha256").update("Hello TypeScript!").digest("hex");
    `)
    ).toBe(true);
    expect(await ex.execute(`let createHash = 'createHash';`)).toBe(true);
    const hash = createHash('sha256').update('Hello TypeScript!').digest('hex');
    expect(ex.locals).toEqual({
      createHash: 'createHash',
      h0: hash,
      h1: hash,
    });
  });

  it('package tslab', async () => {
    expect(
      await ex.execute(`
    import * as tslab from "tslab";
    let png = tslab.display.png;
    `)
    ).toBe(true);
    expect(typeof ex.locals.png).toEqual('function');
  });

  it('performance', async () => {
    function naiveFib(n: number): number {
      if (n > 1) {
        return naiveFib(n - 1) + naiveFib(n - 2);
      }
      return 1;
    }
    let start = Date.now();
    let want = naiveFib(35);
    let end = Date.now();
    let t0 = end - start;

    start = Date.now();
    expect(
      await ex.execute(`
      function naiveFib(n: number): number {
        if (n > 1) {
          return naiveFib(n - 1) + naiveFib(n - 2);
        }
        return 1;
      }
      let got = naiveFib(35);
    `)
    ).toBe(true);
    end = Date.now();
    let t1 = end - start;
    expect(ex.locals.got).toBe(want);
    expect(t1 / t0).toBeGreaterThan(0.5);
    expect(t0 / t1).toBeGreaterThan(0.5);
  });

  it('fixed bug#32', async () => {
    // https://github.com/yunabe/tslab/issues/32 is reproducible.
    expect(await ex.execute(`let b = {}.constructor === Object`)).toBe(true);
    expect(ex.locals.b).toEqual(true);
  });
});

describe('interrupt', () => {
  it('interrupt without execute', () => {
    // Confirm it does not cause any problem like "UnhandledPromiseRejection".
    ex.interrupt();
  });

  it('interrupt', async () => {
    // Confirm it does not cause any problem like "UnhandledPromiseRejection".
    let src = "await new Promise(resolve => setTimeout(() => resolve('done'), 10));";
    let promise = ex.execute(src);
    expect(await promise).toBe(true);
    expect(consoleLogCalls).toEqual([['done']]);
    consoleLogCalls = [];

    promise = ex.execute(src);
    ex.interrupt();
    expect(await promise).toBe(false);
    expect(consoleLogCalls).toEqual([]);
    expect(consoleErrorCalls).toEqual([[new Error('Interrupted asynchronously')]]);
  });
});

describe('modules', () => {
  it('updated', async () => {
    expect(
      await ex.execute(`
/**
 * @module mylib
 */
export const a = 'AAA';`)
    ).toBe(true);
    expect(await ex.execute('import * as mylib from "./mylib";\nconst b = mylib.a + "BBB";')).toBe(true);
    expect(ex.locals.b).toEqual('AAABBB');

    expect(
      await ex.execute(`
/**
 * @module mylib
 */
export let a = 'XXX';`)
    ).toBe(true);
    expect(await ex.execute('import * as mylib from "./mylib";\nconst b = mylib.a + "BBB";')).toBe(true);
    expect(ex.locals.b).toEqual('XXXBBB');

    expect(consoleLogCalls).toEqual([]);
    expect(consoleErrorCalls).toEqual([]);
  });

  it('jsx', async () => {
    expect(await ex.execute(`/** @jsx @module mylib */ let React: any; let x = <div></div>`));
    expect(consoleLogCalls).toEqual([]);
    expect(consoleErrorCalls).toEqual([]);
  });
});

describe('externalFiles', () => {
  it('dependencies', async () => {
    await runInTmpAsync('pkg', async (dir) => {
      fs.writeFileSync(pathlib.join(dir, 'a.ts'), 'export const aVal: string = "AAA";');
      fs.mkdirSync(pathlib.join(dir, 'b'));
      fs.writeFileSync(pathlib.join(dir, 'b/c.ts'), 'import {aVal} from "../a";\nexport const bVal = "BBB" + aVal;');

      let promise = ex.execute([`import {bVal} from "./${dir}/b/c";`].join('\n'));
      expect(await promise).toBe(true);
      expect(consoleLogCalls).toEqual([]);
      expect(consoleErrorCalls).toEqual([]);
      expect(ex.locals).toEqual({ bVal: 'BBBAAA' });
    });
  });

  it('errors', async () => {
    await runInTmpAsync('pkg', async (dir) => {
      fs.writeFileSync(pathlib.join(dir, 'a.ts'), 'export const aVal: number = "AAA";');
      let promise = ex.execute(`import {aVal} from "./${dir}/a";`);
      expect(await promise).toBe(false);
      expect(consoleLogCalls).toEqual([]);
      expect(consoleErrorCalls).toEqual([
        ['%s%d:%d - %s', pathlib.normalize(`${dir}/a.ts `), 1, 14, "Type 'string' is not assignable to type 'number'."],
      ]);
    });
  });

  it('cache module', async () => {
    await runInTmpAsync('pkg', async (dir) => {
      fs.writeFileSync(
        pathlib.join(dir, 'rand.ts'),
        ['import { randomBytes } from "crypto";', 'export const uid = randomBytes(8).toString("hex");'].join('\n')
      );
      let promise = ex.execute(`import {uid} from "./${dir}/rand";`);
      expect(await promise).toBe(true);
      const uid = ex.locals.uid;
      expect(typeof uid).toBe('string');
      promise = ex.execute(`import {uid} from "./${dir}/rand";`);
      expect(await promise).toBe(true);
      const uid2 = ex.locals.uid;
      expect(uid2).toEqual(uid);
    });
  });

  it('changed', async () => {
    await runInTmpAsync('pkg', async (dir) => {
      const srcPath = normalizeJoin(process.cwd(), dir, 'a.ts');
      fs.writeFileSync(srcPath, 'export const aVal = "ABC";');
      let promise = ex.execute(`import {aVal} from "./${dir}/a";`);
      expect(await promise).toBe(true);
      expect(consoleLogCalls).toEqual([]);
      expect(consoleErrorCalls).toEqual([]);
      expect(ex.locals.aVal).toEqual('ABC');

      fs.writeFileSync(srcPath, 'export const aVal = "XYZ";');
      await waitFileEvent(srcPath, ts.FileWatcherEventKind.Changed);
      // yield to TyeScript compiler just for safety.
      await sleep(0);
      promise = ex.execute(`import {aVal} from "./${dir}/a";`);
      expect(await promise).toBe(true);
      expect(consoleLogCalls).toEqual([]);
      expect(consoleErrorCalls).toEqual([]);
      expect(ex.locals.aVal).toEqual('XYZ');
    });
  });
});

describe('browswer', () => {
  it('module', async () => {
    expect(
      await ex.execute(
        `/**  @browser @module mylib */
        const div = document.createElement('div');`
      )
    ).toBe(true);
    expect(consoleLogCalls).toEqual([]);
    expect(consoleErrorCalls).toEqual([]);
  });

  it('complete', async () => {
    const src = `/**  @browser @module mylib */ const div = document.querySe[cur]`;
    const info = ex.complete(src.replace('[cur]', ''), src.indexOf('[cur]'));
    expect(info.candidates).toEqual(['querySelector', 'querySelectorAll']);
  });

  it('inspect', async () => {
    const src = `/**  @browser @module mylib */ const div = document.createElement('div');`;
    const info = ex.inspect(src, src.indexOf('document.'));
    expect(info).toEqual({
      displayParts: [
        { kind: 'keyword', text: 'var' },
        { kind: 'space', text: ' ' },
        { kind: 'localName', text: 'document' },
        { kind: 'punctuation', text: ':' },
        { kind: 'space', text: ' ' },
        { kind: 'localName', text: 'Document' },
      ],
      documentation: [],
      kind: 'var',
      kindModifiers: 'declare',
      tags: undefined,
      textSpan: { length: 8, start: 43 },
    });
  });
});
