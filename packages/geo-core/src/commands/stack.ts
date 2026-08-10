// Copyright (c) 2026 Dobromir. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1
//
// Use of this file is governed by the Business Source License 1.1 found in the
// LICENSE file at the root of this repository. Production use requires a
// commercial license until the Change Date, after which the Change License
// (Apache-2.0) applies.

/**
 * Client-side undo/redo (architecture doc section 6.3).
 *
 * Undo is a local command stack, never a server round trip. The server-side history log is a
 * different thing with a different lifetime (audit and recovery).
 *
 * State is treated immutably so that "undo everything returns the original state" is a testable
 * property rather than a hope.
 */

export interface Command<S> {
  readonly name: string;
  apply(state: S): S;
  unapply(state: S): S;
}

/** Groups several commands so one user action is one undo step. */
export function transaction<S>(name: string, commands: ReadonlyArray<Command<S>>): Command<S> {
  return {
    name,
    apply: (state) => commands.reduce((s, c) => c.apply(s), state),
    unapply: (state) => [...commands].reverse().reduce((s, c) => c.unapply(s), state),
  };
}

export class CommandStack<S> {
  #state: S;
  readonly #done: Array<Command<S>> = [];
  readonly #undone: Array<Command<S>> = [];
  #pending: Array<Command<S>> | null = null;
  #pendingName = '';
  readonly #limit: number;

  constructor(initial: S, limit = 500) {
    this.#state = initial;
    this.#limit = limit;
  }

  get state(): S {
    return this.#state;
  }

  get canUndo(): boolean {
    return this.#done.length > 0;
  }

  get canRedo(): boolean {
    return this.#undone.length > 0;
  }

  /** Names of the undo stack, oldest first — useful for a history panel. */
  get history(): readonly string[] {
    return this.#done.map((c) => c.name);
  }

  execute(command: Command<S>): S {
    this.#state = command.apply(this.#state);
    if (this.#pending) {
      this.#pending.push(command);
    } else {
      this.#done.push(command);
      if (this.#done.length > this.#limit) this.#done.shift();
      this.#undone.length = 0;
    }
    return this.#state;
  }

  begin(name: string): void {
    if (this.#pending) throw new Error('A transaction is already open');
    this.#pending = [];
    this.#pendingName = name;
  }

  commit(): void {
    if (!this.#pending) throw new Error('No open transaction');
    const commands = this.#pending;
    this.#pending = null;
    if (commands.length > 0) {
      this.#done.push(transaction(this.#pendingName, commands));
      if (this.#done.length > this.#limit) this.#done.shift();
      this.#undone.length = 0;
    }
  }

  /** Rolls back an open transaction without placing it on the undo stack. */
  rollback(): S {
    if (!this.#pending) throw new Error('No open transaction');
    const commands = this.#pending;
    this.#pending = null;
    for (const c of [...commands].reverse()) this.#state = c.unapply(this.#state);
    return this.#state;
  }

  undo(): S {
    const c = this.#done.pop();
    if (!c) return this.#state;
    this.#state = c.unapply(this.#state);
    this.#undone.push(c);
    return this.#state;
  }

  redo(): S {
    const c = this.#undone.pop();
    if (!c) return this.#state;
    this.#state = c.apply(this.#state);
    this.#done.push(c);
    return this.#state;
  }

  undoAll(): S {
    while (this.canUndo) this.undo();
    return this.#state;
  }
}
