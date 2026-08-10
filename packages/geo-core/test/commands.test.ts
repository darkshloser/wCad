// Copyright (c) 2026 Dobromir. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1
//
// Use of this file is governed by the Business Source License 1.1 found in the
// LICENSE file at the root of this repository. Production use requires a
// commercial license until the Change Date, after which the Change License
// (Apache-2.0) applies.

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { type Command, CommandStack, transaction } from '../src/commands/stack.ts';

type State = Readonly<Record<string, number>>;

const setValue = (key: string, next: number, prev: number | undefined): Command<State> => ({
  name: `set ${key}`,
  apply: (s) => ({ ...s, [key]: next }),
  unapply: (s) => {
    const copy = { ...s };
    if (prev === undefined) delete copy[key];
    else copy[key] = prev;
    return copy;
  },
});

describe('CommandStack', () => {
  it('applies and undoes a single command', () => {
    const stack = new CommandStack<State>({});
    stack.execute(setValue('a', 1, undefined));
    expect(stack.state).toEqual({ a: 1 });
    stack.undo();
    expect(stack.state).toEqual({});
    stack.redo();
    expect(stack.state).toEqual({ a: 1 });
  });

  it('reports undo/redo availability', () => {
    const stack = new CommandStack<State>({});
    expect(stack.canUndo).toBe(false);
    expect(stack.canRedo).toBe(false);
    stack.execute(setValue('a', 1, undefined));
    expect(stack.canUndo).toBe(true);
    stack.undo();
    expect(stack.canRedo).toBe(true);
  });

  it('clears the redo stack once new work is executed', () => {
    const stack = new CommandStack<State>({});
    stack.execute(setValue('a', 1, undefined));
    stack.undo();
    stack.execute(setValue('b', 2, undefined));
    expect(stack.canRedo).toBe(false);
  });

  it('groups a transaction into one undo step', () => {
    const stack = new CommandStack<State>({});
    stack.begin('draw polyline');
    stack.execute(setValue('a', 1, undefined));
    stack.execute(setValue('b', 2, undefined));
    stack.commit();
    expect(stack.state).toEqual({ a: 1, b: 2 });
    expect(stack.history).toEqual(['draw polyline']);
    stack.undo();
    expect(stack.state).toEqual({});
  });

  it('rolls back an open transaction without recording it', () => {
    const stack = new CommandStack<State>({ a: 0 });
    stack.begin('cancelled');
    stack.execute(setValue('a', 5, 0));
    stack.rollback();
    expect(stack.state).toEqual({ a: 0 });
    expect(stack.canUndo).toBe(false);
  });

  it('rejects nested transactions and stray commits', () => {
    const stack = new CommandStack<State>({});
    stack.begin('one');
    expect(() => stack.begin('two')).toThrow(/already open/);
    stack.commit();
    expect(() => stack.commit()).toThrow(/No open transaction/);
    expect(() => stack.rollback()).toThrow(/No open transaction/);
  });

  it('drops an empty transaction rather than creating a no-op undo step', () => {
    const stack = new CommandStack<State>({});
    stack.begin('nothing');
    stack.commit();
    expect(stack.canUndo).toBe(false);
  });

  it('bounds the history length', () => {
    const stack = new CommandStack<State>({}, 3);
    for (let i = 0; i < 10; i++) stack.execute(setValue(`k${i}`, i, undefined));
    expect(stack.history).toHaveLength(3);
  });

  it('composes transactions correctly through the helper', () => {
    const t = transaction('combo', [setValue('a', 1, undefined), setValue('b', 2, undefined)]);
    expect(t.unapply(t.apply({}))).toEqual({});
  });

  // The property that matters: whatever the user did, undoing all of it must restore
  // exactly the state they started from.
  it('undoing an arbitrary command sequence restores the initial state', () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.constantFrom('a', 'b', 'c', 'd'), fc.integer({ min: -100, max: 100 })), {
          minLength: 1,
          maxLength: 60,
        }),
        (ops) => {
          const initial: State = { a: 0, seed: 7 };
          const stack = new CommandStack<State>(initial, 1000);
          for (const [key, value] of ops) {
            stack.execute(setValue(key, value, stack.state[key]));
          }
          expect(stack.undoAll()).toEqual(initial);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('redoing everything after undoing everything reproduces the final state', () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.constantFrom('a', 'b', 'c'), fc.integer({ min: 0, max: 50 })), {
          minLength: 1,
          maxLength: 40,
        }),
        (ops) => {
          const stack = new CommandStack<State>({}, 1000);
          for (const [key, value] of ops) stack.execute(setValue(key, value, stack.state[key]));
          const final = stack.state;
          stack.undoAll();
          while (stack.canRedo) stack.redo();
          expect(stack.state).toEqual(final);
        },
      ),
      { numRuns: 200 },
    );
  });
});
