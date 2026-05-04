import type { Metadata, Run, Task } from "../types.ts";

export type LifecycleHookName =
  | "beforeRun"
  | "afterRun"
  | "beforeTaskRun"
  | "afterTaskRun"
  | "beforeModelComplete"
  | "afterModelComplete"
  | "beforeMemoryCommit"
  | "afterMemoryCommit"
  | "beforeContextBuild"
  | "afterContextBuild";

export interface LifecycleHookEvent {
  name: LifecycleHookName;
  timestamp: string;
  run?: Run | null;
  task?: Task | null;
  payload: Metadata;
}

export type LifecycleHookHandler = (event: LifecycleHookEvent) => void | Promise<void>;

export class LifecycleHooks {
  private readonly handlers = new Map<LifecycleHookName, Set<LifecycleHookHandler>>();

  on(name: LifecycleHookName, handler: LifecycleHookHandler): () => void {
    const handlers = this.handlers.get(name) || new Set<LifecycleHookHandler>();
    handlers.add(handler);
    this.handlers.set(name, handlers);
    return () => handlers.delete(handler);
  }

  async emit(
    name: LifecycleHookName,
    input: {
      run?: Run | null;
      task?: Task | null;
      payload?: Metadata;
    } = {},
  ): Promise<void> {
    const handlers = this.handlers.get(name);
    if (!handlers?.size) return;
    const event: LifecycleHookEvent = {
      name,
      timestamp: new Date().toISOString(),
      run: input.run ?? null,
      task: input.task ?? null,
      payload: input.payload || {},
    };
    for (const handler of handlers) {
      await handler(event);
    }
  }
}
